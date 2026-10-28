/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「要求の記録」画面の純粋な整形。記録は main が許可リストで作るが、ファイルは利用者が書き換えられるので、表示前に形と長さを検査する。
// 取れなかった値（null・欠け）は「不明」と書く。0 にしない。

export interface RequestLogModelRow {
  provider: string | null;
  model: string | null;
  requests: number;
  tokensIn: number;
  tokensOut: number;
  unknownUsage: number;
  /** 成功した要求の応答時間（ms）。1 件も無ければ null＝未取得（0 ではない）。 */
  latency: { n: number; p50: number; p95: number } | null;
}

/** 件数がこれ未満の分位数は参考値（暫定値。利用実績で見直す）。 */
export const MIN_LATENCY_N = 20;

export const isLatencyReference = (n: number): boolean => n < MIN_LATENCY_N;

/** ms → 秒の表示（小数 1 桁）。 */
export const secondsText = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export interface RequestLogSummary {
  count?: number;
  byModel?: RequestLogModelRow[];
  recent?: Record<string, unknown>[];
}

export interface RecentRow {
  key: string;
  ts: string;
  model: string;
  destination: "local" | "external";
  outcome: string;
  /** null は不明（画面は「不明」と書く。0 ではない）。 */
  tokensIn: number | null;
  tokensOut: number | null;
  tools: string[];
  latencyMs: number | null;
}

export const MAX_RECENT = 10;
const MAX_TEXT = 60;

const cut = (v: unknown, n = MAX_TEXT): string => (typeof v === "string" ? v.slice(0, n) : "");
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);

/** 画面に出す文字列（無い・文字でなければ空）。 */
export const shortText = cut;

/** トークン数の表示。不明（null）は `unknownLabel`、0 は本当の 0 として "0"。 */
export function tokenText(v: number | null, unknownLabel: string): string {
  return v === null ? unknownLabel : String(v);
}

/** 直近の記録（新しい順は main が並べて渡す）。形が崩れた行も落とさず、読める項目だけで 1 行にする。 */
export function recentRows(recent: unknown, limit = MAX_RECENT): RecentRow[] {
  if (!Array.isArray(recent)) return [];
  return recent.slice(0, limit).map((r, i) => {
    const row = r && typeof r === "object" ? (r as Record<string, unknown>) : {};
    const usage = row.usage && typeof row.usage === "object" ? (row.usage as Record<string, unknown>) : null;
    return {
      key: `${cut(row.ts, 40)}#${i}`,
      ts: cut(row.ts, 40),
      model: cut(row.modelVersion) || cut(row.modelId),
      destination: row.destination === "local" ? "local" : "external",
      outcome: cut(row.outcome, 40),
      tokensIn: usage ? count(usage.in) : null,
      tokensOut: usage ? count(usage.out) : null,
      tools: (Array.isArray(row.toolCalls) ? row.toolCalls : []).filter((n): n is string => typeof n === "string").slice(0, 8).map((n) => n.slice(0, 40)),
      latencyMs: count(row.latencyMs),
    };
  });
}

function latencyOf(v: unknown): RequestLogModelRow["latency"] {
  const l = v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  const n = l ? count(l.n) : null;
  const p50 = l ? count(l.p50) : null;
  const p95 = l ? count(l.p95) : null;
  return n && p50 !== null && p95 !== null ? { n, p50, p95 } : null;
}

/** モデル別の表。数でない値は 0 でなく捨てる（要求数 0 の行は出さない）。 */
export function modelRows(byModel: unknown): RequestLogModelRow[] {
  if (!Array.isArray(byModel)) return [];
  const out: RequestLogModelRow[] = [];
  for (const m of byModel) {
    const r = m && typeof m === "object" ? (m as Record<string, unknown>) : null;
    const requests = r ? count(r.requests) : null;
    if (!r || requests === null || requests === 0) continue;
    out.push({
      provider: typeof r.provider === "string" ? cut(r.provider) : null,
      model: typeof r.model === "string" ? cut(r.model) : null,
      requests,
      tokensIn: count(r.tokensIn) ?? 0,
      tokensOut: count(r.tokensOut) ?? 0,
      unknownUsage: count(r.unknownUsage) ?? 0,
      latency: latencyOf(r.latency),
    });
  }
  return out;
}

/** 合計の注記を付けるべきか（トークン不明の要求が 1 件でもあれば、合計は「取れた分」）。 */
export const totalIsPartial = (rows: RequestLogModelRow[]): boolean => rows.some((r) => r.unknownUsage > 0);
