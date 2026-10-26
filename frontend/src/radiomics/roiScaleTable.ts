/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 複数スケールの結果を「統計 × スケール」の表と横長の CSV に組み替える。ここでは計算しない。
 * 値は、スケールごとの結果（`RoiFeatureResult.scales`）の同じ列の値をそのまま写す。
 *
 * <p>r=0（フィルタなし）の列は元の画像の列名、r>0 の列は LoG 後の列名（`log_sigma<σ>mm_` が前に付く）。
 * 接頭辞は RadiomicsJ が書いたものを結果の行から拾い、こちらで作り直さない。表の行の名前は接頭辞を除いた
 * 「基底名」（例 `IntensityBasedStatistical_Mean`）で、どのスケールにもその列があるものだけを行にする。
 *
 * <p>fine/medium/coarse の組は見出しに添えるだけで、組ごとの値は作らない（作り方が文献で確かめられていない）。
 */
import type { RoiFeatureResult, RoiFeatureRow } from "../api";
import { cell } from "../viewer/roiStatsCsv";
import {
  ROI_FEATURE_DEFINITION_COLUMNS, ROI_FEATURE_RECORD_COLUMNS, ROI_FEATURE_SIZE_COLUMNS,
  discretisationOf, recordValuesOf, sizeValuesOf, value,
} from "./roiFeatureCsv";
import { FILTER_COLUMNS, filterValuesOf } from "./roiFeatureScales";
import { splitFilteredFamily } from "./roiFeatureSettings";
import { SIX_STATISTICS } from "./roiSummaryStats";

export type ScaleEntry = NonNullable<RoiFeatureResult["scales"]>[number];

export type GroupName = "fine" | "medium" | "coarse";
/** 組ごとの半径 r（mm）の一覧。 */
export type ScaleGroups = Record<GroupName, number[]>;
/** `none` はフィルタなし（r=0）、`ungrouped` は割り当てに無い r（近い組へ入れない）。 */
export type GroupOf = GroupName | "none" | "ungrouped";

export const GROUP_NAMES: readonly GroupName[] = ["fine", "medium", "coarse"];

/** 既定の割り当て（文献の記載）。 */
export const DEFAULT_GROUPS: ScaleGroups = { fine: [2], medium: [3, 4, 5], coarse: [6] };

export function groupOf(scaleMm: number, groups: ScaleGroups): GroupOf {
  if (scaleMm === 0) return "none";
  return GROUP_NAMES.find((g) => groups[g].includes(scaleMm)) ?? "ungrouped";
}

/** 「3, 4, 5」のような入力を 0 より大きい数の並びに読む。読めなければ null。空は空の並び。 */
export function parseGroupText(text: string): number[] | null {
  const tokens = text.split(/[\s,、]+/).filter((s) => s !== "");
  const out: number[] = [];
  for (const tok of tokens) {
    const v = Number(tok);
    if (!Number.isFinite(v) || v <= 0) return null;
    out.push(v);
  }
  return out;
}

/** 同じ r が複数の組に入っていれば、その r を返す（組の割り当ては 1 つの r に 1 つだけ）。 */
export function duplicateScale(groups: ScaleGroups): number | null {
  const seen = new Set<number>();
  for (const g of GROUP_NAMES) {
    for (const r of groups[g]) {
      if (seen.has(r)) return r;
      seen.add(r);
    }
  }
  return null;
}

const LOG_PREFIX = /^(log_sigma[^_]+_)/;

/** そのスケールの列名の接頭辞。r=0 は空。LoG のスケールで LoG の列が一つも無ければ null。 */
export function prefixOf(entry: ScaleEntry): string | null {
  if (entry.sigma3dMm == null) return "";
  for (const r of entry.result.rows) {
    const m = LOG_PREFIX.exec(r.column);
    if (m) return m[1];
  }
  return null;
}

/** そのスケールの結果にある行を、基底名で引けるようにする（接頭辞のある行だけ・r=0 は接頭辞の無い行だけ）。 */
function rowsByBase(entry: ScaleEntry): Map<string, RoiFeatureRow> {
  const prefix = prefixOf(entry);
  const out = new Map<string, RoiFeatureRow>();
  if (prefix == null) return out;
  for (const r of entry.result.rows) {
    if (prefix === "") {
      if (!LOG_PREFIX.test(r.column)) out.set(r.column, r);
    } else if (r.column.startsWith(prefix)) {
      out.set(r.column.slice(prefix.length), r);
    }
  }
  return out;
}

