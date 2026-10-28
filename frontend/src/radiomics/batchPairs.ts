/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 一括抽出ダイアログの純粋な部分: 組の選択、症例ラベル、要求、縦に連ねた CSV。
 *
 * <p>患者名・患者 ID はここへ入れない（画面の確認表にだけ出す）。CSV と対応表に載るのは、採番した症例ラベルと UID。
 */
import type { RoiFeatureResult } from "../api";
import { cell } from "../viewer/roiStatsCsv";
import type { BatchPair, BatchPairStatusRow, BatchRequest } from "./batchApi";
import { roiFeatureDataCsv, roiFeatureDefinitionsCsv } from "./roiFeatureCsv";
import { roiFeatureSettings, type RoiFeatureForm } from "./roiFeatureSettings";

export interface PairRow {
  pair: BatchPair;
  /** 元画像。AUTO は特定済みの値、NEEDS_CONFIRMATION は利用者が選ぶまで null。 */
  source: string | null;
  included: boolean;
  caseLabel: string;
}

export const pairKey = (p: BatchPair): string => `${p.studyUid}|${p.maskSeriesUid}|${p.maskChannel}`;

/** 実行できるか。除外の組、元画像が決まっていない組は実行できない。 */
export const runnable = (r: PairRow): boolean => r.pair.status !== "EXCLUDED" && !!r.source;

/** AUTO は対象に入れる。要確認は元画像を選ぶまで入れない。除外は入れられない。 */
export function initialRows(pairs: readonly BatchPair[]): PairRow[] {
  return pairs.map((pair) => {
    const source = pair.status === "AUTO" ? pair.sourceSeriesUid : null;
    return { pair, source, included: pair.status === "AUTO" && !!source, caseLabel: "" };
  });
}

/** 元画像を選ぶ（要確認の組）。選ぶと対象に入り、選びを外すと対象から外れる。 */
export function setSource(rows: readonly PairRow[], index: number, source: string | null): PairRow[] {
  return rows.map((r, i) => {
    if (i !== index || r.pair.status === "EXCLUDED") return r;
    const valid = source != null && r.pair.sourceCandidates.includes(source);
    return { ...r, source: valid ? source : null, included: valid };
  });
}

/** 対象に入れる／外す。実行できない組は変えない。 */
export function setIncluded(rows: readonly PairRow[], index: number, included: boolean): PairRow[] {
  return rows.map((r, i) => (i === index && runnable(r) ? { ...r, included } : r));
}

export interface PairSummary {
  auto: number;
  needsConfirmation: number;
  excluded: number;
  selected: number;
  /** 要確認のうち、元画像を選んでいない組。 */
  needsUnchosen: number;
}

export function summarize(rows: readonly PairRow[]): PairSummary {
  const s: PairSummary = { auto: 0, needsConfirmation: 0, excluded: 0, selected: 0, needsUnchosen: 0 };
  for (const r of rows) {
    if (r.pair.status === "AUTO") s.auto++;
    else if (r.pair.status === "NEEDS_CONFIRMATION") {
      s.needsConfirmation++;
      if (!r.source) s.needsUnchosen++;
    } else s.excluded++;
    if (r.included && runnable(r)) s.selected++;
  }
  return s;
}

/** 症例ラベルに使えない文字（改行）を空白にする。CSV の行を壊さないため。 */
export const cleanLabel = (s: string): string => s.replace(/[\r\n]+/g, " ").trim();

/**
 * 対象の組に C001、C002… を振る。利用者が入力したラベルと、すでに振ったラベルは残す。
 * 新しく対象になった組には、**使われていない次の番号**を振る（位置の番号を使うと、先に振った番号と重なる）。
 */
export function assignCaseLabels(rows: readonly PairRow[], prefix = "C"): PairRow[] {
  const included = (r: PairRow) => r.included && runnable(r);
  const width = Math.max(3, String(rows.filter(included).length).length);
  const used = new Set(rows.filter(included).map((r) => r.caseLabel.trim()).filter(Boolean));
  let n = 0;
  return rows.map((r) => {
    if (!included(r) || r.caseLabel.trim()) return r;
    let label: string;
    do {
      n++;
      label = `${prefix}${String(n).padStart(width, "0")}`;
    } while (used.has(label));
    used.add(label);
    return { ...r, caseLabel: label };
  });
}

/** 対象の組の中で重複している症例ラベル（空も含む）。 */
export function duplicateLabels(rows: readonly PairRow[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const r of rows) {
    if (!(r.included && runnable(r))) continue;
    const l = cleanLabel(r.caseLabel);
    if (seen.has(l)) dup.add(l);
    seen.add(l);
  }
  return [...dup];
}

