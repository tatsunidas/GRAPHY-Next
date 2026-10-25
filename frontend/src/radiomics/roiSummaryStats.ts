/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 結果の表の上に出す「6 統計」と「副次量」のまとめ欄の行。値は結果の表（RadiomicsJ の列）の同じ行を引くだけで、
 * ここでは計算しない。フィルタ後（`log_sigma…`）の列は引かない（元の画像の列だけ）。
 */
import type { RoiFeatureRow } from "../api";

export interface SummaryDef {
  /** 画面に出す名前。 */
  label: string;
  /** RadiomicsJ の列名。 */
  column: string;
}

export const SIX_STATISTICS: readonly SummaryDef[] = [
  { label: "Mean", column: "IntensityBasedStatistical_Mean" },
  { label: "SD", column: "IntensityBasedStatistical_StandardDeviation" },
  { label: "Entropy", column: "IntensityHistogram_Entropy" },
  { label: "MPP", column: "AuxiliaryStatistics_MeanOfPositiveIntensities" },
  { label: "Skewness", column: "IntensityBasedStatistical_Skewness" },
  { label: "Kurtosis", column: "IntensityBasedStatistical_Kurtosis" },
];

export const SECONDARY_QUANTITIES: readonly SummaryDef[] = [
  { label: "Variance", column: "IntensityBasedStatistical_Variance" },
  { label: "Uniformity", column: "IntensityHistogram_Uniformity" },
  { label: "PPP", column: "AuxiliaryStatistics_ProportionOfPositiveIntensities" },
  { label: "nSD", column: "AuxiliaryStatistics_NormalisedStandardDeviation" },
  { label: "UPP", column: "AuxiliaryStatistics_UniformityOfPositiveIntensities" },
  { label: "1/(kurtosis+3)", column: "AuxiliaryStatistics_ReciprocalKurtosis" },
];

export interface SummaryLine {
  label: string;
  row: RoiFeatureRow;
}

/** 定義のうち、結果にある列だけを並びのまま返す（その族を計算していなければ行は出ない）。 */
export function summaryLines(rows: readonly RoiFeatureRow[], defs: readonly SummaryDef[]): SummaryLine[] {
  const byColumn = new Map(rows.map((r) => [r.column, r]));
  return defs.flatMap((d) => {
    const row = byColumn.get(d.column);
    return row ? [{ label: d.label, row }] : [];
  });
}
