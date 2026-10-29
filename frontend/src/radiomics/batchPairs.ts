/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 一括抽出ダイアログの純粋な部分: 組の選択、症例ラベル、要求、縦に連ねた CSV。
 *
 * <p>患者名・患者 ID はここでは扱わない（画面の確認表にだけ出す）。書き出しは `datasetCsv.ts`。
 */
import type { RoiFeatureResult } from "../api";
import type { BatchPair, BatchQc, BatchRequest } from "./batchApi";
import { normalizeLabels, type SpecKind } from "./batchSpec";
import { ROI_FEATURE_FAMILIES, roiFeatureSettings, type RoiFeatureForm } from "./roiFeatureSettings";

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
  /** 小さい ROI の基準値（ボクセル数）。null か無しは環境設定の値。 */
  smallRoiVoxels?: number | null;
  /** 抽出の種類。`voiStats` は族を一次統計だけ・元の格子・範囲なしにして送る。 */
  kind?: SpecKind;
}

/** VOI 統計の設定: 一次統計の族だけを有効にし、再標本化・範囲は使わない（値が元の格子の値になるように）。 */
export function voiStatsForm(base: RoiFeatureForm): RoiFeatureForm {
  const families = Object.fromEntries(ROI_FEATURE_FAMILIES.map((f) => [f.key, f.key === "IntensityBasedStatistical"]));
  return { ...base, families, resampleMm: null, rangeMinText: "", rangeMaxText: "", logOn: false };
}

export function buildBatchRequest(pairs: readonly BatchPair[], form: RoiFeatureForm, opts: BatchRunOptions = {}): BatchRequest {
  return {
    pairs: [...pairs],
    settings: roiFeatureSettings(opts.kind === "voiStats" ? voiStatsForm(form) : { ...form, logOn: false }),
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
    smallRoiWarnVoxels: opts.smallRoiVoxels ?? null,
    kind: opts.kind === "voiStats" ? "voiStats" : null,
  };
}

/**
 * 小さい ROI の基準値（環境設定）が未設定で、どの結果でも判定していないか。判定していないことと「警告なし」を
 * 取り違えないために、画面で別に知らせる。結果が 1 つも無いときは false。
 */
export function smallRoiThresholdUnset(results: readonly RoiFeatureResult[]): boolean {
  return results.length > 0 && results.every((r) => r.roiSize?.smallRoiWarnVoxels == null);
}

/** ファイル名の接頭辞に使えない文字を `_` にする。空なら `roi-features-batch`。 */
export function batchFileBase(prefix: string): string {
  const p = prefix.trim().replace(/[\\/:*?"<>|\s]/g, "_");
  return p || "roi-features-batch";
}
