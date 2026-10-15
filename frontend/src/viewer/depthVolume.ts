/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 奥行きの方針（`fw/slice-depth-policy.md`）を 3D / MPR の体積と ROI の体積に適用する純関数群。
 */
import type { DepthSource, SliceGeometry } from "./sliceGeometry";
import { roiVolumeFromSlices, type RoiVolumeResult } from "./roiVolumeMesh";

/** 同じ位置に重なるスライスがあるシリーズは体積を組まない。 */
export class SliceDuplicatesError extends Error {
  constructor() {
    super("duplicate slice positions");
    this.name = "SliceDuplicatesError";
  }
}

/**
 * 不均一な並びを均一な格子（間隔 = 最小の間隔）に取り直す。奥行き方向だけの線形補間。
 *
 * @param slices 元スライスの値（奥行きの順）。校正済みのモダリティ値。
 * @param positions 元スライスの位置（mm、昇順）
 * @param grid 格子（`regularGrid`）。元スライスは最寄りの格子点に置き（`gridIndexOf`）、そのまま写す。
 *   それ以外の格子点は、前後の元スライスの位置との距離で線形補間する。
 */
export function interpolateToGrid(
  slices: ReadonlyArray<ArrayLike<number>>,
  positions: ReadonlyArray<number>,
  grid: { count: number; spacing: number; origin: number; gridIndexOf: ReadonlyArray<number> },
  sliceLen: number,
): { data: Float32Array; original: boolean[] } {
  const data = new Float32Array(sliceLen * grid.count);
  const original: boolean[] = new Array(grid.count).fill(false);
  const srcOf = new Map<number, number>();
  grid.gridIndexOf.forEach((j, i) => srcOf.set(j, i));
  let lo = 0; // 前の元スライス（j が増える向きに進める）
  for (let j = 0; j < grid.count; j++) {
    const base = j * sliceLen;
    const exact = srcOf.get(j);
    if (exact !== undefined) {
      const s = slices[exact];
      for (let k = 0; k < sliceLen; k++) data[base + k] = s[k];
      original[j] = true;
      continue;
    }
    const z = grid.origin + j * grid.spacing;
    while (lo + 2 < positions.length && positions[lo + 1] <= z) lo++;
    const a = slices[lo], b = slices[Math.min(lo + 1, slices.length - 1)];
    const span = positions[Math.min(lo + 1, positions.length - 1)] - positions[lo];
    const t = span > 0 ? Math.min(1, Math.max(0, (z - positions[lo]) / span)) : 0;
    for (let k = 0; k < sliceLen; k++) data[base + k] = a[k] * (1 - t) + b[k] * t;
  }
  return { data, original };
}

export type VolumeDepthNote =
  | { id: "missing"; n: number }
  | { id: "irregular"; from: number; to: number; spacing: number }
  | { id: "sbs" | "thickness" | "unknown" };

/** ヘッダに出す奥行きの注記。何も言うことが無い（IPP で均一）ときは null。 */
export function volumeDepthNote(
  g: SliceGeometry,
  grid?: { count: number; spacing: number } | null,
): VolumeDepthNote | null {
  if (g.kind === "missing") return { id: "missing", n: g.missingCount };
  if (g.kind === "irregular") {
    return { id: "irregular", from: g.order.length, to: grid?.count ?? g.order.length, spacing: grid?.spacing ?? g.minSpacing };
  }
  if (g.source === "sbs" || g.source === "thickness" || g.source === "unknown") return { id: g.source };
  return null;
}

/** SOP → 体積の格子番号。`gridIndexOf` が無ければ並び順の番号（均一な体積）。 */
export function sopGridIndexMap(
  sops: ReadonlyArray<string | null | undefined>,
  gridIndexOf?: ReadonlyArray<number>,
): Map<string, number> {
  const m = new Map<string, number>();
  sops.forEach((s, i) => {
    if (s && !m.has(s)) m.set(s, gridIndexOf ? gridIndexOf[i] : i);
  });
  return m;
}

export interface DepthVolumeStatus {
  /** mL を出してよいか。 */
  volumeKnown: boolean;
  /** 注意書きのキー（`roiStats.warn.*`）。 */
  warnings: string[];
}

/** 体積を出せるか、出すときの注意は何か。 */
export function depthVolumeStatus(source: DepthSource, kind: SliceGeometry["kind"], spacingKnown: boolean): DepthVolumeStatus {
  const warnings: string[] = [];
  let volumeKnown = true;
  if (!spacingKnown) {
    warnings.push("spacing-unknown");
    volumeKnown = false;
  }
  if (source === "unknown") {
    warnings.push("depth-unknown");
    volumeKnown = false;
  } else if (source === "thickness") {
    warnings.push("depth-estimated");
  }
  if (kind === "duplicates") {
    warnings.push("duplicate-positions");
    volumeKnown = false;
  }
  return { volumeKnown, warnings };
}