export interface ScaleTableColumn {
  scaleMm: number;
  /** 3D の単位の σ（mm）。r=0 は null。 */
  sigmaMm: number | null;
  group: GroupOf;
}

export interface ScaleTableRow {
  /** 接頭辞を除いた列名。 */
  base: string;
  /** 6 統計に入る行ならその短い名前（Mean など）。 */
  label: string | null;
  /** 元の族（LoG 後でも接頭辞を除く）。 */
  family: string;
  feature: string;
  ibsi: string | null;
  notes: string[];
  /** スケールごとの値（columns と同じ順）。NaN は null のまま。 */
  values: (number | null)[];
}

export interface ScaleTable {
  columns: ScaleTableColumn[];
  /** 6 統計の行を先頭に、残りは RadiomicsJ の列の並び。 */
  rows: ScaleTableRow[];
}

/** 全スケールにそのスケールの列名で存在する行だけを、表の行にする。 */
export function scaleTable(full: RoiFeatureResult, groups: ScaleGroups): ScaleTable {
  const scales = full.scales ?? [];
  const maps = scales.map(rowsByBase);
  const columns = scales.map((e) => ({ scaleMm: e.scaleMm, sigmaMm: e.sigma3dMm, group: groupOf(e.scaleMm, groups) }));
  if (scales.length === 0) return { columns, rows: [] };
  const common = [...maps[0].keys()].filter((b) => maps.every((m) => m.has(b)));
  const sixOrder = new Map(SIX_STATISTICS.map((d, i) => [d.column, i]));
  const six = common.filter((b) => sixOrder.has(b)).sort((a, b) => sixOrder.get(a)! - sixOrder.get(b)!);
  const rest = common.filter((b) => !sixOrder.has(b));
  const rows = [...six, ...rest].map((base) => {
    const first = maps[0].get(base)!;
    return {
      base,
      label: SIX_STATISTICS.find((d) => d.column === base)?.label ?? null,
      family: splitFilteredFamily(first.family)?.base ?? first.family,
      feature: first.feature,
      ibsi: first.ibsi,
      notes: first.notes,
      values: maps.map((m) => m.get(base)!.value),
    };
  });
  return { columns, rows };
}

/** `Scale2mm_` / `Scale2.5mm_`（r は小数点のまま）。 */
export const scalePrefix = (scaleMm: number) => `Scale${scaleMm}mm_`;

/** 書き出しを止める理由（スケールの間で記録が食い違うなど）。 */
export class WideCsvError extends Error {}

/** ROI の大きさと版は、スケールによらず同じでなければならない。食い違いは黙って片方を書かず止める。 */
function assertConsistent(scales: readonly ScaleEntry[], caseLabel: string): void {
  const ref = scales[0];
  const refSize = sizeValuesOf(ref.result.roiSize);
  const refRec = recordValuesOf(ref.result.provenance, caseLabel).slice(0, 3);
  for (const e of scales.slice(1)) {
    const size = sizeValuesOf(e.result.roiSize);
    const bad = ROI_FEATURE_SIZE_COLUMNS.find((_, i) => size[i] !== refSize[i]);
    if (bad) {
      throw new WideCsvError(`ROI size differs between scales (${bad}: r ${ref.scaleMm} mm=${refSize[ROI_FEATURE_SIZE_COLUMNS.indexOf(bad)]}, r ${e.scaleMm} mm=${size[ROI_FEATURE_SIZE_COLUMNS.indexOf(bad)]}).`);
    }
    const rec = recordValuesOf(e.result.provenance, caseLabel).slice(0, 3);
    if (rec.some((v, i) => v !== refRec[i])) {
      throw new WideCsvError(`Versions differ between scales (r ${ref.scaleMm} mm and r ${e.scaleMm} mm).`);
    }
  }
}

const PER_SCALE_RECORD = ["Provenance_ExtractedAt", "Provenance_SettingsSha256"] as const;

/**
 * 横長の CSV の列の構成（データ表と定義表で共有）。既定は 6 統計の行だけ（6 統計 × スケール＝36 列）で、
 * `includeOthers` なら全スケールに共通する行をすべて書く。6 統計の行が一つも無いときは共通の行すべて。
 */
