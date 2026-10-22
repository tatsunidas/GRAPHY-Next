/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 特徴量: 計算の単位（全腫瘍 3D・最大断面 2D・スライス別 2D）を並べる表と、2D の CSV。
 *
 * <p>既存の 3D の CSV（{@link ./roiFeatureCsv}）は変えず、2D は単位ごとに別のファイルにする。どのファイルも
 * 先頭は記録 5 列（3D と同じ並び）なので、症例ごとに `CaseLabel` で結合できる。2D で計算しない列
 * （Morphology・GLAM）は列を作らない（空や NaN で埋めない）。
 */
import type {
  RoiFeatureDiscretisation,
  RoiFeatureResult,
  RoiFeatureRow,
  RoiFeatureSliceRow,
  RoiFeatureSlices,
  RoiFeatureSection,
} from "../api";
import { cell } from "../viewer/roiStatsCsv";
import { ROI_FEATURE_RECORD_COLUMNS, ROI_FEATURE_SIZE_COLUMNS, discretisationOf, recordValuesOf, sizeValuesOf, value } from "./roiFeatureCsv";

/** 並べた表の 1 行。undefined は「その単位では計算しない」、null は「計算したが NaN」。 */
export interface CompareRow {
  column: string;
  family: string;
  feature: string;
  ibsi: string | null;
  notes: string[];
  whole: number | null | undefined;
  section: number | null | undefined;
  sliceMean: number | null | undefined;
  sliceWeighted: number | null | undefined;
}

function indexOf(rows: RoiFeatureRow[] | undefined): Map<string, RoiFeatureRow> {
  return new Map((rows ?? []).map((r) => [r.column, r]));
}

/**
 * 3 単位を 1 つの表にする。3D の行の並びを先頭に、3D に無い列（Shape2D など）を 2D の並びで後ろに足す。
 * 単位を選ばなかった列は常に undefined（画面では「—」）。
 */
export function compareRows(result: RoiFeatureResult): CompareRow[] {
  const whole = indexOf(result.rows);
  const section = result.section ? indexOf(result.section.rows) : null;
  const mean = result.slices ? indexOf(result.slices.mean) : null;
  const weighted = result.slices ? indexOf(result.slices.pixelWeightedMean) : null;
  const order: RoiFeatureRow[] = [...result.rows];
  const seen = new Set(order.map((r) => r.column));
  for (const src of [result.section?.rows, result.slices?.mean]) {
    for (const r of src ?? []) {
      if (!seen.has(r.column)) {
        seen.add(r.column);
        order.push(r);
      }
    }
  }
  const pick = (m: Map<string, RoiFeatureRow> | null, c: string): number | null | undefined => {
    if (!m) return undefined;
    const r = m.get(c);
    return r ? r.value : undefined;
  };
  return order.map((r) => ({
    column: r.column,
    family: r.family,
    feature: r.feature,
    ibsi: r.ibsi,
    notes: r.notes,
    whole: pick(whole, r.column),
    section: pick(section, r.column),
    sliceMean: pick(mean, r.column),
    sliceWeighted: pick(weighted, r.column),
  }));
}

/** 2D の離散化の書き方。2D は 1 枚ごとに前処理するので、固定ビン数でもビンの境界はスライスごとに決まる。 */
export function discretisationOf2d(family: string, d: RoiFeatureDiscretisation): string {
  const raw = discretisationOf(family, d);
  return raw && raw.startsWith("ivh") ? raw : raw ? `${raw};scope=per-slice` : "";
}

const colName = (rows: RoiFeatureRow[]) => rows.map((r) => r.column);

/** 最大断面 2D の CSV。3D と同じ並び（記録 5 列・大きさ 6 列・特徴）に最大断面の 3 列を挟む。1 行。 */
export function roiFeatureSectionCsv(sec: RoiFeatureSection, caseLabel = ""): string {
  const extra = ["Section_PositionMm", "Section_AreaMm2", "Section_Pixels"];
  const header = [...ROI_FEATURE_RECORD_COLUMNS, ...ROI_FEATURE_SIZE_COLUMNS, ...extra, ...colName(sec.rows)]
    .map(cell).join(",");
  const size = sec.roiSize
    ? sizeValuesOf(sec.roiSize)
    : ROI_FEATURE_SIZE_COLUMNS.map(() => "");
  const values = [
    ...recordValuesOf(sec.record.provenance, caseLabel),
    ...size,
    String(sec.positionMm), String(sec.areaMm2), String(sec.pixels),
    ...sec.rows.map((r) => value(r.value)),
  ].join(",");
  return `${header}\r\n${values}\r\n`;
}

