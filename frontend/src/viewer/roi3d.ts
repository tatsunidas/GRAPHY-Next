/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D ROI（M4）。GRAPHY の SphereRoi3D / FreeFormRoi3D に対応する 3D 機能。
 *
 * - **SphereRoi3D 相当**: 円 ROI（中心 world + 半径 mm）から **3D 球をボリューム labelmap にラスタ化**
 *   （= バイナリ Mask へ変換）。各スライス平面と球の交差円（断面半径 = √(r²−d²)）を塗る。
 * - **FreeFormRoi3D 相当**: 既存の Mask（Cornerstone labelmap, scope.z="all"）がそのまま 3D バイナリ
 *   ボリューム。ブラシで全スライス編集。ここでは追加実装不要。
 * - **体積統計**: Mask の前景ボクセル数 × ボクセル体積（row×col×slice 間隔）。
 *
 * 設計: `fw/roi-manager-design.md` 第5章 / `fw/roi-mask-model.md`。
 */
import { cache, imageLoader, metaData } from "@cornerstonejs/core";
import { annotation as csAnnotation, segmentation as csSeg, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { createResultSeg, resolveRoiStack, setScopeZFromForeground } from "./roiBooleanOps";
import { getRoiMaskMeta, setRoiMaskMeta } from "./roiMaskStore";
import { addRoi3d, getRoi3d, newRoi3dId } from "./roiLedger";
import { containsPoint, sectionOutline, sphereSolid, type Roi3dBox } from "./roi3dBox";
import { getModalityCalibration, readModalitySlice, resolveValueUnit } from "./pixelCalibration";
import { accumulateMaskStats, collectMaskValues, isSegmentForeground, type MaskSliceInput } from "./maskStatsCore";
import { maskVoxelDumpCsvChunks, type MaskDumpSlice } from "./maskVoxelDump";
import { roiHistogram, summarizeValues, type RoiValueStats } from "./roiStats";
import type { HistogramData } from "./histogram";
import { imageToWorldOnPlane, worldToImageOnPlane, type PlaneGeometry } from "./imageCoords";
import { ensureStackMetadata, maskDepthContext } from "./maskVolume";
import { maskVolumeFromLabels, type MaskDepthContext, type MaskMeshVolume } from "./depthVolume";

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
const MAX_SLICE_MASKS = 64; // 3D→2D split の出力上限。
let sliceSeq = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function img(id: string): any {
  return cache.getImage(id);
}

type V3 = [number, number, number];

interface Plane {
  ipp: V3;
  cols: number;
  rows: number;
  rowSp: number;
  colSp: number;
  rowCos: V3;
  colCos: V3;
}

/** imagePlaneModule から平面幾何を取得。 */
function planeOf(imageId: string): Plane | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = metaData.get("imagePlaneModule", imageId) as any;
  if (!m || !m.imagePositionPatient || !m.rowCosines || !m.columnCosines) return null;
  return {
    ipp: m.imagePositionPatient as V3,
    cols: (m.columns ?? 0) as number,
    rows: (m.rows ?? 0) as number,
    rowSp: (m.rowPixelSpacing || 1) as number,
    colSp: (m.columnPixelSpacing || 1) as number,
    rowCos: m.rowCosines as V3,
    colCos: m.columnCosines as V3,
  };
}

/**
 * world → 画素 [x(列), y(行)]（slice 平面へ射影）。
 * 🚨 x は**列間隔**（colSp）、y は**行間隔**（rowSp）で割る。上流 `worldToImageCoords` は
 * ここを入れ替えており、非等方画素で球が楕円にずれる（{@link ./imageCoords} 参照）。
 */
function worldToPx(p: Plane, w: V3): [number, number] {
  return worldToImageOnPlane(
    { imagePositionPatient: p.ipp, rowCosines: p.rowCos, columnCosines: p.colCos, rowPixelSpacing: p.rowSp, columnPixelSpacing: p.colSp },
    w,
  );
}

/**
 * 3D の solid（楕円体・直方体、患者座標 mm）をボリューム labelmap にラスタ化し新規 Mask を返す。
 * `refImageId` は solid が属するスタックを解決するための任意の 1 スライス imageId（作成スライス等）。
 * 各スライスで**画素中心の world 位置**が solid の内側（境界を含む）なら前景。解決不能/交差ゼロなら null。
 * `scopeFromId` があれば meta(patient/series/scope) を継承。
 */
