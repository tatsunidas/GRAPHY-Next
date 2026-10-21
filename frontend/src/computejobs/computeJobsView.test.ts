/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { ComputeJobState, ComputeJobView } from "./computeJobsApi";
import {
  cleanupKey,
  countJobs,
  endpointLoads,
  envText,
  errorDetail,
  filterJobs,
  formatBytes,
  formatDuration,
  groupByBatch,
  isCancellable,
  isEnded,
  needsAttention,
  phaseKey,
  progressPct,
  reasonKey,
  sortNewest,
  stateKey,
  studyUidsOf,
  toMillis,
  wantsKeepAwake,
} from "./computeJobsView";

const ALL: ComputeJobState[] = ["QUEUED", "RUNNING", "AWAITING_USER", "DONE", "FAILED", "CANCELLED", "INTERRUPTED"];

function job(id: string, state: ComputeJobState, extra: Partial<ComputeJobView> = {}): ComputeJobView {
  return {
    id,
    batchId: null,
    state,
    phase: null,
    progress: null,
    message: null,
    reason: null,
    errorName: null,
    errorValue: null,
    attempt: 1,
    itemKey: null,
    inputs: [],
    requestId: null,
    pluginJobId: null,
    env: null,
    remoteCleanup: null,
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    outputsBytes: null,
    collectedAt: null,
    ...extra,
  };
}

describe("状態の分類", () => {
  it("終了・確認が要る・中止できる状態を全状態で網羅する", () => {
    const ended = ALL.filter(isEnded);
    expect(ended).toEqual(["DONE", "FAILED", "CANCELLED", "INTERRUPTED"]);
    expect(ALL.filter(needsAttention)).toEqual(["FAILED", "INTERRUPTED"]);
    expect(ALL.filter(isCancellable)).toEqual(["QUEUED", "RUNNING", "AWAITING_USER"]);
    expect(ALL.map(stateKey)).toHaveLength(7);
  });
  it("理由・段・後始末は既知のものだけキーにし、未知は null", () => {
    expect(reasonKey("code-error")).toBe("computeJobs.reason.code-error");
    expect(reasonKey("outputs-too-large")).toBe("computeJobs.reason.outputs-too-large");
    expect(reasonKey("something-new")).toBeNull();
    expect(reasonKey(null)).toBeNull();
    expect(phaseKey("exec")).toBe("computeJobs.phase.exec");
    expect(phaseKey("nope")).toBeNull();
    expect(cleanupKey("runtime-gone")).toBe("computeJobs.cleanup.runtime-gone");
    expect(cleanupKey("x")).toBeNull();
  });
});

describe("数値の整形", () => {
  it("進み具合は範囲に収め、値が無いときは 0 で埋めず null", () => {
    expect(progressPct(0.624)).toBe(62);
    expect(progressPct(1.4)).toBe(100);
    expect(progressPct(-1)).toBe(0);
    expect(progressPct(null)).toBeNull();
    expect(progressPct(undefined)).toBeNull();
    expect(progressPct(Number.NaN)).toBeNull();
  });
  it("時刻は ISO 文字列・ミリ秒・秒を読み、読めなければ null", () => {
    expect(toMillis("2026-10-20T01:02:03Z")).toBe(Date.parse("2026-10-20T01:02:03Z"));
    expect(toMillis(1760000000000)).toBe(1760000000000);
    expect(toMillis(1760000000)).toBe(1760000000000);
    expect(toMillis("garbage")).toBeNull();
    expect(toMillis(null)).toBeNull();
  });
  it("大きさと経過時間", () => {
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(13_100_000)).toBe("12.5 MB");
    expect(formatDuration(252_000)).toBe("4:12");
    expect(formatDuration(3_725_000)).toBe("1:02:05");
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
  });
  it("理由の本文は名前と値を結ぶ", () => {
    expect(errorDetail({ errorName: "OutOfMemoryError", errorValue: "CUDA out of memory" })).toBe("OutOfMemoryError: CUDA out of memory");
    expect(errorDetail({ errorName: "ValueError", errorValue: null })).toBe("ValueError");
    expect(errorDetail({ errorName: null, errorValue: null })).toBeNull();
  });
});

