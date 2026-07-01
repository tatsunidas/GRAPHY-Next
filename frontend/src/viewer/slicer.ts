/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slicer コア（P2）。任意断面リスライスの **ビューポート/プレビュー配線**（Cornerstone グルー）。
 * 設計: `fw/slicer-design.md` §3・§6。
 *
 * 二層構成:
 * - **プレビュー（本モジュール）**: base=AXIAL VolumeViewport ＋ recon=ORTHOGRAPHIC VolumeViewport。
 *   ベース断面上の「カットライン」から斜め断面を求め、recon カメラを向ける。Slab は cornerstone の
 *   `setSlabThickness` ＋ `setBlendMode`（MIP/MinIP/AVERAGE）で WYSIWYG プレビュー。
 * - **確定生成（`reslice.ts`）**: プレビューと同じ幾何を `buildReslicePlane`/`reslice` に渡して
 *   確定的な HU スタックを生成（P3）。ここでは幾何（center/normal/rowDir/up）を返して橋渡しする。
 *
 * ボリューム構築は MPR と共通（`buildMprVolume`＝CT チルト補正時 `createLocalVolume`／他 streaming）。
 */
import {
  Enums,
  utilities as csUtilities,
  type Types,
  type RenderingEngine,
} from "@cornerstonejs/core";
import {
  ToolGroupManager,
  SynchronizerManager,
  StackScrollTool,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { buildMprVolume, type BuildVolumeResult } from "./mpr";
import { getOrCreateVoiSync } from "./sync";
import type { ReconMode, ResliceVolume, Vec3 } from "./reslice";

export { buildMprVolume };
export type { BuildVolumeResult };

const { ViewportType, OrientationAxis, BlendModes } = Enums;
const { MouseBindings } = csToolsEnums;

/** Slicer の VOI(W/L) 同期 ID。base/recon は同一ボリュームなので絶対値同期でよい。 */
export const SLICER_VOI_SYNC_ID = "graphy-slicer-voi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

export interface SlicerViewportIds {
  base: string;
  recon: string;
}

export interface SlicerElements {
  base: HTMLDivElement;
  recon: HTMLDivElement;
}

/** カットラインから導出した断面幾何（world, LPS）。`reslice.ts` へ橋渡しする。 */
export interface ResliceGeometry {
  /** 断面中心（world, mm）。 */
  center: Vec3;
  /** 断面法線（world, 正規化）。recon の viewPlaneNormal。 */
  normal: Vec3;
  /** 出力の行方向（列インデックス増加＝カットライン方向, 正規化）。 */
  rowDir: Vec3;
  /** 面内 up（recon の viewUp＝ベース断面法線, 正規化）。colDir はこの反対（行は下方向）。 */
  up: Vec3;
}

// ── ベクトル小道具 ────────────────────────────────────────────
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]) || 1;
const normalize = (a: Vec3): Vec3 => {
  const n = norm(a);
  return [a[0] / n, a[1] / n, a[2] / n];
};
const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** 再構成モード → cornerstone BlendMode（プレビュー用）。MEDIAN/MODE は AVERAGE で近似。 */
export function blendModeFor(mode: ReconMode): number {
  switch (mode) {
    case "MAX":
      return BlendModes.MAXIMUM_INTENSITY_BLEND;
    case "MIN":
      return BlendModes.MINIMUM_INTENSITY_BLEND;
    case "MEAN":
    case "MEDIAN": // cornerstone に無いので AVERAGE 近似（UI で明示）
    case "MODE":
      return BlendModes.AVERAGE_INTENSITY_BLEND;
    case "SLICECUT":
    default:
      return BlendModes.COMPOSITE;
  }
}

/** MEDIAN/MODE はプレビューが AVERAGE 近似になる（確定生成は厳密）。 */
export function isPreviewApprox(mode: ReconMode): boolean {
  return mode === "MEDIAN" || mode === "MODE";
}