export async function rasterizeSolidToMask(
  solid: Pick<Roi3dBox, "shape" | "center" | "size">,
  refImageId: string,
  label: string,
  scopeFromId?: string,
): Promise<string | null> {
  const stack = resolveRoiStack(refImageId);
  if (!stack) return null;
  const planes = stack.sourceIds.map(planeOf);
  if (planes.some((p) => !p)) return null;

  const res = await createResultSeg(stack.sourceIds, stack.viewportIds, label, scopeFromId ?? "");
  if (!res) return null;

  const modified: number[] = [];
  for (let z = 0; z < stack.sourceIds.length; z++) {
    const pl = planes[z] as Plane;
    // この平面との断面の外接矩形（画素）だけを走査する。交わらないスライスは飛ばす。
    const outline = sectionOutline(solid, pl.ipp, pl.rowCos, pl.colCos, 64);
    if (!outline) continue;
    const vm = img(res.labelmapIds[z])?.voxelManager;
    const cols = pl.cols, rows = pl.rows;
    if (!vm || !cols || !rows) continue;
    const px = outline.map((w) => worldToPx(pl, w));
    const x0 = Math.max(0, Math.floor(Math.min(...px.map((q) => q[0])) - 1)), x1 = Math.min(cols - 1, Math.ceil(Math.max(...px.map((q) => q[0])) + 1));
    const y0 = Math.max(0, Math.floor(Math.min(...px.map((q) => q[1])) - 1)), y1 = Math.min(rows - 1, Math.ceil(Math.max(...px.map((q) => q[1])) + 1));
    const geom = { imagePositionPatient: pl.ipp, rowCosines: pl.rowCos, columnCosines: pl.colCos, rowPixelSpacing: pl.rowSp, columnPixelSpacing: pl.colSp };
    let touched = false;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (containsPoint(solid, imageToWorldOnPlane(geom, [x + 0.5, y + 0.5]))) {
          vm.setAtIndex(y * cols + x, 1);
          touched = true;
        }
      }
    }
    if (touched) modified.push(z);
  }
  if (modified.length === 0) return null;
  csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(res.segId, modified, 1);
  setScopeZFromForeground(res.segId, stack.sourceIds, modified);
  return res.segId;
}

/** 円 ROI から中心 world・半径 mm・作成スライス imageId を読む（円以外は null）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function circleParams(annotationUid: string): { center: V3; radiusMm: number; refId: string; label?: string } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ann = (csAnnotation.state as any).getAnnotation(annotationUid);
  const tool = (ann?.metadata?.toolName ?? "") as string;
  const refId = ann?.metadata?.referencedImageId as string | undefined;
  const pts: number[][] = ann?.data?.handles?.points ?? [];
  if (!ann || !refId || !/circle/i.test(tool) || pts.length < 2) return null;
  const center = pts[0] as V3;
  const edge = pts[1] as V3;
  const radiusMm = Math.hypot(edge[0] - center[0], edge[1] - center[1], edge[2] - center[2]);
  if (!(radiusMm > 0)) return null;
  return { center, radiusMm, refId, label: getRoiMaskMeta(annotationUid)?.label };
}

/**
 * 円 ROI を 3D 球として**直接 Mask にラスタ化**（パラメータ非保持の即焼き込み）。
 */
export async function sphereFromCircleRoi(annotationUid: string): Promise<string | null> {
  const p = circleParams(annotationUid);
  if (!p) return null;
  return rasterizeSolidToMask(sphereSolid("", p.center, p.radiusMm), p.refId, p.label || "Sphere", annotationUid);
}

/**
 * 円 ROI から**パラメトリック 3D 球**（3 軸が等しい楕円体の solid）を作り台帳へ登録する
 * （全スライスにライブ断面プレビュー。保存対象）。シリーズ/scope は円 ROI のメタ（作成時に紐付け済）から継承。
 * 作成した solid の id を返す。
 */
