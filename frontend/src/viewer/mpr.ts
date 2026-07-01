/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR コア（P1）。Cornerstone3D の VolumeViewport ×3（AX/SAG/COR）でボリュームを再構成する。
 *
 * ボリューム構築:
 * - **CT かつガントリチルトあり**: `gantryTiltCorrect.ts` で直交 Axial へ再サンプリングし、
 *   `createLocalVolume` で補正済み scalarData を直接投入（Cornerstone はチルト非対応のため。
 *   設計 `fw/mpr-viewer-design.md` §3.5）。
 * - それ以外（非 CT / チルト無し CT）: `createAndCacheVolume({ imageIds })`（streaming）。
 *
 * いずれの経路でも 3 viewport は同一 world(患者 LPS) を共有するため、AX/SAG/COR は解剖学的に
 * 常に正しく、上下左右のジオメトリ整合（FSL eyes 風）は自動。src が SAG/COR 収集でも AX 基準になる。
 */
import {
  cache,
  imageLoader,
  metaData,
  volumeLoader,
  utilities as csUtilities,
  Enums,
  type Types,
  type RenderingEngine,
} from "@cornerstonejs/core";
import {
  ToolGroupManager,
  SynchronizerManager,
  CrosshairsTool,
  StackScrollTool,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import {
  correctGantryTilt,
  needsTiltCorrection,
  type TiltSourceVolume,
  type Vec3,
} from "./gantryTiltCorrect";
import { getOrCreateVoiSync } from "./sync";
import { computeOrientationMarkers, type OrientationMarkers } from "./orientation";

/** MPR の VOI(W/L) 同期 ID。3 面は同一ボリュームを見るため VOI は絶対値同期でよい。 */
export const MPR_VOI_SYNC_ID = "graphy-mpr-voi";

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = csToolsEnums;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

export interface MprViewportIds {
  axial: string;
  sagittal: string;
  coronal: string;
}

export interface MprElements {
  axial: HTMLDivElement;
  sagittal: HTMLDivElement;
  coronal: HTMLDivElement;
}

export interface BuildVolumeResult {
  volumeId: string;
  corrected: boolean; // ガントリチルト補正を適用したか
  tiltAngleDeg?: number;
}

// ── ベクトル小道具 ────────────────────────────────────────────
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

/**
 * CT シリーズの全スライスをロードし、法線投影でソートして z-major の HU ボリュームを組み立てる。
 * 画素は rescale を適用して HU（Int16）で格納（チルト補正の補間も HU 上で行う）。
 * 幾何が揃わない/スライス数不足なら null。
 */
async function assembleCtSourceVolume(imageIds: string[]): Promise<TiltSourceVolume | null> {
  if (imageIds.length < 2) return null;
  await Promise.all(imageIds.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));

  const plane0: AnyObj = metaData.get("imagePlaneModule", imageIds[0]) ?? {};
  const iopRaw = plane0.imageOrientationPatient;
  if (!Array.isArray(iopRaw) || iopRaw.length < 6) return null;
  const iop = iopRaw.map(Number);
  const rowCos: Vec3 = [iop[0], iop[1], iop[2]];
  const colCos: Vec3 = [iop[3], iop[4], iop[5]];
  const n = cross(rowCos, colCos);
  const nLen = norm(n) || 1;
  const normal: Vec3 = [n[0] / nLen, n[1] / nLen, n[2] / nLen];

  // 各スライスの IPP と法線投影距離。
  const recs: Array<{ id: string; ipp: Vec3; dist: number }> = [];
  for (const id of imageIds) {
    const p: AnyObj = metaData.get("imagePlaneModule", id) ?? {};
    const ippRaw = p.imagePositionPatient;
    if (!Array.isArray(ippRaw) || ippRaw.length < 3) continue;
    const ipp: Vec3 = [Number(ippRaw[0]), Number(ippRaw[1]), Number(ippRaw[2])];
    recs.push({ id, ipp, dist: dot(ipp, normal) });
  }
  if (recs.length < 2) return null;
  recs.sort((a, b) => a.dist - b.dist);

  const cols = Number(plane0.columns);
  const rows = Number(plane0.rows);
  if (!cols || !rows) return null;
  const ps = plane0.pixelSpacing ?? [1, 1]; // [row, col]
  const psY = Number(ps[0]) || 1;
  const psX = Number(ps[1]) || 1;

  const depth = recs.length;
  const ippFirst = recs[0].ipp;
  const ippLast = recs[depth - 1].ipp;
  const span = norm(sub(ippLast, ippFirst));
  const sliceSpacing = span / (depth - 1) || Number(plane0.sliceThickness) || 1;

  const sliceLen = cols * rows;
  const data = new Int16Array(sliceLen * depth);
  for (let z = 0; z < depth; z++) {
    const img = cache.getImage(recs[z].id) as AnyObj | undefined;
    if (!img) return null;
    const px = img.getPixelData() as ArrayLike<number>;
    const lut: AnyObj = metaData.get("modalityLutModule", recs[z].id) ?? {};
    const slope = Number(lut.rescaleSlope ?? img.slope ?? 1);
    const intercept = Number(lut.rescaleIntercept ?? img.intercept ?? 0);
    const base = z * sliceLen;
    for (let i = 0; i < sliceLen; i++) data[base + i] = Math.round(px[i] * slope + intercept);
  }

  return {
    data,
    width: cols,
    height: rows,
    depth,
    pixelSpacingX: psX,
    pixelSpacingY: psY,
    sliceSpacing,
    ippFirst,
    ippLast,
    iop,
    padding: -1000, // 空気 HU
  };
}