describe("環境の表示", () => {
  it("取れた項目だけを並べ、GPU が空配列・全部無しなら null", () => {
    expect(envText(null)).toBeNull();
    expect(envText({ python: "3.11.7", torch: null, cuda: null, gpu: [] })).toBe("Python 3.11.7");
    expect(envText({ python: "3.12.1", torch: "2.11", cuda: "12.4", gpu: ["Tesla T4", " "] })).toBe("Python 3.12.1 / torch 2.11 / CUDA 12.4 / Tesla T4");
    expect(envText({ python: null, torch: null, cuda: null, gpu: null })).toBeNull();
  });
});

describe("並び・絞り込み", () => {
  const a = job("cj_a", "DONE", { queuedAt: "2026-10-20T01:00:00Z", collectedAt: "2026-10-20T01:10:00Z" });
  const b = job("cj_b", "DONE", { queuedAt: "2026-10-20T02:00:00Z" });
  const c = job("cj_c", "FAILED", { queuedAt: "2026-10-20T03:00:00Z" });
  const d = job("cj_d", "RUNNING", { queuedAt: "2026-10-20T04:00:00Z" });
  const e = job("cj_e", "QUEUED", { queuedAt: "2026-10-20T05:00:00Z" });
  const all = [a, b, c, d, e];
  it("新しい順", () => {
    expect(sortNewest(all).map((j) => j.id)).toEqual(["cj_e", "cj_d", "cj_c", "cj_b", "cj_a"]);
  });
  it("フィルタ: 各区分と未受け取り", () => {
    expect(filterJobs(all, "all", false)).toHaveLength(5);
    expect(filterJobs(all, "active", false).map((j) => j.id)).toEqual(["cj_d", "cj_e"]);
    expect(filterJobs(all, "failed", false).map((j) => j.id)).toEqual(["cj_c"]);
    expect(filterJobs(all, "done", false).map((j) => j.id)).toEqual(["cj_a", "cj_b"]);
    expect(filterJobs(all, "all", true).map((j) => j.id)).toEqual(["cj_b"]); // 受け取り済みの a は外れる
    expect(filterJobs(all, "failed", true)).toEqual([]);
  });
});

describe("数の集計（状態バーと窓で同じ値になる）", () => {
  const jobs = [
    job("1", "RUNNING"),
    job("2", "AWAITING_USER"),
    job("3", "QUEUED"),
    job("4", "QUEUED"),
    job("5", "FAILED"),
    job("6", "INTERRUPTED"),
    job("7", "DONE"),
    job("8", "CANCELLED"),
  ];
  it("確認していない失敗・中断を数える（完了と中止は数えない）", () => {
    expect(countJobs(jobs, new Set())).toEqual({ running: 2, queued: 2, failed: 2 });
  });
  it("確認済みの失敗は数えず、他は変わらない", () => {
    expect(countJobs(jobs, new Set(["5"]))).toEqual({ running: 2, queued: 2, failed: 1 });
    expect(countJobs(jobs, new Set(["5", "6"]))).toEqual({ running: 2, queued: 2, failed: 0 });
  });
  it("確認済みの印が実行中・待ちの数を減らさない", () => {
    expect(countJobs(jobs, new Set(["1", "3"]))).toEqual({ running: 2, queued: 2, failed: 2 });
  });
  it("空の台帳は全部 0", () => {
    expect(countJobs([], new Set())).toEqual({ running: 0, queued: 0, failed: 0 });
  });
});

