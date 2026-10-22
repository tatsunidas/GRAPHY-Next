/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 特徴量表の CSV。データ表と定義表の 2 本を出す。
 *
 * <p>データ表は 1 行目が列名、2 行目が値（1 行 = 1 ROI）で、列名と並びは RadiomicsJ の結果表のまま。
 * 症例ごとの CSV を縦に積めば、そのまま統計ソフトの入力になる。注記を同じ表に混ぜると R の
 * `read.csv` などで型が崩れるので、注記は定義表（列名・IBSI・注記・離散化）に分ける。
 *
 * <p>先頭の 5 列は記録（症例ラベル・版・抽出日時・設定ファイルの SHA-256）。症例ごとの CSV を縦に積んでも、
 * どの版・どの設定で出した値かが列で分かる。続く 6 列は ROI の大きさと小さい ROI の警告（面積を共変量に使うため）。
 * 警告の 2 列は、基準値が未設定なら空（0 と書かない。「判定していない」と「警告なし」を分ける）。
 *
 * <p>BOM は付けない。BOM があると R の `read.csv` が 1 列目の名前を `X.U.FEFF.…` に変えてしまう。
 * 症例ラベル以外は ASCII だけ（症例ラベルに日本語を入れたときは UTF-8 として読む）。
 */
import type { RoiFeatureDiscretisation, RoiFeatureProvenance, RoiFeatureResult, RoiFeatureRoiSize } from "../api";
import { cell } from "../viewer/roiStatsCsv";
import { DISCRETISED_FAMILIES, IVH_FAMILY, splitFilteredFamily } from "./roiFeatureSettings";

/**
 * 値の書き方。JS の数値の文字列化は倍精度を往復で保つので、読み戻すと API の値と差 0 になる。
 * NaN（API では null）は `NaN` と書く。R・pandas とも数値の NaN として読み、0 や欠損と取り違えない。
 */
export const value = (v: number | null): string => (v == null ? "NaN" : String(v));

/** 特徴量の列の前に置く記録の列。 */
export const ROI_FEATURE_RECORD_COLUMNS = [
  "CaseLabel",
  "Provenance_GraphyNextVersion",
  "Provenance_RadiomicsJVersion",
  "Provenance_ExtractedAt",
  "Provenance_SettingsSha256",
] as const;

/** 記録の列の後に置く、ROI の大きさの列。 */
export const ROI_FEATURE_SIZE_COLUMNS = [
  "Roi_InitialVoxels",
  "Roi_IntensityMaskVoxels",
  "Roi_MorphMaskVoxels",
  "Roi_VolumeMm3",
  "Warning_SmallRoiThresholdVoxels",
  "Warning_SmallRoi",
] as const;

/** 記録の 5 列の値（2D の CSV も同じ並びで使う）。 */
export function recordValuesOf(p: RoiFeatureProvenance, caseLabel: string): string[] {
  return [caseLabel, p.graphyNextVersion, p.radiomicsjVersion ?? "", p.extractedAt, p.settingsSha256].map(cell);
}

/** ROI の大きさの 6 列の値（2D の CSV も同じ並びで使う）。 */
export function sizeValuesOf(s: RoiFeatureRoiSize): string[] {
  return [
    value(s.initialVoxels),
    value(s.intensityVoxels),
    value(s.morphVoxels),
    value(s.volumeMm3),
    s.smallRoiWarnVoxels == null ? "" : String(s.smallRoiWarnVoxels),
    s.smallRoi == null ? "" : s.smallRoi ? "1" : "0",
  ];
}

/** データ表。症例ラベルは空でも列を置く（症例ごとの CSV を縦に積めるように）。 */
export function roiFeatureDataCsv(result: RoiFeatureResult, caseLabel = ""): string {
  const header = [...ROI_FEATURE_RECORD_COLUMNS, ...ROI_FEATURE_SIZE_COLUMNS, ...result.rows.map((r) => r.column)]
    .map(cell).join(",");
  const values = [
    ...recordValuesOf(result.provenance, caseLabel),
    ...sizeValuesOf(result.roiSize),
    ...result.rows.map((r) => value(r.value)),
  ].join(",");
  return `${header}\r\n${values}\r\n`;
}

/** 族の離散化の書き方（定義表の 1 セル）。離散化を使わない族は空。 */
export function discretisationOf(familyOrFiltered: string, d: RoiFeatureDiscretisation): string {
  // LoG 後の族は元の族と同じ離散化（フィルタ後の値で掛け直す）
  const family = splitFilteredFamily(familyOrFiltered)?.base ?? familyOrFiltered;
  if (DISCRETISED_FAMILIES.has(family)) {
    return d.fixedBinNumber ? `fixedBinNumber=${d.nBins}` : `binWidth=${d.binWidth}`;
  }
  if (family === IVH_FAMILY) {
    return `ivhMode=${d.ivhMode};ivhBinCount=${d.ivhBinCount};ivhBinWidth=${d.ivhBinWidth}`;
  }
  return "";
}

export const ROI_FEATURE_DEFINITION_COLUMNS = ["column", "family", "feature", "ibsi", "notes", "discretisation"];

/** 定義表。注記は言語に依らない符号を `;` でつなぐ（訳は画面と docs にある）。 */
export function roiFeatureDefinitionsCsv(result: RoiFeatureResult): string {
  const lines = [ROI_FEATURE_DEFINITION_COLUMNS.join(",")];
  for (const c of ROI_FEATURE_RECORD_COLUMNS) {
    lines.push([cell(c), c === "CaseLabel" ? "Record" : "Provenance", cell(c.replace(/^Provenance_/, "")), "", "", ""].join(","));
  }
  for (const c of ROI_FEATURE_SIZE_COLUMNS) {
    const [family, feature] = c.split("_");
    lines.push([cell(c), cell(family), cell(feature), "", "", ""].join(","));
  }
  for (const r of result.rows) {
    lines.push([
      cell(r.column),
      cell(r.family),
      cell(r.feature),
      cell(r.ibsi ?? ""),
      cell(r.notes.join(";")),
      cell(discretisationOf(r.family, result.discretisation)),
    ].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * ファイル名の土台。`<base>.csv`・`<base>_definitions.csv`・`<base>_radiomicsj.properties` にする。
 * 症例ラベルがあればそれを使う（ファイル名に使えない文字は `_`）。無ければシリーズ番号。
 */
export function roiFeatureFileBase(
  seriesNumber: number | string | null | undefined,
  maskChannel: number,
  caseLabel = "",
): string {
  const label = caseLabel.trim().replace(/[\\/:*?"<>|\s]/g, "_");
  // セグメントは付ける（同じ症例で別のセグメントを出したときに上書きしない）。
  if (label) return `${label}-seg${maskChannel}`;
  const sn = seriesNumber == null || seriesNumber === "" ? "roi" : String(seriesNumber).replace(/[^A-Za-z0-9_-]/g, "_");
  return `roi-features-${sn}-seg${maskChannel}`;
}

/** 設定ファイルの本文から、画面の要約に使う値を読む（画面の欄ではなく、計算に実際に使った値）。 */
export function parseSettingsProperties(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}
