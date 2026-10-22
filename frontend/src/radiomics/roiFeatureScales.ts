/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 空間スケール（LoG で強調する構造の半径 r、mm）を複数回す計算の、入力の解析と CSV。
 *
 * <p>CSV は縦長で、スケールごとに 1 行（3D の表）。各行は、そのスケールの抽出の全特徴をそのまま持つので、
 * スケールごとの設定ファイルを RadiomicsJ に読ませた抽出と全特徴が一致する。LoG の列名はスケール（σ）ごとに
 * 違うため、列は全スケールの和集合にして、そのスケールに無い列は空にする（0 と書かない）。
 * フィルタの列（`Filter_*`）は記録の列・ROI の大きさの列の後に置く。フィルタを使わない行は
 * `Filter_Kind=none` で、他の列は空。
 */
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import { cell } from "../viewer/roiStatsCsv";
import {
  ROI_FEATURE_RECORD_COLUMNS, ROI_FEATURE_SIZE_COLUMNS, parseSettingsProperties,
  recordValuesOf, roiFeatureDefinitionsCsv, sizeValuesOf, value,
} from "./roiFeatureCsv";
import { roiFeature2dFiles, type CsvFile } from "./roiFeatureModes";

export const FILTER_COLUMNS = [
  "Filter_Kind",
  "Filter_ScaleMm",
  "Filter_SigmaMm",
  "Filter_ScaleToSigma",
  "Filter_Dimension",
  "Filter_TruncateSigma",
  "Filter_Boundary",
] as const;

/** そのスケールの行のフィルタの 7 列の値。r=0（フィルタなし）は種類と r だけで、他は空。 */
export function filterValuesOf(e: NonNullable<RoiFeatureResult["scales"]>[number]): string[] {
  if (e.sigma3dMm == null) return ["none", String(e.scaleMm), "", "", "", "", ""];
  const p = parseSettingsProperties(e.result.settingsProperties);
  const conversion = e.conversion === "COEFFICIENT" && e.coefficient != null
    ? `COEFFICIENT:${e.coefficient}` : e.conversion;
  return [
    "LoG", String(e.scaleMm), String(e.sigma3dMm), conversion, "3D", p.DOUBLE_logTruncate ?? "", p.STRING_logPadding ?? "",
  ];
}

/** 全スケールの行を、列名の初出の順に並べた和集合（データ表・定義表の列）。 */
export function unionRows(full: RoiFeatureResult): RoiFeatureRow[] {
  const seen = new Set<string>();
  const out: RoiFeatureRow[] = [];
  for (const e of full.scales ?? []) {
    for (const r of e.result.rows) {
      if (seen.has(r.column)) continue;
      seen.add(r.column);
      out.push(r);
    }
  }
  return out;
}

/** スケールごとの縦長のデータ表。 */
export function roiFeatureScaledDataCsv(full: RoiFeatureResult, caseLabel = ""): string {
  const scales = full.scales ?? [];
  const columns = unionRows(full).map((r) => r.column);
  const header = [...ROI_FEATURE_RECORD_COLUMNS, ...ROI_FEATURE_SIZE_COLUMNS, ...FILTER_COLUMNS, ...columns]
    .map(cell).join(",");
  const lines = scales.map((e) => {
    const byColumn = new Map(e.result.rows.map((r) => [r.column, r.value]));
    return [
      ...recordValuesOf(e.result.provenance, caseLabel),
      ...sizeValuesOf(e.result.roiSize),
      ...filterValuesOf(e).map(cell),
      ...columns.map((c) => (byColumn.has(c) ? value(byColumn.get(c)!) : "")),
    ].join(",");
  });
  return `${header}\r\n${lines.join("\r\n")}\r\n`;
}

/** 定義表（全スケールの列の和集合）。フィルタの列も載せる。 */
export function roiFeatureScaledDefinitionsCsv(full: RoiFeatureResult): string {
  const base = roiFeatureDefinitionsCsv({ ...full, rows: unionRows(full) });
  const lines = base.trimEnd().split("\r\n");
  // 記録の列・ROI の大きさの列の定義の後ろ（特徴の行の前）にフィルタの列を足す
  const at = 1 + ROI_FEATURE_RECORD_COLUMNS.length + ROI_FEATURE_SIZE_COLUMNS.length;
  const extra = FILTER_COLUMNS.map((c) => {
    const [family, feature] = c.split("_");
    return [cell(c), cell(family), cell(feature), "", "", ""].join(",");
  });
  lines.splice(at, 0, ...extra);
  return `${lines.join("\r\n")}\r\n`;
}

/** ファイル名に入れるスケールの印（`r2`・`r2.5`）。 */
export const scaleTag = (scaleMm: number) => `r${scaleMm}`;

/** スケールごとの設定ファイル（接尾辞つき。3D の本文を一字も変えずに）。 */
export function scaleSettingsFiles(full: RoiFeatureResult): CsvFile[] {
  return (full.scales ?? []).map((e) => ({
    suffix: `-${scaleTag(e.scaleMm)}_radiomicsj.properties`,
    text: e.result.settingsProperties,
    mime: "text/plain;charset=utf-8",
  }));
}

/** 2D の単位のファイル（スケールごとに別ファイル。列は 2D の CSV のまま）。 */
export function scale2dFiles(full: RoiFeatureResult, caseLabel = ""): CsvFile[] {
  const out: CsvFile[] = [];
  for (const e of full.scales ?? []) {
    for (const f of roiFeature2dFiles(e.result, caseLabel)) {
      out.push({ ...f, suffix: `-${scaleTag(e.scaleMm)}${f.suffix}` });
    }
  }
  return out;
}
