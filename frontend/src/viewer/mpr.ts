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
import { getModalityCalibration } from "./pixelCalibration";
import { installWheelSliceGate } from "./wheelScroll";
import { VolumeMemoryExceededError } from "./volumeMemory";
import { regularGrid, sliceGeometry, type SliceGeometry } from "./sliceGeometry";
import { sliceInfosOf } from "./sliceInfoMeta";
import { interpolateToGrid, SliceDuplicatesError } from "./depthVolume";
import type { SlabProjection } from "./slabPresets";

/** MPR の VOI(W/L) 同期 ID。3 面は同一ボリュームを見るため VOI は絶対値同期でよい。 */
export const MPR_VOI_SYNC_ID = "graphy-mpr-voi";

const { ViewportType, OrientationAxis } = Enums;
const { MouseBindings } = csToolsEnums;

/** モバイルのタッチで 1 本指に割り当てるツール（ピンチ Zoom は別枠で常時有効）。 */
export type MprTouchTool = "scroll" | "wl" | "pan";

type MprToolGroup = NonNullable<ReturnType<typeof ToolGroupManager.getToolGroup>>;

/**
 * 1 本指タッチのツールを切り替える。Cornerstone3D は 1 つの指本数（1/2/3）に 1 ツールしか
 * 持てないため、3 候補（StackScroll=スライス送り / WindowLevel / Pan）を一旦マウス専用へ戻し、
 * 選択したツールにだけ `numTouchPoints: 1` を併記する。Crosshairs はタッチ非対応なので touch には出さない。
 */
function applyMprTouchTool(tg: MprToolGroup, tool: MprTouchTool): void {
  // ⚠️ setToolActive はバインドを「マージ」する（既存に追加するだけで削除できない）。単純に貼り直すと
  // 一度付いた numTouchPoints:1 が候補ツールに残り続け、1 本指が常に同じツール（登録キー順で最初の
  // もの）に解決されてしまう。切替のたびに removeAllBindings で一旦全消去してから貼り直し、選択した
  // ツールだけが numTouchPoints:1 を持つ状態にする。
  for (const name of [StackScrollTool.toolName, WindowLevelTool.toolName, PanTool.toolName]) {
    tg.setToolPassive(name, { removeAllBindings: true });
  }
  tg.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
  tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
  const chosen =
    tool === "wl"
      ? { name: WindowLevelTool.toolName, mouse: MouseBindings.Secondary }
      : tool === "pan"
        ? { name: PanTool.toolName, mouse: MouseBindings.Auxiliary }
        : { name: StackScrollTool.toolName, mouse: MouseBindings.Wheel };
  tg.setToolActive(chosen.name, { bindings: [{ mouseButton: chosen.mouse }, { numTouchPoints: 1 }] });
}

/**
 * MPR モバイルのツールバートグルから 1 本指タッチのツールを切り替える（モバイルのみ呼ぶ）。
 *
 * <p>Cornerstone3D の 1 本指タッチは「`numTouchPoints:1` を持つツール**または** Primary マウスの
 * ツール」にマッチし、登録順で最初の Active を採る。MPR は Crosshairs が Primary かつ最初なので、
 * Active のままだと 1 本指が Crosshairs に取られる（＝タッチ非対応で無反応）。そこでモバイルでは
 * Crosshairs を Passive にして 1 本指スロットを解放する（参照線は Passive でも描画される）。
 */
