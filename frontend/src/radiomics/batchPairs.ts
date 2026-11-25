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
import { BATCH_FINISHED, type BatchPair, type BatchQc, type BatchRequest, type BatchStatus } from "./batchApi";
import { normalizeLabels, type SpecKind } from "./batchSpec";
import { ROI_FEATURE_FAMILIES, defaultRoiFeatureForm, roiFeatureSettings, valueSpecOf, type RoiFeatureForm } from "./roiFeatureSettings";

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

/**
 * 対象にした（実行できる）組の元画像のモダリティの集合（昇順）。元画像が決まっていない組・モダリティが分からない組は数えない
 * （分からないものを 1 種類として扱うと、混在の判定を誤る）。
 */
export function includedSourceModalities(
  rows: readonly PairRow[], modalityOf: (studyUid: string, seriesUid: string) => string | null | undefined,
): string[] {
  const found = new Set<string>();
  for (const r of rows) {
    if (!(r.included && runnable(r)) || !r.source) continue;
    const m = modalityOf(r.pair.studyUid, r.source)?.trim().toUpperCase();
    if (m) found.add(m);
  }
  return [...found].sort();
}

/** 2 種類以上のモダリティが混ざっているか。 */
export const modalitiesMixed = (modalities: readonly string[]): boolean => modalities.length >= 2;

/**
 * PET を対象にしているのに、固定ビン幅が初期値（CT の HU 向け）のままか。しきい値の判定ではなく「既定値のまま PET を計算しようとしている」ことの検出。
 * 固定ビン数・VOI 統計（離散化を使わない）のときは false。
 */
export function petWithDefaultBinWidth(form: RoiFeatureForm, modalities: readonly string[], kind: SpecKind): boolean {
  return kind !== "voiStats" && modalities.includes("PT") && !form.fixedBinNumber && form.binWidth === defaultRoiFeatureForm().binWidth;
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
  /** 2D の小さい ROI の基準値（画素数）。null か無しは環境設定の 2D の値。 */
  smallRoiPixels?: number | null;
  /** 抽出の種類。`voiStats` は族を一次統計だけ・元の格子・範囲なしにして送る。 */
  kind?: SpecKind;
}

/** VOI 統計の設定: 一次統計の族だけを有効にし、再標本化・範囲は使わない（値が元の格子の値になるように）。 */
export function voiStatsForm(base: RoiFeatureForm): RoiFeatureForm {
  const families = Object.fromEntries(ROI_FEATURE_FAMILIES.map((f) => [f.key, f.key === "IntensityBasedStatistical"]));
  return { ...base, families, resampleMm: null, rangeMinText: "", rangeMaxText: "", logOn: false, advancedText: "" };
}

export function buildBatchRequest(pairs: readonly BatchPair[], form: RoiFeatureForm, opts: BatchRunOptions = {}): BatchRequest {
  return {
    pairs: [...pairs],
    settings: roiFeatureSettings(opts.kind === "voiStats" ? voiStatsForm(form) : { ...form, logOn: false }),
    // VOI 統計は 3D の一次統計だけ。2D の単位は特徴量の抽出のときだけ
    roiModes: opts.kind === "voiStats" ? ["WHOLE_3D"] : ["WHOLE_3D", ...form.units2d],
    planes: opts.kind !== "voiStats" && form.units2d.length > 0 && form.planesAll ? "ALL" : null,
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
    smallRoiWarnPixels: opts.kind !== "voiStats" && form.units2d.length > 0 ? opts.smallRoiPixels ?? null : null,
    kind: opts.kind === "voiStats" ? "voiStats" : null,
    calibration: form.calibration,
    valueSpec: opts.kind === "voiStats" ? null : valueSpecOf(form),
  };
}

/**
 * 小さい ROI の基準値（環境設定）が未設定で、どの結果でも判定していないか。判定していないことと「警告なし」を
 * 取り違えないために、画面で別に知らせる。結果が 1 つも無いときは false。
 */
export function smallRoiThresholdUnset(results: readonly RoiFeatureResult[]): boolean {
  return results.length > 0 && results.every((r) => r.roiSize?.smallRoiWarnVoxels == null);
}

/**
 * 2D の小さい ROI の基準値（画面の値も環境設定の 2D の値も）が未設定で、2D のどの結果でも判定していないか。2D の結果が 1 つも無いときは false。
 */
