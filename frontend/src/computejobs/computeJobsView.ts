/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 計算ジョブの窓・状態バーの表示ロジック（純関数）。React にも localStorage にも触れない。
import type { ComputeJobState, ComputeJobView } from "./computeJobsApi";

export type JobFilter = "all" | "active" | "failed" | "done";

const ENDED: ReadonlySet<ComputeJobState> = new Set(["DONE", "FAILED", "CANCELLED", "INTERRUPTED"]);

export const isEnded = (s: ComputeJobState): boolean => ENDED.has(s);
export const isActive = (s: ComputeJobState): boolean => !ENDED.has(s);
/** 利用者が確認する必要のある終わり方（コードの失敗・再起動での中断）。中止は利用者自身の操作なので含めない。 */
export const needsAttention = (s: ComputeJobState): boolean => s === "FAILED" || s === "INTERRUPTED";
/** 中止を受け付ける状態。 */
export const isCancellable = (s: ComputeJobState): boolean => s === "QUEUED" || s === "RUNNING" || s === "AWAITING_USER";

export const stateKey = (s: ComputeJobState): string => `computeJobs.state.${s}`;

const PHASES = new Set(["upload", "start", "exec", "download", "cleanup"]);
export const phaseKey = (p: string | null): string | null => (p && PHASES.has(p) ? `computeJobs.phase.${p}` : null);

const REASONS = new Set([
  "code-error",
  "timeout",
  "endpoint-unreachable",
  "dataset-changed",
  "dataset-expired",
  "outputs-too-large",
  "interrupted",
  "internal",
]);
/** 未知の理由は "internal" と同じ文言に落とさず、そのまま出せるよう null を返す。 */
export const reasonKey = (r: string | null): string | null => (r && REASONS.has(r) ? `computeJobs.reason.${r}` : null);

const CLEANUPS = new Set(["ok", "pending", "failed", "runtime-gone"]);
export const cleanupKey = (c: string | null): string | null =>
  c && CLEANUPS.has(c) ? `computeJobs.cleanup.${c}` : null;

/** 0..1 → 0..100 の整数。値が無い・範囲外は null（0 で埋めない）。 */
export function progressPct(p: number | null | undefined): number | null {
  if (p == null || Number.isNaN(p)) return null;
  return Math.round(Math.min(1, Math.max(0, p)) * 100);
}