export function setMprTouchTool(toolGroupId: string, tool: MprTouchTool): void {
  const tg = ToolGroupManager.getToolGroup(toolGroupId);
  if (!tg) return;
  tg.setToolPassive(CrosshairsTool.toolName);
  applyMprTouchTool(tg, tool);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

export type MprCrosshairColorMode = "perPlane" | "single";

/** 十字線の色。面ごと（Axial 緑・Sagittal 黄・Coronal 青）か、全部を 1 色にする。知らない面は灰色。 */
export function crosshairColorFor(
  viewportId: string,
  ids: MprViewportIds,
  mode: MprCrosshairColorMode,
  single: [number, number, number],
): [number, number, number] {
  if (mode === "single") return single;
  if (viewportId === ids.axial) return [0, 220, 0];
  if (viewportId === ids.sagittal) return [220, 220, 0];
  if (viewportId === ids.coronal) return [0, 160, 255];
  return [200, 200, 200];
}

/** [r, g, b]（0..255）→ "rgb(r, g, b)"。 */
export function rgbCss(rgb: readonly [number, number, number]): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

// CrosshairsTool は色の関数をツールを作るときに 1 度だけ読むので、設定はここを経由させる。
let crosshairColorMode: MprCrosshairColorMode = "perPlane";
let crosshairSingleColor: [number, number, number] = [255, 255, 255];

/** 環境設定の十字線の色を当てる（次に作る MPR から効く）。読めない値は既定（面ごとの色・白）。 */
export function setMprCrosshairColors(mode: string | undefined, single: [number, number, number] | null): void {
  crosshairColorMode = mode === "single" ? "single" : "perPlane";
  crosshairSingleColor = single ?? [255, 255, 255];
}

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
  /** 体積のスライス順の imageId（チルト補正で作り直した体積では無い）。 */
  sortedImageIds?: string[];
  /** 奥行きの決め方と並びの分類（`fw/slice-depth-policy.md`）。 */
  geometry: SliceGeometry;
  /**
   * 不均一な並びを均一な格子に取り直したとき（kind が missing / irregular）。
   * `gridIndexOf[i]` は sortedImageIds の i 番目の画像が当たる格子の番号。補間で作った面は元の画像を持たない。
   */
  grid?: { count: number; spacing: number; gridIndexOf: number[]; interpolated: boolean };
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
async function assembleCtSourceVolume(
  imageIds: string[],
  maxBytes?: number,
): Promise<TiltSourceVolume | null> {
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
  // 二重防御（fw/volume-memory-guard.md V2）: 呼び出し側の予測が漏れた場合に備え、ロード後に
  // 確定した cols/rows/depth でも上限を見る。チルト補正経路はここの Int16 と correctGantryTilt の
  // 出力（createLocalVolume）で 2 本生きるので ×2 で見積もる。
  if (maxBytes !== undefined) {
    const needed = sliceLen * depth * 2 * 2;
    if (needed > maxBytes) throw new VolumeMemoryExceededError(needed, maxBytes);
  }
  const data = new Int16Array(sliceLen * depth);
  for (let z = 0; z < depth; z++) {
    const img = cache.getImage(recs[z].id) as AnyObj | undefined;
    if (!img) return null;
    const px = img.getPixelData() as ArrayLike<number>;
    // 校正は pixelCalibration に一元化（preScale 二重適用を防ぐ）。scale/offset は
    // preScale 済みなら {1,0} なので、そのまま px[i]*scale+offset でモダリティ値になる。
    const { scale, offset } = getModalityCalibration(img, recs[z].id);
    const base = z * sliceLen;
    for (let i = 0; i < sliceLen; i++) data[base + i] = Math.round(px[i] * scale + offset);
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
 * 不均一な並び（欠け・不規則）を、間隔 = 最小の間隔の均一な格子に取り直したローカルボリュームを作る。
 * 奥行き方向だけの線形補間（面内は触らない）。値は校正済みのモダリティ値（Float32）。
 * 画素が 1 成分でない（カラー等）ときは null（呼び出し側が通常の経路に戻す）。
 */
function buildInterpolatedVolume(
  sortedIds: string[],
  g: SliceGeometry,
  volumeId: string,
  modality: string | null,
  maxBytes?: number,
): { grid: { count: number; spacing: number; gridIndexOf: number[] } } | null {
  const grid = regularGrid(g);
  const plane0: AnyObj = metaData.get("imagePlaneModule", sortedIds[0]) ?? {};
  const cols = Number(plane0.columns);
  const rows = Number(plane0.rows);
  const iop = (plane0.imageOrientationPatient as ArrayLike<number> | undefined);
  const ipp = (plane0.imagePositionPatient as ArrayLike<number> | undefined);
  if (!cols || !rows || !iop || iop.length < 6 || !ipp || !g.normal) return null;
  const sliceLen = cols * rows;
  if (maxBytes !== undefined) {
    const needed = sliceLen * (sortedIds.length + grid.count) * 4;
    if (needed > maxBytes) throw new VolumeMemoryExceededError(needed, maxBytes);
  }
  const slices: Float32Array[] = [];
  for (const id of sortedIds) {
    const img = cache.getImage(id) as AnyObj | undefined;
    if (!img) return null;
    const px = img.getPixelData() as ArrayLike<number>;
    if (px.length !== sliceLen) return null;
    const { scale, offset } = getModalityCalibration(img, id);
    const v = new Float32Array(sliceLen);
    for (let i = 0; i < sliceLen; i++) v[i] = px[i] * scale + offset;
    slices.push(v);
  }
  const positions = g.order.map((_, i) => g.positions[i]);
  const { data } = interpolateToGrid(slices, positions, grid, sliceLen);
  const ps = plane0.pixelSpacing ?? [1, 1]; // [row, col]
  const spacing: Vec3 = [Number(ps[1]) || 1, Number(ps[0]) || 1, grid.spacing];
  const md = buildCorrectedMetadata(sortedIds[0], spacing, cols, rows);
  md.BitsAllocated = 32;
  md.BitsStored = 32;
  md.HighBit = 31;
  md.ImageOrientationPatient = Array.from(iop).slice(0, 6).map(Number);
  if ((modality ?? "").toUpperCase() !== "CT") {
    let lo = Infinity, hi = -Infinity;
    for (const s of slices) for (let i = 0; i < sliceLen; i++) { const x = s[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
    if (hi > lo) md.voiLut = [{ windowWidth: hi - lo, windowCenter: (hi + lo) / 2 }];
  }
  const dir: number[] = [
    Number(iop[0]), Number(iop[1]), Number(iop[2]),
    Number(iop[3]), Number(iop[4]), Number(iop[5]),
    g.normal[0], g.normal[1], g.normal[2],
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (volumeLoader.createLocalVolume as any)(volumeId, {
    metadata: md,
    dimensions: [cols, rows, grid.count],
    spacing,
    origin: [Number(ipp[0]), Number(ipp[1]), Number(ipp[2])],
    direction: dir,
    scalarData: data,
  });
  return { grid: { count: grid.count, spacing: grid.spacing, gridIndexOf: grid.gridIndexOf } };
}

/**
 * MPR 用ボリュームを構築してキャッシュする。CT でチルトがあれば前処理補正を適用。
 * 間隔が不均一なシリーズ（欠け・不規則）は均一な格子に補間して組む。同じ位置に重なるスライスがあれば
 * {@link SliceDuplicatesError}。
 *
 * @param opts.maxBytes 二重防御（`fw/volume-memory-guard.md` V2）。**呼び出し側が事前予測
 *   できなかったときだけ渡す**。ロード後に確定した寸法で超過していれば
 *   {@link VolumeMemoryExceededError} を投げる。利用者が警告を見て「続行」を選んだ場合は
 *   渡さないこと（後段で無条件に止め直すことになるため）。
 * @returns 構築した volumeId と補正フラグ。
 */
export async function buildMprVolume(
  imageIds: string[],
  modality: string | null,
  volumeId: string,
  opts?: { maxBytes?: number },
): Promise<BuildVolumeResult> {
  const isCT = (modality ?? "").toUpperCase() === "CT";
  // 奥行きの決定と CrosshairsTool（getClosestImageId）の IPP 参照のため、メタデータを先に揃える。
  await Promise.all(imageIds.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
  const geometry = sliceGeometry(sliceInfosOf(imageIds));
  if (geometry.kind === "duplicates") throw new SliceDuplicatesError();
  if (isCT) {
    const src = await assembleCtSourceVolume(imageIds, opts?.maxBytes);
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
      return { volumeId, corrected: true, tiltAngleDeg, geometry };
    }
  }
  // wadouri は入力順を信頼するため、空間順（IPP 法線投影）に並べ替えてから volume 化する（Z 折り返り防止）。
  // 位置が分からないシリーズは入力の順のまま（sliceGeometry の order も恒等）。
  const sortedImageIds = geometry.order.map((i) => imageIds[i]);
  if (geometry.kind === "missing" || geometry.kind === "irregular") {
    const built = buildInterpolatedVolume(sortedImageIds, geometry, volumeId, modality, opts?.maxBytes);
    if (built) {
      return {
        volumeId,
        corrected: false,
        sortedImageIds,
        geometry,
        grid: { ...built.grid, interpolated: true },
      };
    }
  }
  const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: sortedImageIds });
  // ピクセルデータのストリーミングを開始して待つ（未ロードだと VolumeViewport が黒のまま）。
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (volume as any)?.load?.();
  } catch {
    /* ignore */
  }
  return { volumeId, corrected: false, sortedImageIds, geometry };
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

  // ホイールは StackScroll（スライス送り）。Cornerstone はイベント 1 件ごとに 1 スライス送るため、
  // 高分解能ホイール／トラックパッドでは一気に飛ぶ。1 ノッチ = 1 スライスに間引く。
  for (const s of specs) installWheelSliceGate(s.el);

  const viewportIds = specs.map((s) => s.id);
  await Promise.all(
    viewportIds.map(async (id) => {
      const vp = engine.getViewport(id) as Types.IVolumeViewport;
      await vp.setVolumes([{ volumeId }]);
      const exact = exactMetadataVoiRange(volumeId);
      if (exact) vp.setProperties({ voiRange: exact });
    }),
  );

  // ── ツールグループ（Crosshairs 連動十字線・W/L 同期・Pan/Zoom・スライス送り） ──
  let tg = ToolGroupManager.getToolGroup(toolGroupId);
  if (tg) ToolGroupManager.destroyToolGroup(toolGroupId);
  tg = ToolGroupManager.createToolGroup(toolGroupId);
  if (!tg) return;

  tg.addTool(CrosshairsTool.toolName, {
    // 🔴 色は "rgb(r, g, b)" の文字列で返す。CrosshairsTool はそのまま SVG の stroke に書くので、
    //    配列を返すと stroke="0,220,0"（無効な色）になり、十字線が描かれない（2026-10-12 まで見えていなかった）。
    getReferenceLineColor: (viewportId: string) =>
      rgbCss(crosshairColorFor(viewportId, ids, crosshairColorMode, crosshairSingleColor)),
  });
  tg.addTool(WindowLevelTool.toolName);
  tg.addTool(PanTool.toolName);
  tg.addTool(ZoomTool.toolName);
  tg.addTool(StackScrollTool.toolName);

  for (const id of viewportIds) tg.addViewport(id, engineId);

  // マウス（デスクトップ）: 左=Crosshairs（クリックで交点ジャンプ＝FSL eyes 風）、右=W/L、中=Pan、ホイール=スライス送り。
  tg.setToolActive(CrosshairsTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
  // タッチ（モバイル）: 2 本指ピンチ=Zoom は常時。1 本指ツールは既定でスライス送り、トグルで W-L / Pan に切替。
  tg.setToolActive(ZoomTool.toolName, { bindings: [{ numTouchPoints: 2 }] });
  applyMprTouchTool(tg, "scroll");

  // W/L 同期（1 面の調整を 3 面へ）。同一ボリュームなので絶対値同期でよい。
  const voiSync = getOrCreateVoiSync(MPR_VOI_SYNC_ID);
  for (const id of viewportIds) voiSync.add({ renderingEngineId: engineId, viewportId: id });

  engine.renderViewports(viewportIds);
}

/**
 * DICOM が VOI LUT Function に LINEAR_EXACT を指定した窓の範囲（中央のスライスの VOI＝cornerstone と同じ選び方）。
 * 指定が無ければ null（cornerstone の既定のまま）。
 *
 * <p>cornerstone 3.33 の `getVOIFromMetadata` は VOILUTFunction を読んだ直後に上書きして捨て、常に LINEAR
 * （幅から 1 を引く整数の画像向けの式）で範囲にする。幅 0.002 の ADC（Parametric Map）では上下が逆転して
 * 3 面とも真っ白になった（fw/nifti-import.md §3.1・F3）。
 */
export function exactMetadataVoiRange(volumeId: string): { lower: number; upper: number } | null {
  const vol = cache.getVolume(volumeId) as AnyObj | undefined;
  const ids: string[] | undefined = vol?.imageIds;
  if (!ids?.length) return null;
  const m: AnyObj | undefined = metaData.get("voiLutModule", ids[Math.floor(ids.length / 2)]);
  if (m?.voiLUTFunction !== "LINEAR_EXACT") return null;
  const w = Number(Array.isArray(m.windowWidth) ? m.windowWidth[0] : m.windowWidth);
  const c = Number(Array.isArray(m.windowCenter) ? m.windowCenter[0] : m.windowCenter);
  if (!(w > 0) || !Number.isFinite(c)) return null;
  return { lower: c - w / 2, upper: c + w / 2 };
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

/** MPR のスラブ設定。projection=null で通常の薄い MPR（COMPOSITE・最小厚）。厚みは全幅 mm。 */
export interface MprSlab {
  projection: SlabProjection | null;
  thicknessMm: number;
}

/** 投影方式 → cornerstone の BlendMode。 */
export function mprBlendModeFor(projection: SlabProjection | null): Enums.BlendModes {
  if (projection === "MIP") return Enums.BlendModes.MAXIMUM_INTENSITY_BLEND;
  if (projection === "MINIP") return Enums.BlendModes.MINIMUM_INTENSITY_BLEND;
  if (projection === "AVG") return Enums.BlendModes.AVERAGE_INTENSITY_BLEND;
  return Enums.BlendModes.COMPOSITE;
}

/**
 * 3 面へスラブ投影（Slab MIP/MinIP/AvgIP）を一括適用する（fw/slab-mip-design.md §B）。
 *
 * <p>ORTHOGRAPHIC の `VolumeViewport` では cornerstone が焦点面 ±厚/2 のクリップ面で切り出し、
 * vtk の VolumeMapper を MIP 等のブレンドで描く（OHIF と同方式）。表示専用であり、確定計算
 * （probe の値など）には使わない（fw/cornerstone-3d-geometry-caveat.md）。
 */
export function applyMprSlab(engine: RenderingEngine, viewportIds: string[], slab: MprSlab): void {
  for (const id of viewportIds) {
    try {
      const vp = engine.getViewport(id) as Types.IVolumeViewport;
      vp.setBlendMode(mprBlendModeFor(slab.projection));
      if (slab.projection) vp.setSlabThickness(slab.thicknessMm);
      else vp.resetSlabThickness();
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
      const exact = exactMetadataVoiRange((vp as AnyObj).getVolumeId?.() ?? "");
      if (exact) vp.setProperties({ voiRange: exact });
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
