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
 * <p>BOM は付けない。列名も値も ASCII だけで、BOM があると R の `read.csv` が 1 列目の名前を
 * `X.U.FEFF.…` に変えてしまう。
 */
import type { RoiFeatureDiscretisation, RoiFeatureResult } from "../api";
import { cell } from "../viewer/roiStatsCsv";
import { DISCRETISED_FAMILIES, IVH_FAMILY } from "./roiFeatureSettings";

/**
 * 値の書き方。JS の数値の文字列化は倍精度を往復で保つので、読み戻すと API の値と差 0 になる。
 * NaN（API では null）は `NaN` と書く。R・pandas とも数値の NaN として読み、0 や欠損と取り違えない。
 */
const value = (v: number | null): string => (v == null ? "NaN" : String(v));

export function roiFeatureDataCsv(result: RoiFeatureResult): string {
  const header = result.rows.map((r) => cell(r.column)).join(",");
  const values = result.rows.map((r) => value(r.value)).join(",");
  return `${header}\r\n${values}\r\n`;
}

/** 族の離散化の書き方（定義表の 1 セル）。離散化を使わない族は空。 */
export function discretisationOf(family: string, d: RoiFeatureDiscretisation): string {
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

/** ファイル名の土台。`<base>.csv` と `<base>_definitions.csv` にする。 */
export function roiFeatureFileBase(seriesNumber: number | string | null | undefined, maskChannel: number): string {
  const sn = seriesNumber == null || seriesNumber === "" ? "roi" : String(seriesNumber).replace(/[^A-Za-z0-9_-]/g, "_");
  return `roi-features-${sn}-seg${maskChannel}`;
}