export function toMillis(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v < 1e11 ? v * 1000 : v; // 秒で来た場合も扱う
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

export function formatBytes(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** m:ss（1 時間以上は h:mm:ss）。 */
export function formatDuration(ms: number | null): string | null {
  if (ms == null || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${m}:${p(s % 60)}`;
}

/** 新しい順（queuedAt、同じなら id で安定させる）。 */
export function sortNewest(jobs: ComputeJobView[]): ComputeJobView[] {
  return [...jobs].sort((a, b) => {
    const d = (toMillis(b.queuedAt) ?? 0) - (toMillis(a.queuedAt) ?? 0);
    return d !== 0 ? d : b.id.localeCompare(a.id);
  });
}

export function filterJobs(jobs: ComputeJobView[], filter: JobFilter, uncollectedOnly: boolean): ComputeJobView[] {
  return jobs.filter((j) => {
    if (uncollectedOnly && !(j.state === "DONE" && j.collectedAt == null)) return false;
    switch (filter) {
      case "active":
        return isActive(j.state);
      case "failed":
        return needsAttention(j.state);
      case "done":
        return j.state === "DONE";
      default:
        return true;
    }
  });
}

/** 同じ組（一括の組名。対話の 1 回は組名なし）の最新の試行を見分ける印。再実行で古い試行が残るため。 */
const groupKey = (j: ComputeJobView): string => `${j.batchId ?? j.id}|${j.itemKey ?? "#"}`;

/** 組ごとの最新の試行（attempt が最大）の id。内訳・失敗の数はこれだけを数える（直した古い失敗が残り続けない）。 */
export function latestIds(jobs: ComputeJobView[]): Set<string> {
  const best = new Map<string, ComputeJobView>();
  for (const j of jobs) {
    const cur = best.get(groupKey(j));
    if (!cur || j.attempt >= cur.attempt) best.set(groupKey(j), j);
  }
  return new Set([...best.values()].map((j) => j.id));
}

/** 同じ組の試行を古い順に（詳細に並べる）。 */
export function attemptsOf(jobs: ComputeJobView[], j: ComputeJobView): ComputeJobView[] {
  return jobs.filter((x) => groupKey(x) === groupKey(j)).sort((a, b) => a.attempt - b.attempt);
}

/**
 * 再実行できる行か。終わった失敗・中断・中止の**最新の試行**だけ（完了・古い試行は対象外）。
 * 同じ一括に動いている組があるあいだは出さない（backend も断る）。
 */
export function canRerun(j: ComputeJobView, latest: ReadonlySet<string>, batchActive: boolean): boolean {
  return !batchActive && latest.has(j.id) && (j.state === "FAILED" || j.state === "INTERRUPTED" || j.state === "CANCELLED");
}

export interface JobCounts {
  running: number;
  queued: number;
  /** 確認済み（seen）を除いた失敗・中断。 */
  failed: number;
}

/** 状態バーと窓の帯で同じ数を出すための集計。AWAITING_USER は「実行中」に含める（計算機の側で動いている）。 */
export function countJobs(jobs: ComputeJobView[], seen: ReadonlySet<string>): JobCounts {
  let running = 0;
  let queued = 0;
  let failed = 0;
  const latest = latestIds(jobs);
  for (const j of jobs) {
    if (j.state === "RUNNING" || j.state === "AWAITING_USER") running++;
    else if (j.state === "QUEUED") queued++;
    else if (needsAttention(j.state) && !seen.has(j.id) && latest.has(j.id)) failed++;
  }
  return { running, queued, failed };
}

export interface EndpointLoad {
  endpointId: string;
  label: string;
  running: number;
  queued: number;
}

/** 計算機ごとの実行中・待ち。endpointId の無い行（バッチの記録が無い）は数えない。 */
export function endpointLoads(jobs: ComputeJobView[]): EndpointLoad[] {
  const m = new Map<string, EndpointLoad>();
  for (const j of jobs) {
    if (!j.endpointId || isEnded(j.state)) continue;
    const e = m.get(j.endpointId) ?? { endpointId: j.endpointId, label: j.endpointLabel ?? j.endpointId, running: 0, queued: 0 };
    if (j.state === "QUEUED") e.queued++;
    else e.running++;
    m.set(j.endpointId, e);
  }
  return [...m.values()];
}

export interface BatchGroup {
  batchId: string;
  /** 一括（同じコードを組ごとに走らせたもの）か。対話の 1 回は false。 */
  isBatch: boolean;
  /** 一時停止中ならその理由。 */
  pausedReason: string | null;
  /** 待ち・実行中・利用者待ちの組があるか（［一括を中止］を出す条件）。 */
  active: boolean;
  /** 最新の試行が失敗・中断の組の数（［失敗だけ再実行］を出す条件）。 */
  rerunnable: number;
  jobs: ComputeJobView[];
  done: number;
  failed: number;
  running: number;
  queued: number;
}

/**
 * 同じバッチの行をまとめる。batchId が無い行は 1 件ずつ別グループ。
 * 順序は入力（新しい順）で最初に現れた位置を保つ。
 */
export function groupByBatch(jobs: ComputeJobView[]): BatchGroup[] {
  const order: BatchGroup[] = [];
  const index = new Map<string, BatchGroup>();
  const latest = latestIds(jobs);
  for (const j of jobs) {
    const key = j.batchId ?? `single:${j.id}`;
    let g = index.get(key);
    if (!g) {
      g = { batchId: key, isBatch: j.interactive === false, pausedReason: j.pausedReason ?? null, active: false, rerunnable: 0, jobs: [], done: 0, failed: 0, running: 0, queued: 0 };
      index.set(key, g);
      order.push(g);
    }
    g.jobs.push(j);
    if (isActive(j.state)) g.active = true;
    // 内訳は最新の試行だけ（再実行で直した古い失敗は数えない。行は古い試行も残して N 回目と出す）
    if (!latest.has(j.id)) continue;
    if (j.state === "DONE") g.done++;
    else if (needsAttention(j.state)) { g.failed++; g.rerunnable++; }
    else if (j.state === "RUNNING" || j.state === "AWAITING_USER") g.running++;
    else if (j.state === "QUEUED") g.queued++;
  }
  return order;
}

/**
 * 一括の計算が動いていて OS の眠りを止めたいか。一時停止中の一括は含めない（動いていないので眠ってよい）。
 * 対話の 1 回（runJob）も含めない（一括のように長く放っておく使い方ではない）。
 */
export function wantsKeepAwake(jobs: ComputeJobView[]): boolean {
  return jobs.some((j) => j.interactive === false && isActive(j.state) && !j.pausedReason);
}

/** 環境の 1 行表示。何も取れていなければ null（呼び出し側が「不明」と出す）。 */
export function envText(env: ComputeJobView["env"]): string | null {
  if (!env) return null;
  const parts = [
    env.python ? `Python ${env.python}` : null,
    env.torch ? `torch ${env.torch}` : null,
    env.cuda ? `CUDA ${env.cuda}` : null,
    ...(env.gpu ?? []).filter((g) => g && g.trim()),
  ].filter((x): x is string => !!x);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/** 窓の行の「コードのエラー: OutOfMemoryError: …」のような理由の本文。 */
export function errorDetail(j: Pick<ComputeJobView, "errorName" | "errorValue">): string | null {
  if (j.errorName && j.errorValue) return `${j.errorName}: ${j.errorValue}`;
  return j.errorName ?? j.errorValue ?? null;
}

/** 入力に含まれる、保管庫に残っている検査の UID（重複なし）。 */
export function studyUidsOf(jobs: ComputeJobView[]): string[] {
  const s = new Set<string>();
  for (const j of jobs) for (const i of j.inputs ?? []) if (!i.deleted && i.studyUid) s.add(i.studyUid);
  return [...s];
}