export function createSphere3DFromCircleRoi(annotationUid: string): string | null {
  const p = circleParams(annotationUid);
  if (!p) return null;
  const meta = getRoiMaskMeta(annotationUid);
  const sc = meta?.scope;
  const id = newRoi3dId();
  addRoi3d({
    ...sphereSolid(id, p.center, p.radiusMm),
    studyUid: sc?.studyUid ?? "",
    seriesUid: sc?.seriesUid ?? "",
    refImageId: p.refId,
    c: sc?.c ?? "all",
    t: sc?.t ?? "all",
    seriesLabel: meta?.seriesLabel,
    patientKey: meta?.patientKey ?? "",
    label: p.label || "Sphere",
    color: "#00e5ff",
    visible: true,
  });
  return id;
}

/** 台帳の solid（楕円体・直方体）を Mask にラスタ化（焼き込み）。patient/series/scope を継承。 */
export async function bakeSolid3D(solidId: string, patientKey: string): Promise<string | null> {
  const s = getRoi3d(solidId);
  if (!s?.refImageId) return null;
  const segId = await rasterizeSolidToMask(s, s.refImageId, s.label || "Sphere");
  if (!segId) return null;
  const scope = { studyUid: s.studyUid ?? "", seriesUid: s.seriesUid ?? "", z: "all" as const, c: s.c ?? "all", t: s.t ?? "all" };
  setRoiMaskMeta(segId, {
    patientKey,
    seriesLabel: s.seriesLabel,
    scope,
    origin: scope,
    label: s.label,
  });
  return segId;
}

/**
 * ボリューム Mask を**非空スライスごとの単一スライス Mask** に分解（3D→2D split）。
 * 各出力は当該 source 1 枚から派生する軽量な単一スライス labelmap（scope.z=その index）。
 * 生成した segmentationId 配列を返す（非空スライスが {@link MAX_SLICE_MASKS} を超える分は無視）。
 */
export async function splitMaskToSlices(segmentationId: string, segmentIndex?: number): Promise<string[]> {
  let labelmapIds: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labelmapIds = (csSeg as any).getLabelmapImageIds(segmentationId) as string[];
  } catch {
    return [];
  }
  if (!labelmapIds?.length) return [];
  const sourceIds = labelmapIds.map((id) => img(id)?.referencedImageId as string);
  const base = getRoiMaskMeta(segmentationId);
  // 結果表示先: 元 Mask を表示中の viewport。
  let viewportIds: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    viewportIds = ((csSeg.state as any).getViewportIdsWithSegmentation(segmentationId) as string[] | undefined) ?? [];
  } catch {
    /* ignore */
  }

  const created: string[] = [];
  for (let z = 0; z < labelmapIds.length && created.length < MAX_SLICE_MASKS; z++) {
    const srcVm = img(labelmapIds[z])?.voxelManager;
    const sourceId = sourceIds[z];
    if (!srcVm || !sourceId) continue;
    const len = srcVm.getScalarDataLength();
    // 非空判定。
    let any = false;
    for (let i = 0; i < len; i++) if (isSegmentForeground(srcVm.getAtIndex(i), segmentIndex)) { any = true; break; }
    if (!any) continue;

    await imageLoader.loadAndCacheImage(sourceId).catch(() => null);
    const derived = imageLoader.createAndCacheDerivedLabelmapImages([sourceId]);
    const labelmapId = derived[0].imageId;
    const segId = `graphy-seg2d-${++sliceSeq}-z${z}`;
    csSeg.addSegmentations([
      { segmentationId: segId, representation: { type: LABELMAP, data: { imageIds: [labelmapId] } } },
    ]);
    for (const vp of viewportIds) {
      try {
        csSeg.addLabelmapRepresentationToViewport(vp, [{ segmentationId: segId, type: LABELMAP }]);
      } catch {
        /* ignore */
      }
    }
    // ボクセルを当該スライスへコピー。マスク全体なら segment index を保持し、
    // segment 指定なら単一 ROI の塗りとして 1 に振り直す（新マスクの segments は既定の [1]）。
    const outVm = img(labelmapId)?.voxelManager;
    if (outVm) {
      for (let i = 0; i < len; i++) {
        const v = srcVm.getAtIndex(i);
        if (isSegmentForeground(v, segmentIndex)) outVm.setAtIndex(i, segmentIndex != null ? 1 : v);
      }
    }
    const scope = base?.scope ? { ...base.scope, z } : { z };
    setRoiMaskMeta(segId, {
      patientKey: base?.patientKey,
      seriesLabel: base?.seriesLabel,
      scope,
      origin: scope,
      label: `${segmentIndex != null ? (base?.segmentLabels?.[String(segmentIndex)] ?? `${base?.label ?? "ROI"} #${segmentIndex}`) : (base?.label ?? "ROI")} z${z + 1}`,
    });
    csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(segId, [0], undefined);
    created.push(segId);
  }
  return created;
}

