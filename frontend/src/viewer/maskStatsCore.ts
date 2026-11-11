/**
 * Mask 3D 統計の集計の芯（Cornerstone に触れない純関数）。
 * `roi3d.maskVolumeStats` が各スライスの labels と校正済み値を渡す。式は従来どおり（Σv, Σv², 母分散）。
 * 設計: fw/roi-manager-design.md §5.1
 */
export interface MaskSliceInput {
  labels: ArrayLike<number>;
  /** 校正済みの値（HU/SUV 等）。読めないスライスは null。 */
  values: ArrayLike<number> | null;
}

export interface MaskStatsCore {
  voxels: number;
  slices: number;
  valuedVoxels: number;
  missingValueSlices: number;
  mean?: number;
  sd?: number;
  min?: number;
  max?: number;
}

/**
 * 前景判定の単一の定義。`segmentIndex` を渡すとその segment の値だけ、無ければ背景(0)以外すべて。
 * 統計・ボクセル CSV・ブール演算・SPLIT がこれを共有する（母集団を食い違わせない）。
 */
export function isSegmentForeground(value: number, segmentIndex?: number): boolean {
  return segmentIndex != null ? value === segmentIndex : value > 0;
}

export function accumulateMaskStats(slices: MaskSliceInput[], segmentIndex?: number): MaskStatsCore {
  let voxels = 0, nSlices = 0, valued = 0, missing = 0;
  let sum = 0, sumSq = 0, vmin = Infinity, vmax = -Infinity;
  for (const s of slices) {
    const len = s.labels.length;
    const vals = s.values;
    let count = 0, unread = 0;
    for (let i = 0; i < len; i++) {
      if (!isSegmentForeground(s.labels[i], segmentIndex)) continue;
      count++;
      if (vals && i < vals.length) {
        const v = vals[i];
        sum += v;
        sumSq += v * v;
        valued++;
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      } else {
        unread++;
      }
    }
    if (count > 0) nSlices++;
    if (unread > 0) missing++;
    voxels += count;
  }
  const out: MaskStatsCore = { voxels, slices: nSlices, valuedVoxels: valued, missingValueSlices: missing };
  // 値を読めないスライスがあれば値の統計は出さない（体積と平均が別の母集団になるのを防ぐ）。
  if (valued > 0 && missing === 0) {
    const mean = sum / valued;
    out.mean = mean;
    out.sd = Math.sqrt(Math.max(0, sumSq / valued - mean * mean));
    out.min = vmin;
    out.max = vmax;
  }
  return out;
}

/**
 * 平均×体積の行の語。SUV 系（体積あたりの濃度を体重などで割った量）は TLG、%ID/cc は VOI 内の
 * 注入量割合（%ID）。それ以外（SUVR などの比、Bq/mL、HU）は null（行を出さない）。
 * 列挙は完全一致: 前方一致にすると、新しい単位（SUVR）に TLG が出てしまう。
 */
export function meanTimesVolumeLabelKey(unit: string | undefined): "roiMgr.statTlg" | "roiMgr.statPctId" | null {
  switch (unit) {
    case "SUVbw":
    case "SUVlbm":
    case "SUVbsa":
      return "roiMgr.statTlg";
    case "%ID/cc":
      return "roiMgr.statPctId";
    default:
      return null;
  }
}

/** 平均×体積の単位の表記。%ID/cc × mL は注入量の割合そのもの（%ID）。 */
export function meanTimesVolumeUnit(unit: string | undefined): string {
  return unit === "%ID/cc" ? "%ID" : `${unit ?? ""}·mL`;
}

export interface MaskValueSample {
  voxels: number;
  slices: number;
  /** 値を読めなかった前景スライス数。0 でなければ `values` は母集団の一部しか持たない。 */
  missingValueSlices: number;
  /** 前景ボクセルの値（スライス順）。非有限値も含む（除外は要約側で行う）。 */
  values: Float64Array;
}

/**
 * 前景（label &gt; 0、`segmentIndex` 指定時はその segment のみ）の値を 1 本に集める。
 * ROI 計測結果ダイアログが `summarizeValues` へ渡す母集団。
 * 数え方（voxels / slices）は {@link accumulateMaskStats} と同じ。
 */
export function collectMaskValues(slices: MaskSliceInput[], segmentIndex?: number): MaskValueSample {
  let voxels = 0, nSlices = 0, missing = 0;
  for (const s of slices) {
    let count = 0, unread = 0;
    for (let i = 0; i < s.labels.length; i++) {
      if (!isSegmentForeground(s.labels[i], segmentIndex)) continue;
      count++;
      if (!s.values || i >= s.values.length) unread++;
    }
    if (count > 0) nSlices++;
    if (unread > 0) missing++;
    voxels += count;
  }
  const values = new Float64Array(voxels);
  let k = 0;
  for (const s of slices) {
    const vals = s.values;
    for (let i = 0; i < s.labels.length; i++) {
      if (!isSegmentForeground(s.labels[i], segmentIndex)) continue;
      values[k++] = vals && i < vals.length ? vals[i] : NaN;
    }
  }
  return { voxels, slices: nSlices, missingValueSlices: missing, values };
}
