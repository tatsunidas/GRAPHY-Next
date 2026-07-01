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
import { createResultSeg, resolveRoiStack } from "./roiBooleanOps";
import { getRoiMaskMeta, setRoiMaskMeta } from "./roiMaskStore";
import { addSphere3D, getSphere3D } from "./sphere3dStore";

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
const MAX_SLICE_MASKS = 64; // 3D→2D split の出力上限。
let sliceSeq = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function img(id: string): any {
  return cache.getImage(id);
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

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

/** world → 画素 [x(列), y(行)]（worldToImageCoords と同規約。slice 平面へ射影）。 */
function worldToPx(p: Plane, w: V3): [number, number] {
  // newOrigin = ipp - rowCos*rowSp/2 - colCos*colSp/2（worldToImageCoords と同じ）
  const r = p.rowCos, c = p.colCos;
  const o: V3 = [
    p.ipp[0] - r[0] * (p.rowSp / 2) - c[0] * (p.colSp / 2),
    p.ipp[1] - r[1] * (p.rowSp / 2) - c[1] * (p.colSp / 2),
    p.ipp[2] - r[2] * (p.rowSp / 2) - c[2] * (p.colSp / 2),
  ];
  const d = sub(w, o);
  return [dot(d, r) / p.rowSp, dot(d, c) / p.colSp];
}

/**
 * 3D 球（中心 world + 半径 mm）をボリューム labelmap にラスタ化し新規 Mask を返す（GRAPHY SphereRoi3D→mask）。
 * `refImageId` は球が属するスタックを解決するための任意の 1 スライス imageId（作成スライス等）。
 * 解決不能/交差ゼロなら null。`scopeFromId` があれば meta(patient/series/scope) を継承。
 */
export async function rasterizeSphereToMask(
  center: V3,
  radiusMm: number,
  refImageId: string,
  label: string,
  scopeFromId?: string,
): Promise<string | null> {
  if (!(radiusMm > 0)) return null;
  const stack = resolveRoiStack(refImageId);
  if (!stack) return null;
  const planes = stack.sourceIds.map(planeOf);
  if (planes.some((p) => !p)) return null;
  const p0 = planes[0] as Plane;
  const normal = norm(cross(p0.rowCos, p0.colCos));

  const res = await createResultSeg(stack.sourceIds, stack.viewportIds, label, scopeFromId ?? "");
  if (!res) return null;

  const modified: number[] = [];
  for (let z = 0; z < stack.sourceIds.length; z++) {
    const pl = planes[z] as Plane;
    const d = dot(sub(center, pl.ipp), normal); // 球中心からスライス平面までの符号付き距離
    if (Math.abs(d) > radiusMm) continue;
    const crossR = Math.sqrt(Math.max(0, radiusMm * radiusMm - d * d)); // 断面円半径(mm)
    const vm = img(res.labelmapIds[z])?.voxelManager;
    const cols = pl.cols, rows = pl.rows;
    if (!vm || !cols || !rows) continue;
    const [cx, cy] = worldToPx(pl, center);
    const rx = crossR / pl.rowSp, ry = crossR / pl.colSp; // 画素半径（異方性対応）
    const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(cols - 1, Math.ceil(cx + rx));
    const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(rows - 1, Math.ceil(cy + ry));
    let touched = false;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - cx) / (rx || 0.5), ny = (y + 0.5 - cy) / (ry || 0.5);
        if (nx * nx + ny * ny <= 1) {
          vm.setAtIndex(y * cols + x, 1);
          touched = true;
        }
      }
    }
    if (touched) modified.push(z);
  }
  if (modified.length === 0) return null;
  csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(res.segId, modified, 1);
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
  return rasterizeSphereToMask(p.center, p.radiusMm, p.refId, p.label || "Sphere", annotationUid);
}

/**
 * 円 ROI から**パラメトリック 3D 球（Sphere3D）**を作成しストアへ登録（全スライスにライブ断面円プレビュー）。
 * 患者/シリーズ/scope は円 ROI のメタ（作成時に紐付け済）から継承。作成した sphereId を返す。
 */
export function createSphere3DFromCircleRoi(annotationUid: string): string | null {
  const p = circleParams(annotationUid);
  if (!p) return null;
  const meta = getRoiMaskMeta(annotationUid);
  const sc = meta?.scope;
  return addSphere3D({
    studyUid: sc?.studyUid ?? "",
    seriesUid: sc?.seriesUid ?? "",
    refImageId: p.refId,
    center: p.center,
    radiusMm: p.radiusMm,
    c: sc?.c ?? "all",
    t: sc?.t ?? "all",
    patientKey: meta?.patientKey ?? "",
    seriesLabel: meta?.seriesLabel,
    label: p.label || "Sphere",
    color: "#00e5ff",
    visible: true,
  });
}