export interface MaskVolumeStats {
  voxels: number;
  /** メッシュ（スライスごとの輪郭の角柱）の体積。間隔・奥行きが不明なら undefined（0 で埋めない）。 */
  volumeMm3?: number;
  volumeMl?: number;
  /** 体積の注意（`roiStats.warn.*` のキー）。 */
  warnings: string[];
  depthSource?: string;
  slices: number; // 前景を含むスライス数
  // 画素値統計（source 画像が cache にある前景ボクセルのみ。modality LUT 適用後＝CT なら HU）。
  mean?: number;
  sd?: number;
  min?: number;
  max?: number;
  unit?: string;
  valuedVoxels?: number; // 値を読めた前景ボクセル数
  missingValueSlices?: number; // 値を読めない前景スライス数
  meanTimesVolumeMl?: number; // 平均 × 体積(mL)。単位は `${unit}·mL`
}

/**
 * Mask の格子（labelmap と元画像の対応・奥行きの文脈）。Σ³ と計測結果ダイアログで共有し、
 * 体積が両者で必ず同じになるようにする。体積は `depthVolume.maskVolumeFromLabels`（メッシュの角柱）。
 */
interface MaskGrid {
  labelmapIds: string[];
  sourceIds: string[];
  planes: (Plane | null)[];
  colSp: number;
  rowSp: number;
  ctx: MaskDepthContext | null;
}

function maskGrid(segmentationId: string): MaskGrid | null {
  let labelmapIds: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labelmapIds = (csSeg as any).getLabelmapImageIds(segmentationId) as string[];
  } catch {
    return null;
  }
  if (!labelmapIds?.length) return null;
  const sourceIds = labelmapIds.map((id) => img(id)?.referencedImageId as string);
  const planes = sourceIds.map((s) => (s ? planeOf(s) : null));
  const p0 = planes.find(Boolean) as Plane | undefined;
  if (!p0) return null;
  return { labelmapIds, sourceIds, planes, colSp: p0.colSp, rowSp: p0.rowSp, ctx: maskDepthContext(sourceIds) };
}

/** 体積の結果（ctx が作れなければ、深さが決まらないとして出さない）。 */
function meshVolumeOf(
  grid: MaskGrid,
  slices: ReadonlyArray<{ sourceId: string; labels: ArrayLike<number>; width: number; height: number }>,
  segmentIndex?: number,
): MaskMeshVolume {
  if (!grid.ctx) return { depthSource: "unknown", warnings: ["depth-unknown"] };
  return maskVolumeFromLabels(grid.ctx, slices, segmentIndex ?? undefined);
}

/**
 * Mask の体積統計（前景=非ゼロ。`segmentIndex` を渡すとその segment のみに限定）。
 * 体積は、スライスごとの輪郭の角柱（面積 × スライスの幅）。幅は IPP の法線方向の位置から（`fw/slice-depth-policy.md`）。
 * 取得不能なら null。source 画像が cache にあれば前景の画素値統計（mean/SD/min/max, modality LUT 適用）も併せて返す。
 */