export function smallRoi2dThresholdUnset(results: readonly RoiFeatureResult[]): boolean {
  const with2d = results.filter((r) => r.section || r.slices);
  return with2d.length > 0 && with2d.every((r) => r.section?.roiSize?.smallRoiWarnVoxels == null && r.slices?.smallRoiWarnPixels == null);
}

/** 元画像の画素間隔（mm、リサンプリング前）の診断情報の列。 */
const SPACING_COLUMNS = [
  "Diagnostics_DiagnosticsInitialImageVoxelDimensionX",
  "Diagnostics_DiagnosticsInitialImageVoxelDimensionY",
  "Diagnostics_DiagnosticsInitialImageVoxelDimensionZ",
] as const;

/** 間隔の差とみなす相対差。DICOM の間隔は有限桁で書かれるため、1 % 未満（例 0.977 と 0.9766）は丸めとして差にしない。 */
export const SPACING_MIX_TOLERANCE = 0.01;

export interface VoxelSpacingMix {
  /** いずれかの軸で、最大/最小 − 1 が許容を超える。使える結果が 2 未満なら false（比べる相手が無い）。 */
  mixed: boolean;
  /** 軸（x・y・z）ごとの最小・最大（mm）。使える結果が無ければ null。 */
  perAxis: ({ min: number; max: number } | null)[];
  /** 3 軸とも取れた結果の数。 */
  usable: number;
  /** 間隔が取れなかった（診断情報に無い・数でない・0 以下）結果の数。判定からは外す。 */
  unknown: number;
}

/**
 * 計算できた組の、元画像の画素間隔（診断情報）が組の間でそろっているか。形態・テクスチャの値は、リサンプリングしないと
 * 間隔（スライス厚）の違いが乗るので、そろっていないことを画面・CLI で知らせるために使う。
 */
export function voxelSpacingMix(results: readonly RoiFeatureResult[]): VoxelSpacingMix {
  const vals: number[][] = [];
  let unknown = 0;
  for (const r of results) {
    const v = SPACING_COLUMNS.map((c) => r.rows.find((x) => x.column === c)?.value);
    if (v.every((x): x is number => typeof x === "number" && Number.isFinite(x) && x > 0)) vals.push(v as number[]);
    else unknown++;
  }
  const perAxis = [0, 1, 2].map((a) => (vals.length === 0 ? null : { min: Math.min(...vals.map((v) => v[a])), max: Math.max(...vals.map((v) => v[a])) }));
  const mixed = vals.length >= 2 && perAxis.some((p) => p != null && p.max / p.min - 1 > SPACING_MIX_TOLERANCE);
  return { mixed, perAxis, usable: vals.length, unknown };
}

/** 表示用の文字列（`x 0.7〜0.9 mm、y …、z 1〜3 mm`）。 */
export function spacingMixText(m: VoxelSpacingMix): string {
  const f = (n: number) => String(Number(n.toPrecision(4)));
  return ["x", "y", "z"].map((a, i) => {
    const p = m.perAxis[i];
    return p == null ? `${a} —` : p.min === p.max ? `${a} ${f(p.min)} mm` : `${a} ${f(p.min)}〜${f(p.max)} mm`;
  }).join("、");
}

/** ファイル名の接頭辞に使えない文字を `_` にする。空なら `roi-features-batch`。 */
export function batchFileBase(prefix: string): string {
  const p = prefix.trim().replace(/[\\/:*?"<>|\s]/g, "_");
  return p || "roi-features-batch";
}

/** 経過時間を 分:秒（1 時間以上は 時:分:秒）にする。負・NaN は 0:00。 */
export function formatElapsed(ms: number): string {
  const sec = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

export interface FooterProgress {
  running: boolean;
  /** 今計算している組（`job.pairs` で RUNNING の最初の行）の 0 始まりの番号。無ければ null。 */
  index: number | null;
  /** 今計算している組の症例ラベル。無ければ null。 */
  label: string | null;
  done: number;
  failed: number;
  total: number;
  elapsedMs: number;
}

/** 下端の帯に出す要約の元。実行中は今計算している組を、終了後は件数と経過だけを使う。 */
export function footerProgress(job: BatchStatus, labels: readonly string[]): FooterProgress {
  const running = !BATCH_FINISHED.has(job.state);
  const cur = running ? job.pairs.find((p) => p.state === "RUNNING") : undefined;
  return {
    running,
    index: cur ? cur.index : null,
    label: cur ? (labels[cur.index] ?? null) : null,
    done: job.done,
    failed: job.failed,
    total: job.total,
    elapsedMs: job.elapsedMs,
  };
}
