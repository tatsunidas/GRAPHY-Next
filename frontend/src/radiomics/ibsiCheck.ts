/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * IBSI 照合の結果（RadiomicsJ の `ValidationReport` の JSON）を画面向けに数える・絞る。
 * 判定は RadiomicsJ がつけたものをそのまま使う（ここで再判定しない）。
 */

export type IbsiVerdict =
  | "PASS" | "PASS_AT_REFERENCE_DIGITS" | "FAIL" | "NOT_COMPUTED" | "NOT_SUPPORTED" | "NO_MANUAL_REFERENCE";

export const IBSI_VERDICTS: readonly IbsiVerdict[] = [
  "PASS", "PASS_AT_REFERENCE_DIGITS", "FAIL", "NOT_COMPUTED", "NOT_SUPPORTED", "NO_MANUAL_REFERENCE",
];

export interface IbsiRow {
  family: string | null;
  imageBiomarker: string | null;
  radiomicsjName: string | null;
  column: string | null;
  consensus: string | null;
  reference: number | null;
  tolerance: number | null;
  computed: number | null;
  verdict: IbsiVerdict;
  referenceStatus: string | null;
}

export interface IbsiReport {
  dataSet: string;
  radiomicsjVersion: string;
  referenceFile: string;
  referenceSha256: string;
  settingsFile: string;
  settings: string;
  rule: string;
  skippedDiagnostics: number;
  checked: number;
  counts: Record<IbsiVerdict, number>;
  rows: IbsiRow[];
}

/** backend `IbsiCheckService.Result`。 */
export interface IbsiCheckResult {
  graphyVersion: string;
  radiomicsjVersion: string;
  ranAt: string;
  report: IbsiReport;
  csv: string;
}

export interface IbsiSummary {
  /** 判定した行（許容幅内 + 桁数で一致 + 不合格）。 */
  checked: number;
  /** 許容幅内。 */
  withinTolerance: number;
  /** 許容幅なしで、桁数で一致（本ツール独自の基準）。 */
  atReferenceDigits: number;
  failed: number;
  notComputed: number;
  notSupported: number;
  noManualReference: number;
}

/** 件数は行から数え直し、RadiomicsJ の集計（`counts`）と食い違えば例外にする（黙って片方を採らない）。 */
export function summarize(report: IbsiReport): IbsiSummary {
  const n: Record<IbsiVerdict, number> = {
    PASS: 0, PASS_AT_REFERENCE_DIGITS: 0, FAIL: 0, NOT_COMPUTED: 0, NOT_SUPPORTED: 0, NO_MANUAL_REFERENCE: 0,
  };
  for (const r of report.rows) n[r.verdict] += 1;
  for (const v of IBSI_VERDICTS) {
    if ((report.counts?.[v] ?? 0) !== n[v]) {
      throw new Error(`照合の件数が行と合いません: ${v} 行 ${n[v]} / 集計 ${report.counts?.[v] ?? "なし"}`);
    }
  }
  return {
    checked: n.PASS + n.PASS_AT_REFERENCE_DIGITS + n.FAIL,
    withinTolerance: n.PASS,
    atReferenceDigits: n.PASS_AT_REFERENCE_DIGITS,
    failed: n.FAIL,
    notComputed: n.NOT_COMPUTED,
    notSupported: n.NOT_SUPPORTED,
    noManualReference: n.NO_MANUAL_REFERENCE,
  };
}

export const passedOf = (s: IbsiSummary) => s.withinTolerance + s.atReferenceDigits;

export type IbsiFilter = "ALL" | "FAIL" | "PROBLEM" | "NOT_JUDGED";

/** 絞り込み。PROBLEM は不合格＋計算されず、NOT_JUDGED は判定の対象外（非対応・手引きに参照値なし）。 */
export function filterRows(rows: IbsiRow[], filter: IbsiFilter, query: string): IbsiRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((r) => {
    if (filter === "FAIL" && r.verdict !== "FAIL") return false;
    if (filter === "PROBLEM" && r.verdict !== "FAIL" && r.verdict !== "NOT_COMPUTED") return false;
    if (filter === "NOT_JUDGED" && r.verdict !== "NOT_SUPPORTED" && r.verdict !== "NO_MANUAL_REFERENCE") return false;
    if (!q) return true;
    return [r.family, r.imageBiomarker, r.radiomicsjName, r.column]
      .some((s) => (s ?? "").toLowerCase().includes(q));
  });
}

/** ファイル名に使える形（版と日付）。 */
export function ibsiFileBase(r: IbsiCheckResult): string {
  const day = /^\d{4}-\d{2}-\d{2}/.exec(r.ranAt)?.[0] ?? "undated";
  return `ibsi1_${r.report.dataSet.replace(/\s+/g, "_")}_RadiomicsJ-${r.radiomicsjVersion}_${day}`;
}

/** 書き出す JSON（RadiomicsJ の本文に、本体の版と実行日時を添える）。 */
export function ibsiResultJson(r: IbsiCheckResult): string {
  return JSON.stringify({ graphyNextVersion: r.graphyVersion, ranAt: r.ranAt, report: r.report }, null, 2) + "\n";
}