/**
 * base（AXIAL）＋ recon（ORTHOGRAPHIC）の 2 ビューポートを有効化し、ボリュームを設定、
 * ツール（W/L・Pan・Zoom・スライス送り）を配線する。カットライン操作は SVG オーバーレイ（画面側）で行い、
 * `setReslicePreview` で recon カメラを更新する。
 */
export async function setupSlicerViewports(
  engine: RenderingEngine,
  engineId: string,
  els: SlicerElements,
  ids: SlicerViewportIds,
  volumeId: string,
  toolGroupId: string,
): Promise<void> {
  engine.setViewports([
    {
      viewportId: ids.base,
      type: ViewportType.ORTHOGRAPHIC,
      element: els.base,
      defaultOptions: { orientation: OrientationAxis.AXIAL, background: [0, 0, 0] as Types.Point3 },
    },
    {
      viewportId: ids.recon,
      type: ViewportType.ORTHOGRAPHIC,
      element: els.recon,
      // 初期は SAGITTAL。setReslicePreview で任意法線へ向ける。
      defaultOptions: { orientation: OrientationAxis.SAGITTAL, background: [0, 0, 0] as Types.Point3 },
    },
  ]);

  const viewportIds = [ids.base, ids.recon];
  await Promise.all(
    viewportIds.map(async (id) => {
      const vp = engine.getViewport(id) as Types.IVolumeViewport;
      await vp.setVolumes([{ volumeId }]);
    }),
  );

  let tg = ToolGroupManager.getToolGroup(toolGroupId);
  if (tg) ToolGroupManager.destroyToolGroup(toolGroupId);
  tg = ToolGroupManager.createToolGroup(toolGroupId);
  if (!tg) return;

  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(StackScrollTool.toolName);
  for (const id of viewportIds) tg.addViewport(id, engineId);

  // 右=W/L、中=Pan、ホイール=スライス送り。左ドラッグはカットライン操作（オーバーレイが処理）。
  tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary, modifierKey: csToolsEnums.KeyboardBindings.Ctrl }] });
  tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });

  const voiSync = getOrCreateVoiSync(SLICER_VOI_SYNC_ID);
  for (const id of viewportIds) voiSync.add({ renderingEngineId: engineId, viewportId: id });

  engine.renderViewports(viewportIds);
}

/**
 * ベース断面上のカットライン（canvas 座標の 2 端点）から斜め断面を求め、recon ビューポートを向ける。
 * カットライン方向・ベース断面法線から plane を構成する（canvasToWorld を使うので base の
 * zoom/pan/回転・現在スライス位置を含む実 world 位置になる）。
 *
 * @returns 求めた断面幾何（`reslice.ts` の `buildReslicePlane` にそのまま渡せる）。失敗時 null。
 */
export function setReslicePreview(
  engine: RenderingEngine,
  ids: SlicerViewportIds,
  line: { x0: number; y0: number; x1: number; y1: number },
  slab: { numSlices: number; thickness: number; gap: number; mode: ReconMode },
): ResliceGeometry | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const base = engine.getViewport(ids.base) as any;
    const p0 = base.canvasToWorld([line.x0, line.y0]) as Vec3;
    const p1 = base.canvasToWorld([line.x1, line.y1]) as Vec3;
    const lineDir = normalize(sub(p1, p0));
    const cam = base.getCamera() as AnyObj;
    const axialNormal = normalize(cam.viewPlaneNormal as Vec3);
    // recon 断面法線 = カットライン方向 × ベース断面法線（＝カットラインに垂直かつベース面内）。
    const normal = normalize(cross(lineDir, axialNormal));
    const center = mid(p0, p1);
    // recon 面: viewUp = ベース断面法線（頭側 up）、rowDir = lineDir。
    const up = axialNormal;

    const recon = engine.getViewport(ids.recon) as Types.IVolumeViewport;
    recon.setCamera({ focalPoint: center as Types.Point3, viewPlaneNormal: normal as Types.Point3, viewUp: up as Types.Point3 });

    // Slab プレビュー: スラブ全深 = thickness*n + gap*(n-1)。
    const slabDepth = slab.thickness * slab.numSlices + slab.gap * Math.max(0, slab.numSlices - 1);
    recon.setBlendMode(blendModeFor(slab.mode));
    if (slab.mode === "SLICECUT" || slabDepth <= 0) {
      recon.resetSlabThickness();
    } else {
      recon.setSlabThickness(slabDepth);
    }
    recon.render();

    return { center, normal, rowDir: lineDir, up };
  } catch {
    return null;
  }
}

