/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 開いたスライスの値が全部同じ（例: 先頭が全画素 0 の PET）で、DICOM に WindowCenter/Width も SUV 校正も無いときの初期の窓。
 *
 * 何が起きていたか: cornerstone は、窓の指定が無いと表示中のスライスの値域で初期の窓を決める。全部同じ値だと窓の幅が 0 になり、
 * vtk の色関数（黒→白）が 1 つの点に潰れる。その後 Auto などで窓を変えると、色関数の位置が NaN になり、
 * 画像が真っ白（反転で真っ黒、LUT によっては赤）になる。LUT を替えると色関数が作り直されて直る。
 * （合成 PET ファントム GNBP-D で、実アプリで再現して確認した。automator/src/spike/petGrayWindowCheck.ts）
 *
 * 直し方（影響を最小にするため、**幅 0 になる場合だけ**）:
 *  1. すぐに、幅のある最小の窓を置く（色関数が潰れないように）。
 *  2. 続けて、シリーズの数枚（等間隔）の値域を読み、幅が出れば、その範囲を初期の窓にする。
 * 値域に幅があるスライスを開いた場合は何もしない（今までと同じ。cornerstone の既定のまま）。
 */
export interface VoiRange {
  readonly lower: number;
  readonly upper: number;
}

/** 窓の幅が 0 にならないための、最小の幅（モダリティ値の単位）。 */
export const FLAT_GUARD_WIDTH = 1;
/** シリーズの値域を見るために読むスライスの最大枚数。 */
export const SERIES_SAMPLE_COUNT = 16;

function finiteRange(values: ArrayLike<number>): VoiRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min <= max ? { lower: min, upper: max } : null;
}

/**
 * スライスの値が全部同じなら、幅のある最小の窓（その値を中心に）を返す。値に幅があれば null（何もしない）。
 * 有限の値が 1 つも無いときも null（窓を決める材料が無い）。
 */
export function flatSliceGuardRange(values: ArrayLike<number> | null | undefined): VoiRange | null {
  if (!values || values.length === 0) return null;
  const r = finiteRange(values);
  if (!r || r.upper > r.lower) return null;
  return { lower: r.lower - FLAT_GUARD_WIDTH / 2, upper: r.upper + FLAT_GUARD_WIDTH / 2 };
}

/** 0..n-1 から、等間隔に最大 count 個の添字を選ぶ（先頭と末尾を含む）。 */
export function sampleSliceIndices(n: number, count: number = SERIES_SAMPLE_COUNT): number[] {
  if (!(n > 0) || !(count > 0)) return [];
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  if (count === 1) return [0];
  const out = new Set<number>();
  for (let i = 0; i < count; i++) out.add(Math.round((i * (n - 1)) / (count - 1)));
  return [...out];
}

/** 各スライスの値域の和集合。幅が出なければ null。 */
export function unionRange(ranges: readonly (VoiRange | null)[]): VoiRange | null {
  let lower = Infinity;
  let upper = -Infinity;
  for (const r of ranges) {
    if (!r) continue;
    if (r.lower < lower) lower = r.lower;
    if (r.upper > upper) upper = r.upper;
  }
  return upper > lower ? { lower, upper } : null;
}

export interface RefineDeps {
  /** シリーズの全 imageId。 */
  readonly imageIds: readonly string[];
  /** imageId の値（モダリティ値）を読む。読めなければ null。 */
  readonly readValues: (imageId: string) => Promise<ArrayLike<number> | null>;
  /** いまの窓。 */
  readonly currentRange: () => VoiRange | null;
  /** 窓を置く。 */
  readonly apply: (range: VoiRange) => void;
  /** 開き直し・差し替えで、この結果が古くなったか。 */
  readonly isStale: () => boolean;
}

/**
 * 置いた最小の窓（guard）を、シリーズの数枚の値域に置き換える。
 * 途中で窓が変わっていたら（利用者が調整した・別のスタックに替わった）、何もしない。
 * @returns 置き換えたら、その窓。置き換えなかったら null。
 */
export async function refineFlatSliceWindow(guard: VoiRange, deps: RefineDeps): Promise<VoiRange | null> {
  const ranges: (VoiRange | null)[] = [];
  for (const i of sampleSliceIndices(deps.imageIds.length)) {
    if (deps.isStale()) return null;
    const values = await deps.readValues(deps.imageIds[i]);
    ranges.push(values ? finiteRange(values) : null);
  }
  const next = unionRange(ranges);
  if (!next || deps.isStale()) return null;
  const cur = deps.currentRange();
  // 利用者が窓を変えていたら、上書きしない（置いた最小の窓のままのときだけ）。
  if (!cur || Math.abs(cur.lower - guard.lower) > 1e-9 || Math.abs(cur.upper - guard.upper) > 1e-9) return null;
  deps.apply(next);
  return next;
}