describe("計算機ごとの負荷・バッチのまとめ", () => {
  it("終了済みと計算機の無い行は数えない", () => {
    const jobs = [
      job("1", "RUNNING", { endpointId: "e1", endpointLabel: "Colab" }),
      job("2", "QUEUED", { endpointId: "e1", endpointLabel: "Colab" }),
      job("3", "QUEUED", { endpointId: "e2", endpointLabel: "lab" }),
      job("4", "DONE", { endpointId: "e2", endpointLabel: "lab" }),
      job("5", "QUEUED"),
    ];
    expect(endpointLoads(jobs)).toEqual([
      { endpointId: "e1", label: "Colab", running: 1, queued: 1 },
      { endpointId: "e2", label: "lab", running: 0, queued: 1 },
    ]);
  });
  it("同じバッチをまとめ、batchId の無い行は別々", () => {
    const g = groupByBatch([
      job("1", "DONE", { batchId: "cb_1" }),
      job("2", "FAILED", { batchId: "cb_1" }),
      job("3", "RUNNING", { batchId: "cb_1" }),
      job("4", "QUEUED", { batchId: "cb_1" }),
      job("5", "DONE"),
      job("6", "DONE"),
    ]);
    expect(g).toHaveLength(3);
    expect(g[0]).toMatchObject({ batchId: "cb_1", done: 1, failed: 1, running: 1, queued: 1 });
    expect(g[0].jobs).toHaveLength(4);
    expect(g[1].jobs).toHaveLength(1);
  });
});

describe("患者名を引く検査 UID", () => {
  it("削除済み・UID 空を除き、重複を除く", () => {
    const jobs = [
      job("1", "DONE", { inputs: [{ studyUid: "S1", seriesUid: "A", format: "npz", deleted: false }] }),
      job("2", "DONE", {
        inputs: [
          { studyUid: "S1", seriesUid: "B", format: "npz", deleted: false },
          { studyUid: "", seriesUid: "", format: "npz", deleted: true },
          { studyUid: "S2", seriesUid: "C", format: "npz", deleted: false },
        ],
      }),
    ];
    expect(studyUidsOf(jobs)).toEqual(["S1", "S2"]);
  });
});

describe("一括の見出し・眠り止め", () => {
  it("一括は interactive=false で見分け、一時停止の理由と『動いている組があるか』を持つ", () => {
    const g = groupByBatch([
      job("1", "FAILED", { batchId: "cb_1", interactive: false, pausedReason: "endpoint-unreachable", reason: "endpoint-unreachable" }),
      job("2", "QUEUED", { batchId: "cb_1", interactive: false, pausedReason: "endpoint-unreachable" }),
      job("3", "DONE", { batchId: "cb_2", interactive: false }),
      job("4", "DONE", { batchId: "cb_3", interactive: true }),
    ]);
    expect(g.map((x) => x.isBatch)).toEqual([true, true, false]);
    expect(g[0]).toMatchObject({ pausedReason: "endpoint-unreachable", active: true });
    expect(g[1]).toMatchObject({ pausedReason: null, active: false });
    expect(g[2].isBatch).toBe(false);
  });

  it("🔴 眠り止めは『一時停止でない一括の組が動いている』ときだけ", () => {
    const run = job("1", "RUNNING", { interactive: false });
    expect(wantsKeepAwake([run])).toBe(true);
    expect(wantsKeepAwake([job("2", "QUEUED", { interactive: false })])).toBe(true);
    expect(wantsKeepAwake([job("3", "RUNNING", { interactive: true })])).toBe(false); // 対話の 1 回は対象外
    expect(wantsKeepAwake([job("4", "QUEUED", { interactive: false, pausedReason: "endpoint-unreachable" })])).toBe(false); // 一時停止中
    expect(wantsKeepAwake([job("5", "DONE", { interactive: false })])).toBe(false);
    expect(wantsKeepAwake([job("6", "FAILED", { interactive: false })])).toBe(false);
    expect(wantsKeepAwake([])).toBe(false);
    // 停止中の組があっても、別の動いている組があれば止める
    expect(wantsKeepAwake([job("7", "QUEUED", { interactive: false, pausedReason: "x" }), run])).toBe(true);
  });
});