/**
 * VolumeViewport から `reslice.ts` 用の `ResliceVolume`（world 幾何）を抽出する（P3 確定生成で使用）。
 * cornerstone の `getImageData().direction` は [rowCos, colCos, normal] の行優先 9 要素で、
 * `reslice.ts` の direction 規約と一致する。airValue は CT 空気の -1000（他は 0）。
 */
export function extractResliceVolume(
  engine: RenderingEngine,
  viewportId: string,
): ResliceVolume | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const data = vp.getImageData?.() as AnyObj | undefined;
    if (!data?.scalarData || !data.dimensions || !data.spacing || !data.origin || !data.direction) return null;
    const modality = String(data.metadata?.Modality ?? "").toUpperCase();
    const dir = Array.from(data.direction as ArrayLike<number>).map(Number);
    return {
      data: data.scalarData as ArrayLike<number>,
      dimensions: [data.dimensions[0], data.dimensions[1], data.dimensions[2]] as Vec3,
      spacing: [data.spacing[0], data.spacing[1], data.spacing[2]] as Vec3,
      origin: [data.origin[0], data.origin[1], data.origin[2]] as Vec3,
      direction: dir,
      airValue: modality === "CT" ? -1000 : 0,
    };
  } catch {
    return null;
  }
}

/** ボリュームの spacing の最小値（サブサンプル既定間隔）。取得不可なら 1。 */
export function volumeMinSpacing(engine: RenderingEngine, viewportId: string): number {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const sp = vp.getImageData?.()?.spacing as ArrayLike<number> | undefined;
    if (!sp) return 1;
    return Math.min(sp[0], sp[1], sp[2]) || 1;
  } catch {
    return 1;
  }
}

/** ベース断面上の「現在スライス」中心の canvas 座標（カットライン初期位置に使う）。 */
export function baseViewportCenter(engine: RenderingEngine, viewportId: string, el: HTMLElement): { cx: number; cy: number } {
  const rect = el.getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  // world 依存なしの単純中心（canvas 相対 CSS px）。engine/viewportId は将来 focalPoint 追従用に受ける。
  void engine;
  void viewportId;
  return { cx, cy };
}

/** transformWorldToIndex（P3 の範囲チェック等で使用）。 */
export function worldToIndex(engine: RenderingEngine, viewportId: string, world: Vec3): number[] | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const data = vp.getImageData?.();
    if (!data?.imageData) return null;
    return csUtilities.transformWorldToIndex(data.imageData, world) as number[];
  } catch {
    return null;
  }
}

/** Slicer のツールグループ・同期・エンジンを破棄する（アンマウント時）。 */
export function teardownSlicer(engine: RenderingEngine | null, toolGroupId: string): void {
  try {
    if (SynchronizerManager.getSynchronizer(SLICER_VOI_SYNC_ID)) {
      SynchronizerManager.destroySynchronizer(SLICER_VOI_SYNC_ID);
    }
  } catch {
    /* ignore */
  }
  try {
    if (ToolGroupManager.getToolGroup(toolGroupId)) ToolGroupManager.destroyToolGroup(toolGroupId);
  } catch {
    /* ignore */
  }
  try {
    engine?.destroy();
  } catch {
    /* ignore */
  }
}