/** サーバーへ送る組（対象かつ実行できるもの）。確認した元画像を入れる。順序が結果の `index` になる。 */
export function selectedPairs(rows: readonly PairRow[]): { pair: BatchPair; caseLabel: string }[] {
  return rows
    .filter((r) => r.included && runnable(r))
    .map((r) => ({ pair: { ...r.pair, sourceSeriesUid: r.source }, caseLabel: cleanLabel(r.caseLabel) }));
}

/** 段 2 は 3D・スケールなし・C/T は 0 だけ。ログ・スケールは設定にあってもオフにして送る。 */
export function buildBatchRequest(pairs: readonly BatchPair[], form: RoiFeatureForm, recompute = false): BatchRequest {
  return {
    pairs: [...pairs],
    settings: roiFeatureSettings({ ...form, logOn: false }),
    roiModes: ["WHOLE_3D"],
    scales: null,
    scaleNotation: null,
    scaleLabels: null,
    scaleConversion: null,
    scaleCoefficient: null,
    channel: 0,
    timePoint: 0,
    recompute,
  };
}

export interface LabelledResult {
  caseLabel: string;
  result: RoiFeatureResult;
}

export type StackedCsv = { ok: true; csv: string } | { ok: false; reason: string; caseLabel: string };

/**
 * 症例ごとの `roiFeatureDataCsv` の行をそのまま縦に連ねる。見出しが症例の間で違うとき（族が欠けたなど）は
 * 列がずれて値が別の特徴量になるので、連ねずに止める。
 */
export function stackedDataCsv(items: readonly LabelledResult[]): StackedCsv {
  if (items.length === 0) return { ok: false, reason: "no results", caseLabel: "" };
  let header = "";
  const lines: string[] = [];
  for (const it of items) {
    const csv = roiFeatureDataCsv(it.result, it.caseLabel);
    const cut = csv.indexOf("\r\n");
    const h = csv.slice(0, cut);
    const v = csv.slice(cut + 2).replace(/\r\n$/, "");
    if (!header) header = h;
    else if (h !== header) return { ok: false, reason: "header mismatch", caseLabel: it.caseLabel };
    lines.push(v);
  }
  return { ok: true, csv: `${header}\r\n${lines.join("\r\n")}\r\n` };
}

/** 症例ラベルと UID の対応表。患者名・患者 ID は入れない。計算しなかった組・失敗した組も、状態つきで残す。 */
export function pairsCsv(rows: readonly { caseLabel: string; status: BatchPairStatusRow }[]): string {
  const head = [
    "CaseLabel", "StudyInstanceUID", "SourceSeriesUID", "MaskSeriesUID", "SegmentNumber", "SegmentLabel",
    "MaskChannel", "State", "FailureKind", "FromCache", "Error",
  ];
  const out = [head.join(",")];
  for (const { caseLabel, status: s } of rows) {
    out.push([
      caseLabel, s.pair.studyUid, s.pair.sourceSeriesUid ?? "", s.pair.maskSeriesUid,
      s.pair.segmentNumber == null ? "" : String(s.pair.segmentNumber), s.pair.segmentLabel ?? "",
      String(s.pair.maskChannel), s.state, s.failureKind ?? "", s.fromCache ? "1" : "0", s.error ?? "",
    ].map(cell).join(","));
  }
  return `${out.join("\r\n")}\r\n`;
}

/** ファイル名の接頭辞に使えない文字を `_` にする。空なら `roi-features-batch`。 */
export function batchFileBase(prefix: string): string {
  const p = prefix.trim().replace(/[\\/:*?"<>|\s]/g, "_");
  return p || "roi-features-batch";
}

export interface BatchFiles {
  features: { name: string; text: string };
  definitions: { name: string; text: string };
  settings: { name: string; text: string };
  pairs: { name: string; text: string };
}

/** 書き出す 4 ファイル。計算できた症例が無い、または見出しが合わないときは理由を返す。 */
export function batchFiles(
  prefix: string,
  items: readonly LabelledResult[],
  all: readonly { caseLabel: string; status: BatchPairStatusRow }[],
): { ok: true; files: BatchFiles } | { ok: false; reason: string; caseLabel: string } {
  const stacked = stackedDataCsv(items);
  if (!stacked.ok) return stacked;
  const base = batchFileBase(prefix);
  return {
    ok: true,
    files: {
      features: { name: `${base}.csv`, text: stacked.csv },
      definitions: { name: `${base}_definitions.csv`, text: roiFeatureDefinitionsCsv(items[0].result) },
      settings: { name: `${base}_radiomicsj.properties`, text: items[0].result.settingsProperties },
      pairs: { name: `${base}_pairs.csv`, text: pairsCsv(all) },
    },
  };
}