/** スライス別 2D の CSV。前景のあるスライスごとに 1 行（位置の昇順）。 */
export function roiFeatureSlicesCsv(sl: RoiFeatureSlices, caseLabel = ""): string {
  const extra = ["Slice_PositionMm", "Slice_AreaMm2", "Slice_Pixels"];
  const cols = columnsOf(sl.rows);
  const header = [...ROI_FEATURE_RECORD_COLUMNS, ...extra, ...cols].map(cell).join(",");
  const lines = [header];
  for (const r of sl.rows) {
    const byCol = indexOf(r.rows);
    lines.push([
      ...recordValuesOf(sl.record.provenance, caseLabel),
      String(r.positionMm), String(r.areaMm2), String(r.pixels),
      ...cols.map((c) => (byCol.has(c) ? value(byCol.get(c)!.value) : "")),
    ].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

function columnsOf(rows: RoiFeatureSliceRow[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const x of r.rows) {
      if (!seen.has(x.column)) {
        seen.add(x.column);
        out.push(x.column);
      }
    }
  }
  return out;
}

/**
 * 集約の CSV。`Aggregate` 列が mean（単純平均）・pixelWeightedMean（強度マスクの画素数で重み付け）・slicesUsed
 * （列ごとに使ったスライス数）。前景のスライス数と失敗数は全行に同じ値を置く。
 */
export function roiFeatureAggregateCsv(sl: RoiFeatureSlices, caseLabel = ""): string {
  const cols = colName(sl.mean);
  const header = [...ROI_FEATURE_RECORD_COLUMNS, "Slices_Foreground", "Slices_Failed", "Aggregate", ...cols]
    .map(cell).join(",");
  const lead = (name: string) => [
    ...recordValuesOf(sl.record.provenance, caseLabel),
    String(sl.foregroundSlices), String(sl.failures.length), name,
  ];
  const w = indexOf(sl.pixelWeightedMean);
  return [
    header,
    [...lead("mean"), ...sl.mean.map((r) => value(r.value))].join(","),
    [...lead("pixelWeightedMean"), ...cols.map((c) => value(w.get(c)?.value ?? null))].join(","),
    [...lead("slicesUsed"), ...cols.map((c) => String(sl.slicesUsed[c] ?? 0))].join(","),
  ].join("\r\n") + "\r\n";
}

/** 2D の定義表（column, family, feature, ibsi, notes, discretisation）。離散化の欄に per-slice を付ける。 */
export function roiFeature2dDefinitionsCsv(
  rows: RoiFeatureRow[],
  d: RoiFeatureDiscretisation,
  extraColumns: readonly string[],
): string {
  const lines = ["column,family,feature,ibsi,notes,discretisation"];
  for (const c of ROI_FEATURE_RECORD_COLUMNS) {
    lines.push([cell(c), c === "CaseLabel" ? "Record" : "Provenance", cell(c.replace(/^Provenance_/, "")), "", "", ""].join(","));
  }
  for (const c of extraColumns) {
    const [family, ...rest] = c.split("_");
    lines.push([cell(c), cell(family), cell(rest.join("_")), "", "", ""].join(","));
  }
  for (const r of rows) {
    lines.push([
      cell(r.column), cell(r.family), cell(r.feature), cell(r.ibsi ?? ""), cell(r.notes.join(";")),
      cell(discretisationOf2d(r.family, d)),
    ].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export const SECTION_EXTRA_COLUMNS = [...ROI_FEATURE_SIZE_COLUMNS, "Section_PositionMm", "Section_AreaMm2", "Section_Pixels"];
export const SLICES_EXTRA_COLUMNS = ["Slice_PositionMm", "Slice_AreaMm2", "Slice_Pixels"];
export const AGGREGATE_EXTRA_COLUMNS = ["Slices_Foreground", "Slices_Failed", "Aggregate"];

export interface CsvFile {
  suffix: string;
  text: string;
  mime?: string;
}

/** 選んだ 2D の単位ごとに書き出すファイル（3D の 3 本は別。`<base>` に続ける接尾辞つき）。 */
export function roiFeature2dFiles(result: RoiFeatureResult, caseLabel = ""): CsvFile[] {
  const out: CsvFile[] = [];
  if (result.section) {
    const s = result.section;
    out.push(
      { suffix: "_maxsection2d.csv", text: roiFeatureSectionCsv(s, caseLabel) },
      { suffix: "_maxsection2d_definitions.csv", text: roiFeature2dDefinitionsCsv(s.rows, s.record.discretisation, SECTION_EXTRA_COLUMNS) },
      { suffix: "_maxsection2d_radiomicsj.properties", text: s.record.settingsProperties, mime: "text/plain;charset=utf-8" },
    );
  }
  if (result.slices) {
    const sl = result.slices;
    out.push(
      { suffix: "_slices2d.csv", text: roiFeatureSlicesCsv(sl, caseLabel) },
      { suffix: "_slices2d_aggregate.csv", text: roiFeatureAggregateCsv(sl, caseLabel) },
      {
        suffix: "_slices2d_definitions.csv",
        text: roiFeature2dDefinitionsCsv(sl.mean, sl.record.discretisation, [...SLICES_EXTRA_COLUMNS, ...AGGREGATE_EXTRA_COLUMNS]),
      },
      { suffix: "_slices2d_radiomicsj.properties", text: sl.record.settingsProperties, mime: "text/plain;charset=utf-8" },
    );
  }
  return out;
}