/** パラメトリック Sphere3D を Mask にラスタ化（焼き込み）。patient/series/scope を継承。 */
export async function bakeSphere3D(sphereId: string): Promise<string | null> {
  const s = getSphere3D(sphereId);
  if (!s) return null;
  const segId = await rasterizeSphereToMask(s.center, s.radiusMm, s.refImageId, s.label || "Sphere");
  if (!segId) return null;
  const scope = { studyUid: s.studyUid, seriesUid: s.seriesUid, z: "all" as const, c: s.c, t: s.t };
  setRoiMaskMeta(segId, {
    patientKey: s.patientKey,
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
export async function splitMaskToSlices(segmentationId: string): Promise<string[]> {
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
    for (let i = 0; i < len; i++) if (srcVm.getAtIndex(i) > 0) { any = true; break; }
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
    // ボクセルを当該スライスへコピー（segment index を保持）。
    const outVm = img(labelmapId)?.voxelManager;
    if (outVm) for (let i = 0; i < len; i++) { const v = srcVm.getAtIndex(i); if (v > 0) outVm.setAtIndex(i, v); }
    const scope = base?.scope ? { ...base.scope, z } : { z };
    setRoiMaskMeta(segId, {
      patientKey: base?.patientKey,
      seriesLabel: base?.seriesLabel,
      scope,
      origin: scope,
      label: `${base?.label ?? "Mask"} z${z}`,
    });
    csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(segId, [0], undefined);
    created.push(segId);
  }
  return created;
}

export interface MaskVolumeStats {
  voxels: number;
  volumeMm3: number;
  volumeMl: number;
  slices: number; // 前景を含むスライス数
  // 画素値統計（source 画像が cache にある前景ボクセルのみ。modality LUT 適用後＝CT なら HU）。
  mean?: number;
  sd?: number;
  min?: number;
  max?: number;
  unit?: string;
}

/**
 * Mask の体積統計（前景=非ゼロ）。ボクセル体積 = rowSp×colSp×sliceSp。
 * sliceSp は隣接スライス IPP の法線方向距離（無ければスライス厚→1）。取得不能なら null。
 * source 画像が cache にあれば前景の画素値統計（mean/SD/min/max, modality LUT 適用）も併せて返す。
 */
export function maskVolumeStats(segmentationId: string): MaskVolumeStats | null {
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
  const normal = norm(cross(p0.rowCos, p0.colCos));

  // スライス間隔: 最初に取れる隣接 2 スライスの IPP 法線距離。
  let sliceSp = 0;
  for (let z = 0; z + 1 < planes.length; z++) {
    const a = planes[z], b = planes[z + 1];
    if (a && b) {
      sliceSp = Math.abs(dot(sub(b.ipp, a.ipp), normal));
      if (sliceSp > 0) break;
    }
  }
  if (!(sliceSp > 0)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m = (sourceIds[0] && (metaData.get("imagePlaneModule", sourceIds[0]) as any)) || null;
    sliceSp = (m?.sliceThickness as number) || 1;
  }
  const voxelMm3 = p0.rowSp * p0.colSp * sliceSp;

  let voxels = 0, slices = 0;
  // 画素値統計の集計。
  let sum = 0, sumSq = 0, valCount = 0, vmin = Infinity, vmax = -Infinity;
  for (let z = 0; z < labelmapIds.length; z++) {
    const vm = img(labelmapIds[z])?.voxelManager;
    if (!vm) continue;
    const len = vm.getScalarDataLength();
    // source 画素（modality LUT 適用後）。cache に無ければ画素値統計はスキップ。
    const sImg = sourceIds[z] ? img(sourceIds[z]) : null;
    const px = sImg?.getPixelData?.() as ArrayLike<number> | undefined;
    const slope = (sImg?.slope ?? 1) as number;
    const intercept = (sImg?.intercept ?? 0) as number;
    let sliceCount = 0;
    for (let i = 0; i < len; i++) {
      if (vm.getAtIndex(i) <= 0) continue;
      sliceCount++;
      if (px && i < px.length) {
        const v = px[i] * slope + intercept;
        sum += v;
        sumSq += v * v;
        valCount++;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
    }
    if (sliceCount > 0) slices++;
    voxels += sliceCount;
  }
  const volumeMm3 = voxels * voxelMm3;
  const out: MaskVolumeStats = { voxels, volumeMm3, volumeMl: volumeMm3 / 1000, slices };
  if (valCount > 0) {
    const mean = sum / valCount;
    out.mean = mean;
    out.sd = Math.sqrt(Math.max(0, sumSq / valCount - mean * mean));
    out.min = vmin;
    out.max = vmax;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gs = (sourceIds[0] && (metaData.get("generalSeriesModule", sourceIds[0]) as any)) || null;
    out.unit = gs?.modality === "CT" ? "HU" : "";
  }
  return out;
}