/** 補正済みローカルボリューム用の metadata（`makeVolumeMetadata` と同形）。データは HU(Int16 signed)。 */
function buildCorrectedMetadata(imageId0: string, spacing: Vec3, cols: number, rows: number): AnyObj {
  const gsm: AnyObj = metaData.get("generalSeriesModule", imageId0) ?? {};
  const plane: AnyObj = metaData.get("imagePlaneModule", imageId0) ?? {};
  return {
    BitsAllocated: 16,
    BitsStored: 16,
    SamplesPerPixel: 1,
    HighBit: 15,
    PhotometricInterpretation: "MONOCHROME2",
    PixelRepresentation: 1, // signed（HU）
    Modality: gsm.modality ?? "CT",
    ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
    PixelSpacing: [spacing[1], spacing[0]], // [row, col] = [psY, psX]
    FrameOfReferenceUID: plane.frameOfReferenceUID,
    Columns: cols,
    Rows: rows,
    voiLut: [{ windowWidth: 400, windowCenter: 40 }], // CT 既定（HU）
    VOILUTFunction: undefined,
    SeriesInstanceUID: gsm.seriesInstanceUID,
  };
}

/**
 * MPR 用ボリュームを構築してキャッシュする。CT でチルトがあれば前処理補正を適用。
 * @returns 構築した volumeId と補正フラグ。
 */
export async function buildMprVolume(
  imageIds: string[],
  modality: string | null,
  volumeId: string,
): Promise<BuildVolumeResult> {
  const isCT = (modality ?? "").toUpperCase() === "CT";
  if (isCT) {
    const src = await assembleCtSourceVolume(imageIds);
    if (src && needsTiltCorrection(src.ippFirst, src.ippLast, src.iop)) {
      // 符号付きチルト角を colCosine の Y-Z 成分から導出（tanA = Cz/Cy、設計 §3.5 の幾何）。
      const tiltAngleDeg = (Math.atan2(src.iop[5], src.iop[4]) * 180) / Math.PI;
      const c = correctGantryTilt(src, tiltAngleDeg);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (volumeLoader.createLocalVolume as any)(volumeId, {
        metadata: buildCorrectedMetadata(imageIds[0], c.spacing, c.width, c.height),
        dimensions: [c.width, c.height, c.depth],
        spacing: c.spacing,
        origin: c.origin,
        direction: c.direction,
        scalarData: c.data,
      });
      return { volumeId, corrected: true, tiltAngleDeg };
    }
  }
  await volumeLoader.createAndCacheVolume(volumeId, { imageIds });
  return { volumeId, corrected: false };
}

/**
 * 3 つの ORTHOGRAPHIC ビューポートを有効化し、ボリュームを設定、ツールグループ（Crosshairs 連動）を配線する。
 * 呼び出し前に `buildMprVolume` で volumeId を用意しておくこと。
 */
export async function setupMprViewports(
  engine: RenderingEngine,
  engineId: string,
  els: MprElements,
  ids: MprViewportIds,
  volumeId: string,
  toolGroupId: string,
): Promise<void> {
  const specs = [
    { id: ids.axial, el: els.axial, orientation: OrientationAxis.AXIAL },
    { id: ids.sagittal, el: els.sagittal, orientation: OrientationAxis.SAGITTAL },
    { id: ids.coronal, el: els.coronal, orientation: OrientationAxis.CORONAL },
  ];

  engine.setViewports(
    specs.map((s) => ({
      viewportId: s.id,
      type: ViewportType.ORTHOGRAPHIC,
      element: s.el,
      defaultOptions: {
        orientation: s.orientation,
        background: [0, 0, 0] as Types.Point3,
      },
    })),
  );

  const viewportIds = specs.map((s) => s.id);
  await Promise.all(
    viewportIds.map(async (id) => {
      const vp = engine.getViewport(id) as Types.IVolumeViewport;
      await vp.setVolumes([{ volumeId }]);
    }),
  );

  // ── ツールグループ（Crosshairs 連動十字線・W/L 同期・Pan/Zoom・スライス送り） ──
  let tg = ToolGroupManager.getToolGroup(toolGroupId);
  if (tg) ToolGroupManager.destroyToolGroup(toolGroupId);
  tg = ToolGroupManager.createToolGroup(toolGroupId);
  if (!tg) return;

  const refColors: Record<string, Types.Point3> = {
    [ids.axial]: [0, 220, 0],
    [ids.sagittal]: [220, 220, 0],
    [ids.coronal]: [0, 160, 255],
  };
  tg.addTool(CrosshairsTool.toolName, {
    getReferenceLineColor: (viewportId: string) => refColors[viewportId] ?? [200, 200, 200],
  });
  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(StackScrollTool.toolName);

  for (const id of viewportIds) tg.addViewport(id, engineId);

  // 左=Crosshairs（クリックで交点ジャンプ＝FSL eyes 風）、右=W/L、中=Pan、ホイール=スライス送り。
  tg.setToolActive(CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
  tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });

  // W/L 同期（1 面の調整を 3 面へ）。同一ボリュームなので絶対値同期でよい。
  const voiSync = getOrCreateVoiSync(MPR_VOI_SYNC_ID);
  for (const id of viewportIds) voiSync.add({ renderingEngineId: engineId, viewportId: id });

  engine.renderViewports(viewportIds);
}

