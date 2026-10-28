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
import type { BatchPair, BatchPairStatusRow, BatchQc, BatchRequest } from "./batchApi";
import { normalizeLabels } from "./batchSpec";
import { roiFeatureDataCsv, roiFeatureDefinitionsCsv } from "./roiFeatureCsv";
import { roiFeatureSettings, type RoiFeatureForm } from "./roiFeatureSettings";

export interface PairRow {
  pair: BatchPair;
  /** 元画像。AUTO は特定済みの値、NEEDS_CONFIRMATION は利用者が選ぶまで null。 */
  source: string | null;
  included: boolean;
  caseLabel: string;
  /** セグメント名の絞り込みに合わない（対象から外した）。手でチェックすれば入れられる。 */
  filteredOut: boolean;
}

export const pairKey = (p: BatchPair): string => `${p.studyUid}|${p.maskSeriesUid}|${p.maskChannel}`;

/** 実行できるか。除外の組、元画像が決まっていない組は実行できない。 */
export const runnable = (r: PairRow): boolean => r.pair.status !== "EXCLUDED" && !!r.source;

/** AUTO は対象に入れる。要確認は元画像を選ぶまで入れない。除外は入れられない。 */
export function initialRows(pairs: readonly BatchPair[]): PairRow[] {
  return pairs.map((pair) => {
    const source = pair.status === "AUTO" ? pair.sourceSeriesUid : null;
    return { pair, source, included: pair.status === "AUTO" && !!source, caseLabel: "", filteredOut: false };
  });
}

/**
 * セグメント名で絞り込む（大文字小文字・前後の空白を無視。空なら絞り込まない）。合わない組は**消さずに**対象から外し、
 * 絞り込みを外す・合うようにすると、外した組だけを戻す（利用者が手で外した組は触らない）。
 */
export function applyLabelFilter(rows: readonly PairRow[], labels: readonly string[]): PairRow[] {
  const want = new Set(normalizeLabels(labels).map((l) => l.toLowerCase()));
  return rows.map((r) => {
    if (r.pair.status === "EXCLUDED") return r;
    const matches = want.size === 0 || (r.pair.segmentLabel != null && want.has(r.pair.segmentLabel.trim().toLowerCase()));
    if (!matches) return { ...r, included: false, filteredOut: true };
    return r.filteredOut ? { ...r, included: runnable(r), filteredOut: false } : r;
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
export interface BatchRunOptions {
  recompute?: boolean;
  /** QC に当たった組の扱い。null は記録だけ。 */
  qc?: BatchQc | null;
  /** 許容した組のキー（`pairKey`）。 */
  acknowledged?: readonly string[];
}

export function buildBatchRequest(pairs: readonly BatchPair[], form: RoiFeatureForm, opts: BatchRunOptions = {}): BatchRequest {
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
    recompute: opts.recompute ?? false,
    qc: opts.qc ?? null,
    qcAcknowledged: opts.acknowledged ? [...opts.acknowledged] : null,
  };
}

/**
 * 小さい ROI の基準値（環境設定）が未設定で、どの結果でも判定していないか。判定していないことと「警告なし」を
 * 取り違えないために、画面で別に知らせる。結果が 1 つも無いときは false。
 */
export function smallRoiThresholdUnset(results: readonly RoiFeatureResult[]): boolean {
  return results.length > 0 && results.every((r) => r.roiSize?.smallRoiWarnVoxels == null);
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
export function pairsCsv(
  rows: readonly { caseLabel: string; status: BatchPairStatusRow }[],
  specSha256 = "",
): string {
  const head = [
    "CaseLabel", "StudyInstanceUID", "SourceSeriesUID", "MaskSeriesUID", "SegmentNumber", "SegmentLabel",
    "MaskChannel", "State", "FailureKind", "FromCache", "Error", "QcFlags", "SpecSha256",
  ];
  const out = [head.join(",")];
  for (const { caseLabel, status: s } of rows) {
    out.push([
      caseLabel, s.pair.studyUid, s.pair.sourceSeriesUid ?? "", s.pair.maskSeriesUid,
      s.pair.segmentNumber == null ? "" : String(s.pair.segmentNumber), s.pair.segmentLabel ?? "",
      String(s.pair.maskChannel), s.state, s.failureKind ?? "", s.fromCache ? "1" : "0", s.error ?? "",
      (s.qcFlags ?? []).join(";"), specSha256,
    ].map(cell).join(","));
  }
  return `${out.join("\r\n")}\r\n`;
}

/** ファイル名の接頭辞に使えない文字を `_` にする。空なら `roi-features-batch`。 */
export function batchFileBase(prefix: string): string {
  const p = prefix.trim().replace(/[\\/:*?"<>|\s]/g, "_");
  return p || "roi-features-batch";
}

/** 書き出す定義（`_spec.json`）。ハッシュは `_pairs.csv` の `SpecSha256` に入れる。 */
export interface BatchSpecFile {
  sha256: string;
  text: string;
}

export interface BatchFiles {
  features: { name: string; text: string };
  definitions: { name: string; text: string };
  settings: { name: string; text: string };
  pairs: { name: string; text: string };
  spec: { name: string; text: string } | null;
}

/** 書き出すファイル（4 つ。定義を渡せば `_spec.json` も）。計算できた症例が無い、または見出しが合わないときは理由を返す。 */
export function batchFiles(
  prefix: string,
  items: readonly LabelledResult[],
  all: readonly { caseLabel: string; status: BatchPairStatusRow }[],
  spec: BatchSpecFile | null = null,
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
      pairs: { name: `${base}_pairs.csv`, text: pairsCsv(all, spec?.sha256 ?? "") },
      spec: spec ? { name: `${base}_spec.json`, text: spec.text } : null,
    },
  };
}