export interface StackLabelSlice {
  /** 奥行きを決めた入力（スタック）の中での添字。 */
  stackIndex: number;
  labels: ArrayLike<number>;
  width: number;
  height: number;
}

/**
 * スタックの各スライスのラベルから、メッシュ（角柱）の体積を求める。
 * スライスの幅は `sliceGeometry().widths`（奥行きの順）から、`stackIndex` の位置で引く。
 */
export function maskVolumeFromGeometry(
  slices: ReadonlyArray<StackLabelSlice>,
  g: SliceGeometry,
  colSpacingMm: number,
  rowSpacingMm: number,
  segment?: number,
): RoiVolumeResult {
  const posOfStack = new Map<number, number>();
  g.order.forEach((stackIndex, pos) => posOfStack.set(stackIndex, pos));
  return roiVolumeFromSlices(
    slices.map((s) => ({
      labels: s.labels,
      width: s.width,
      height: s.height,
      colSpacingMm,
      rowSpacingMm,
      widthMm: g.widths[posOfStack.get(s.stackIndex) ?? 0],
    })),
    segment,
  );
}

/**
 * 3D の labelmap（格子の z-major）から体積を求める。元スライスに当たる格子の面だけを使い、
 * 補間した面は使わない。`gridIndexOf`・`widths` は奥行きの順。省略すると全面を等幅（`spacingZ`）で扱う。
 */
export function labelVolumeMeshVolume(
  data: ArrayLike<number>,
  dims: readonly [number, number, number],
  spacing: readonly [number, number, number],
  depth?: { gridIndexOf: ReadonlyArray<number>; widths: ReadonlyArray<number> },
  segment?: number,
): RoiVolumeResult {
  const [nx, ny, nz] = dims;
  const sliceLen = nx * ny;
  const take = (k: number) => (data as { subarray?: (a: number, b: number) => ArrayLike<number> }).subarray?.(k * sliceLen, (k + 1) * sliceLen)
    ?? Array.prototype.slice.call(data, k * sliceLen, (k + 1) * sliceLen);
  const items = depth
    ? depth.gridIndexOf.map((k, i) => ({ k, w: depth.widths[i] }))
    : Array.from({ length: nz }, (_, k) => ({ k, w: spacing[2] }));
  return roiVolumeFromSlices(
    items
      .filter((it) => it.k >= 0 && it.k < nz)
      .map((it) => ({ labels: take(it.k), width: nx, height: ny, colSpacingMm: spacing[0], rowSpacingMm: spacing[1], widthMm: it.w })),
    segment,
  );
}

/** マスクの体積を求める文脈（スタックの奥行き・画素の間隔）。 */
export interface MaskDepthContext {
  /** スタックの imageId → 奥行きを決めた入力の添字。 */
  indexOfSource: ReadonlyMap<string, number>;
  geometry: SliceGeometry;
  colSp: number;
  rowSp: number;
  /** PixelSpacing があったか。 */
  spacingKnown: boolean;
}

export interface MaskMeshVolume {
  /** 出せないとき（間隔が不明など）は undefined。0 で埋めない。 */
  volumeMm3?: number;
  depthSource: DepthSource;
  warnings: string[];
}

/**
 * 塗りの体積を、スライスごとの輪郭の角柱（面積 × スライスの幅）で求める。
 * 2D の Σ³・Σ の窓・ウィンドウ間で渡す 3D 用の値は、すべてこれ。
 * `sourceId` が文脈のスタックに無いスライスに前景があるときは幅が決まらないので体積を出さない。
 */
export function maskVolumeFromLabels(
  ctx: MaskDepthContext,
  slices: ReadonlyArray<{ sourceId: string; labels: ArrayLike<number>; width: number; height: number }>,
  segment?: number,
): MaskMeshVolume {
  const st = depthVolumeStatus(ctx.geometry.source, ctx.geometry.kind, ctx.spacingKnown);
  const warnings = [...st.warnings];
  const out: MaskMeshVolume = { depthSource: ctx.geometry.source, warnings };
  if (!st.volumeKnown) return out;
  const fg = (v: number) => (segment === undefined ? v > 0 : v === segment);
  const used: StackLabelSlice[] = [];
  for (const s of slices) {
    let any = false;
    for (let i = 0; i < s.labels.length; i++) if (fg(s.labels[i])) { any = true; break; }
    if (!any) continue;
    const idx = ctx.indexOfSource.get(s.sourceId);
    if (idx === undefined) {
      if (!warnings.includes("depth-unknown")) warnings.push("depth-unknown");
      return out;
    }
    used.push({ stackIndex: idx, labels: s.labels, width: s.width, height: s.height });
  }
  out.volumeMm3 = maskVolumeFromGeometry(used, ctx.geometry, ctx.colSp, ctx.rowSp, segment).volumeMm3;
  return out;
}