/** W/L プリセット（HU の center/width）を 3 面へ適用する。 */
export function applyMprWl(
  engine: RenderingEngine,
  viewportIds: string[],
  center: number,
  width: number,
): void {
  const lower = center - width / 2;
  const upper = center + width / 2;
  for (const id of viewportIds) {
    try {
      const vp = engine.getViewport(id) as Types.IVolumeViewport;
      vp.setProperties({ voiRange: { lower, upper } });
      vp.render();
    } catch {
      /* ignore */
    }
  }
}

/** VOI を各面の既定（ボリューム metadata の VOI）へ戻す。 */
export function resetMprWl(engine: RenderingEngine, viewportIds: string[]): void {
  for (const id of viewportIds) {
    try {
      const vp = engine.getViewport(id) as Types.IVolumeViewport & { resetProperties?: () => void };
      vp.resetProperties?.();
      vp.render();
    } catch {
      /* ignore */
    }
  }
}

/** 1 ビューポートのオーバーレイ情報（方位ラベル・スライス番号）。 */
export interface MprOverlay {
  markers: OrientationMarkers | null;
  slice: number; // 0-based
  total: number;
}

/** ビューポートから方位ラベルと現在スライス番号を読み取る。 */
export function readMprOverlay(engine: RenderingEngine, viewportId: string, element: HTMLElement): MprOverlay {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vp = engine.getViewport(viewportId) as any;
  let markers: OrientationMarkers | null = null;
  let slice = 0;
  let total = 0;
  try {
    markers = computeOrientationMarkers(vp, element);
  } catch {
    /* ignore */
  }
  try {
    slice = vp.getSliceIndex?.() ?? 0;
    total = vp.getNumberOfSlices?.() ?? 0;
  } catch {
    /* ignore */
  }
  return { markers, slice, total };
}

/** マウス直下のプローブ結果（実空間座標＋輝度値）。 */
export interface MprProbe {
  /** 患者座標 [x,y,z]（mm, LPS）。 */
  world: [number, number, number];
  /** ボリュームの輝度値（CT=HU 等）。範囲外は null。 */
  value: number | null;
  /** ボクセル index [i,j,k]（範囲外時 null）。 */
  ijk: [number, number, number] | null;
  /** どの面か（viewportId）。 */
  plane: string;
}

/**
 * ビューポート上の canvas 座標（要素相対 CSS px）から、世界座標とボリューム輝度値を求める。
 * canvasToWorld はカメラ逆変換（zoom/pan/回転/スライス位置を含む）なので、表示中の実空間位置になる。
 */
export function probeMpr(
  engine: RenderingEngine,
  viewportId: string,
  canvasX: number,
  canvasY: number,
): MprProbe | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vp = engine.getViewport(viewportId) as any;
    const w = vp.canvasToWorld([canvasX, canvasY]) as [number, number, number];
    const world: [number, number, number] = [w[0], w[1], w[2]];
    let value: number | null = null;
    let ijk: [number, number, number] | null = null;
    const data = vp.getImageData?.();
    if (data?.imageData && data.voxelManager && data.dimensions) {
      const idx = csUtilities.transformWorldToIndex(data.imageData, world) as number[];
      const [i, j, k] = idx;
      const [dx, dy, dz] = data.dimensions as [number, number, number];
      if (i >= 0 && i < dx && j >= 0 && j < dy && k >= 0 && k < dz) {
        ijk = [i, j, k];
        const v = data.voxelManager.getAtIJK(i, j, k);
        value = typeof v === "number" ? v : null;
      }
    }
    return { world, value, ijk, plane: viewportId };
  } catch {
    return null;
  }
}

/** MPR のツールグループ・同期・ビューポートを破棄する（アンマウント時）。 */
export function teardownMpr(engine: RenderingEngine | null, toolGroupId: string): void {
  try {
    if (SynchronizerManager.getSynchronizer(MPR_VOI_SYNC_ID)) {
      SynchronizerManager.destroySynchronizer(MPR_VOI_SYNC_ID);
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