export function maskVolumeStats(segmentationId: string, segmentIndex?: number): MaskVolumeStats | null {
  const grid = maskGrid(segmentationId);
  if (!grid) return null;
  const { labelmapIds, sourceIds } = grid;
  const volSlices: Array<{ sourceId: string; labels: ArrayLike<number>; width: number; height: number }> = [];

  // 各スライスの labels と校正済み値を集めて純関数で集計する（校正は pixelCalibration に一元化。
  // scale/offset は preScale 済みなら {1,0}。cache に無いスライスは values=null）。
  const inputs: MaskSliceInput[] = [];
  for (let z = 0; z < labelmapIds.length; z++) {
    const vm = img(labelmapIds[z])?.voxelManager;
    if (!vm) continue;
    const len = vm.getScalarDataLength();
    const labels = new Int32Array(len);
    for (let i = 0; i < len; i++) labels[i] = vm.getAtIndex(i);
    const sImg = sourceIds[z] ? img(sourceIds[z]) : null;
    const px = sImg?.getPixelData?.() as ArrayLike<number> | undefined;
    let values: Float64Array | null = null;
    if (px) {
      const { scale, offset } = getModalityCalibration(sImg, sourceIds[z] ?? "");
      values = new Float64Array(px.length);
      for (let i = 0; i < px.length; i++) values[i] = px[i] * scale + offset;
    }
    inputs.push({ labels, values });
    const pl = grid.planes[z];
    if (sourceIds[z] && pl) volSlices.push({ sourceId: sourceIds[z], labels, width: pl.cols, height: pl.rows });
  }
  const core = accumulateMaskStats(inputs, segmentIndex);
  const { voxels, slices } = core;
  const mv = meshVolumeOf(grid, volSlices, segmentIndex);
  const volumeMm3 = mv.volumeMm3;
  const out: MaskVolumeStats = {
    voxels, volumeMm3, volumeMl: volumeMm3 === undefined ? undefined : volumeMm3 / 1000, slices,
    warnings: mv.warnings, depthSource: mv.depthSource,
    valuedVoxels: core.valuedVoxels, missingValueSlices: core.missingValueSlices,
  };
  if (core.mean !== undefined) {
    out.mean = core.mean;
    out.sd = core.sd;
    out.min = core.min;
    out.max = core.max;
    // 単位は 2D 統計と同じ resolveValueUnit に一元化（SUV→RescaleType→モダリティ既定→"raw"）。
    out.unit = sourceIds[0] ? resolveValueUnit(sourceIds[0]) : "";
    if (out.volumeMl !== undefined) out.meanTimesVolumeMl = core.mean * out.volumeMl;
  }
  return out;
}

/** ROI 計測結果ダイアログに出すマスクの統計（`fw/roi-stats-design.md` §6.3）。 */
export interface MaskStatsResult {
  maskId: string;
  /** 指定した segment の統計のとき、その番号。未指定はマスク全体。 */
  segmentIndex?: number;
  voxels: number;
  slices: number;
  /** メッシュの体積。間隔・奥行きが不明なら undefined。 */
  volumeMm3?: number;
  volumeMl?: number;
  /** 画素の大きさと公称のスライス間隔 [列間隔, 行間隔, スライス間隔] (mm)。間隔が不均一でも体積はスライスごとの幅で求める。 */
  voxelMm: [number, number, number | null];
  /** 値の要約。2D の ROI と同じ {@link summarizeValues}（非有限値は除く）。 */
  values?: RoiValueStats;
  histogram?: HistogramData;
  unit: string;
  /** 平均 × 体積(mL)。単位は `${unit}·mL`。 */
  meanTimesVolumeMl?: number;
  /** 前景を含む最初のスライス。 */
  imageId: string;
  /**
   * `"no-pixels"`: 読めないスライスがあり、値の統計を出していない（体積と別の母集団にしない）。
   * `"spacing-unknown"` / `"depth-unknown"` / `"duplicate-positions"`: 体積を出していない。`"depth-estimated"`: スライス厚からの推定。
   */
  warnings: string[];
}

interface LoadedMaskSlice {
  sliceIndex: number;
  sourceId: string;
  width: number;
  height: number;
  labels: Int32Array;
  values: Float32Array | null;
}

/** 前景のあるスライスだけ、labels と校正済み値（未ロードなら読み込む）を集める。 */
async function loadMaskSlices(grid: MaskGrid, segmentIndex?: number): Promise<LoadedMaskSlice[]> {
  const out: LoadedMaskSlice[] = [];
  for (let z = 0; z < grid.labelmapIds.length; z++) {
    const lm = img(grid.labelmapIds[z]);
    const vm = lm?.voxelManager;
    if (!vm) continue;
    const len = vm.getScalarDataLength();
    const labels = new Int32Array(len);
    let any = false;
    for (let i = 0; i < len; i++) {
      const v = vm.getAtIndex(i);
      labels[i] = v;
      if (isSegmentForeground(v, segmentIndex)) any = true;
    }
    if (!any) continue;
    const sourceId = grid.sourceIds[z] ?? "";
    const slice = sourceId ? await readModalitySlice(sourceId) : null;
    const width = (lm.columns ?? lm.width ?? slice?.width ?? 0) as number;
    const height = (lm.rows ?? lm.height ?? slice?.height ?? 0) as number;
    out.push({ sliceIndex: z, sourceId, width, height, labels, values: slice?.values ?? null });
  }
  return out;
}