function wideLayout(full: RoiFeatureResult, groups: ScaleGroups, includeOthers: boolean) {
  const scales = full.scales ?? [];
  const table = scaleTable(full, groups);
  const six = table.rows.filter((r) => r.label != null);
  const rows = includeOthers || six.length === 0 ? table.rows : six;
  const features = scales.flatMap((e, si) =>
    rows.map((row) => ({ name: `${scalePrefix(e.scaleMm)}${row.base}`, si, row })));
  return { scales, table, features };
}

/** 横長のデータ表: 1 ROI＝1 行。共通の記録・ROI の大きさ、続けて Scale<r>mm_<基底名>、最後にスケールごとの記録とフィルタ。 */
export function roiFeatureWideCsv(
  full: RoiFeatureResult, caseLabel = "", groups: ScaleGroups = DEFAULT_GROUPS, includeOthers = false,
): string {
  const { scales, features } = wideLayout(full, groups, includeOthers);
  if (scales.length === 0) throw new WideCsvError("No scales in the result.");
  assertConsistent(scales, caseLabel);
  const common = [...ROI_FEATURE_RECORD_COLUMNS.slice(0, 3), ...ROI_FEATURE_SIZE_COLUMNS];
  const perScale = scales.flatMap((e) =>
    [...PER_SCALE_RECORD, ...FILTER_COLUMNS].map((c) => `${scalePrefix(e.scaleMm)}${c}`));
  const header = [...common, ...features.map((f) => f.name), ...perScale].map(cell).join(",");
  const ref = scales[0].result;
  const values = [
    ...recordValuesOf(ref.provenance, caseLabel).slice(0, 3),
    ...sizeValuesOf(ref.roiSize),
    ...features.map((f) => value(f.row.values[f.si])),
    ...scales.flatMap((e) => {
      const rec = recordValuesOf(e.result.provenance, caseLabel);
      return [rec[3], rec[4], ...filterValuesOf(e).map(cell)];
    }),
  ].join(",");
  return `${header}\r\n${values}\r\n`;
}

export const WIDE_DEFINITION_COLUMNS = [...ROI_FEATURE_DEFINITION_COLUMNS, "scale_mm", "sigma_mm", "group"];

/** 横長の定義表: 列ごとに、既存の定義の欄と scale_mm・sigma_mm・group。共通の列は scale の欄が空。 */
export function roiFeatureWideDefinitionsCsv(
  full: RoiFeatureResult, groups: ScaleGroups = DEFAULT_GROUPS, includeOthers = false,
): string {
  const { scales, features } = wideLayout(full, groups, includeOthers);
  if (scales.length === 0) throw new WideCsvError("No scales in the result.");
  const lines = [WIDE_DEFINITION_COLUMNS.join(",")];
  const plain = (c: string, family: string, feature: string, scale?: ScaleEntry) => {
    const g = scale ? groupOf(scale.scaleMm, groups) : "";
    return [cell(c), cell(family), cell(feature), "", "", "",
      scale ? String(scale.scaleMm) : "", scale?.sigma3dMm == null ? "" : String(scale.sigma3dMm), g].join(",");
  };
  for (const c of ROI_FEATURE_RECORD_COLUMNS.slice(0, 3)) {
    lines.push(plain(c, c === "CaseLabel" ? "Record" : "Provenance", c.replace(/^Provenance_/, "")));
  }
  for (const c of ROI_FEATURE_SIZE_COLUMNS) {
    const [family, feature] = c.split("_");
    lines.push(plain(c, family, feature));
  }
  const ref = scales[0].result;
  for (const f of features) {
    const e = scales[f.si];
    lines.push([
      cell(f.name), cell(f.row.family), cell(f.row.feature), cell(f.row.ibsi ?? ""), cell(f.row.notes.join(";")),
      cell(discretisationOf(f.row.family, ref.discretisation)),
      String(e.scaleMm), e.sigma3dMm == null ? "" : String(e.sigma3dMm), groupOf(e.scaleMm, groups),
    ].join(","));
  }
  for (const e of scales) {
    for (const c of [...PER_SCALE_RECORD, ...FILTER_COLUMNS]) {
      const [family, feature] = c.split("_");
      lines.push(plain(`${scalePrefix(e.scaleMm)}${c}`, family, feature, e));
    }
  }
  return `${lines.join("\r\n")}\r\n`;
}