/** マスクの統計（**非同期**・元画像が未ロードなら読み込む）。取得不能なら null。 */
export async function computeMaskStatsAsync(
  segmentationId: string,
  opts?: { withHistogram?: boolean; segmentIndex?: number },
): Promise<MaskStatsResult | null> {
  const pre = maskGrid(segmentationId);
  if (!pre) return null;
  await ensureStackMetadata(pre.sourceIds); // 奥行きを決める IPP を揃えてから文脈を作り直す
  const grid = maskGrid(segmentationId) ?? pre;
  const loaded = await loadMaskSlices(grid, opts?.segmentIndex);
  const sample = collectMaskValues(loaded.map((s) => ({ labels: s.labels, values: s.values })), opts?.segmentIndex);
  const imageId = loaded[0]?.sourceId ?? grid.sourceIds.find(Boolean) ?? "";
  const unit = imageId ? resolveValueUnit(imageId) : "";
  const mv = meshVolumeOf(
    grid,
    loaded.map((s) => ({ sourceId: s.sourceId, labels: s.labels, width: s.width, height: s.height })),
    opts?.segmentIndex,
  );
  const volumeMm3 = mv.volumeMm3;
  const g = grid.ctx?.geometry;
  const out: MaskStatsResult = {
    maskId: segmentationId,
    segmentIndex: opts?.segmentIndex,
    voxels: sample.voxels,
    slices: sample.slices,
    volumeMm3,
    volumeMl: volumeMm3 === undefined ? undefined : volumeMm3 / 1000,
    voxelMm: [grid.colSp, grid.rowSp, g && g.source !== "unknown" ? g.nominalSpacing : null],
    unit,
    imageId,
    warnings: [...mv.warnings],
  };
  if (sample.missingValueSlices > 0) {
    out.warnings.push("no-pixels");
    return out;
  }
  const v = summarizeValues(sample.values, unit);
  if (v) {
    out.values = v;
    if (out.volumeMl !== undefined) out.meanTimesVolumeMl = v.mean * out.volumeMl;
    if (opts?.withHistogram) out.histogram = roiHistogram(sample.values, unit) ?? undefined;
  }
  return out;
}

/** マスクの統計に使ったボクセルの CSV（BOM 付き）を塊で返す。取得不能・空なら null。 */
export async function buildMaskVoxelDumpAsync(
  segmentationId: string,
  label: string,
  segmentIndex?: number,
): Promise<string[] | null> {
  const grid = maskGrid(segmentationId);
  if (!grid) return null;
  const loaded = await loadMaskSlices(grid, segmentIndex);
  if (!loaded.length) return null;
  const slices: MaskDumpSlice[] = loaded.map((s) => ({
    sliceIndex: s.sliceIndex,
    imageId: s.sourceId,
    width: s.width,
    labels: s.labels,
    values: s.values,
    plane: dumpPlaneOf(s.sourceId),
  }));
  const unit = resolveValueUnit(loaded[0].sourceId);
  return maskVoxelDumpCsvChunks(slices, { label, maskId: segmentationId, unit, segmentIndex });
}

/** 画素 CSV 用の幾何。IPP/IOP/画素間隔が揃わなければ null（座標セルを空にする。既定値で埋めない）。 */
function dumpPlaneOf(imageId: string): PlaneGeometry | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = imageId ? (metaData.get("imagePlaneModule", imageId) as any) : null;
  const finite3 = (v: ArrayLike<number> | undefined) =>
    !!v && v.length >= 3 && Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);
  const pos = (v: unknown) => typeof v === "number" && v > 0;
  if (!m || !pos(m.rowPixelSpacing) || !pos(m.columnPixelSpacing)) return null;
  if (!finite3(m.imagePositionPatient) || !finite3(m.rowCosines) || !finite3(m.columnCosines)) return null;
  return {
    imagePositionPatient: m.imagePositionPatient,
    rowCosines: m.rowCosines,
    columnCosines: m.columnCosines,
    rowPixelSpacing: m.rowPixelSpacing,
    columnPixelSpacing: m.columnPixelSpacing,
  };
}
