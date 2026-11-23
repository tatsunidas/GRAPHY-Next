/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ホイール入力の診断（読み取りだけ）。利用者のマウスが実際に出す `deltaY`・`deltaMode`・間隔を記録し、
 * ビューアが使う `createWheelStepper`（`wheelScroll.ts`）が 1 スライスと数えた回数と並べて要約する。
 *
 * <p>目的: ハイパースクロール（クリック感なしの連続回転）付きのマウスが、離散ノッチ扱い（`deltaMode≠0` または
 * `|deltaY|` が {@link WHEEL_DISCRETE_PX} 以上）になるのか、細かい連続（{@link WHEEL_FINE_PX} ためて 1 スライス）に
 * なるのかを、推測ではなく測って決めるため。**しきい値・設定は変えない**（`wheelScroll.ts` は不変）。
 *
 * <p>欠損は 0 で埋めない: イベントが無いとき、最小・中央値・割合は `null`（表示は「不明」）。
 */
import { WHEEL_DISCRETE_PX, WHEEL_FINE_PX, WHEEL_IDLE_MS } from "./wheelScroll";

export interface WheelSample {
  /** `event.timeStamp` [ms]。 */
  t: number;
  dy: number;
  /** `event.deltaMode`（0=px, 1=行, 2=ページ）。 */
  mode: number;
}

export interface WheelBurst {
  events: number;
  /** 符号つき deltaY の合計 [px]（deltaMode≠0 のときは単位が px ではない）。 */
  sumDy: number;
  /** ステッパーが送ったスライス数（向きに関わらず数える）。 */
  slices: number;
}

export interface WheelSummary {
  count: number;
  modes: number[];
  absMin: number | null;
  absMedian: number | null;
  absMax: number | null;
  /** 最も多い `deltaY`（絶対値）の上位 5 つ。 */
  topValues: { dy: number; n: number }[];
  gapMinMs: number | null;
  gapMedianMs: number | null;
  /** 離散ノッチ扱いになったイベントの割合（0〜1）。 */
  discreteRatio: number | null;
  bursts: WheelBurst[];
  totalSlices: number;
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** ステッパーが離散ノッチと扱う入力か（`wheelScroll.ts` の `createWheelStepper` と同じ条件）。 */
export function isDiscreteWheel(dy: number, mode: number): boolean {
  return mode !== 0 || Math.abs(dy) >= WHEEL_DISCRETE_PX;
}

/**
 * @param steps 各イベントを `createWheelStepper` に通した返り値（−1 / 0 / +1）。`samples` と同じ長さ。
 * @param idleMs バーストを区切る間隔。ステッパーが端数を捨てる間隔（{@link WHEEL_IDLE_MS}）と同じ。
 */
export function summarizeWheelLog(samples: WheelSample[], steps: number[], idleMs: number = WHEEL_IDLE_MS): WheelSummary {
  const n = Math.min(samples.length, steps.length);
  const abs = samples.slice(0, n).map((s) => Math.abs(s.dy));
  const gaps: number[] = [];
  const bursts: WheelBurst[] = [];
  let cur: WheelBurst | null = null;
  for (let i = 0; i < n; i++) {
    const gap = i > 0 ? samples[i].t - samples[i - 1].t : null;
    if (gap !== null) gaps.push(gap);
    if (cur === null || (gap !== null && gap > idleMs)) {
      cur = { events: 0, sumDy: 0, slices: 0 };
      bursts.push(cur);
    }
    cur.events += 1;
    cur.sumDy += samples[i].dy;
    cur.slices += Math.abs(steps[i]);
  }
  const counts = new Map<number, number>();
  for (const a of abs) counts.set(a, (counts.get(a) ?? 0) + 1);
  const topValues = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, 5)
    .map(([dy, c]) => ({ dy, n: c }));
  return {
    count: n,
    modes: [...new Set(samples.slice(0, n).map((s) => s.mode))].sort((a, b) => a - b),
    absMin: n ? Math.min(...abs) : null,
    absMedian: median(abs),
    absMax: n ? Math.max(...abs) : null,
    topValues,
    gapMinMs: gaps.length ? Math.min(...gaps) : null,
    gapMedianMs: median(gaps),
    discreteRatio: n ? samples.slice(0, n).filter((s) => isDiscreteWheel(s.dy, s.mode)).length / n : null,
    bursts,
    totalSlices: bursts.reduce((a, b) => a + b.slices, 0),
  };
}

const MODE_NAME: Record<number, string> = { 0: "px", 1: "行", 2: "ページ" };
const fmt = (v: number | null, digits = 1): string => (v === null ? "不明" : String(Math.round(v * 10 ** digits) / 10 ** digits));

/** 貼り付けて渡せるテキスト。環境は OS・ブラウザの手がかり（個人情報は含まない）。 */
export function formatWheelReport(s: WheelSummary, env: { platform: string; userAgent: string }): string {
  const lines = [
    "ホイール診断レポート",
    `環境: ${env.platform || "不明"} / ${env.userAgent || "不明"}`,
    `ビューアの定数: 離散ノッチ=|deltaY|≥${WHEEL_DISCRETE_PX}px または deltaMode≠0 / 細かい連続は ${WHEEL_FINE_PX}px で 1 スライス / ${WHEEL_IDLE_MS}ms 空くと端数を捨てる`,
    `イベント数: ${s.count}`,
    `deltaMode: ${s.modes.length ? s.modes.map((m) => `${m}(${MODE_NAME[m] ?? "不明"})`).join(", ") : "不明"}`,
    `|deltaY| 最小/中央値/最大: ${fmt(s.absMin)} / ${fmt(s.absMedian)} / ${fmt(s.absMax)}`,
    `|deltaY| の多い値: ${s.topValues.length ? s.topValues.map((v) => `${v.dy}×${v.n}`).join(", ") : "不明"}`,
    `イベント間隔 最小/中央値 [ms]: ${fmt(s.gapMinMs)} / ${fmt(s.gapMedianMs)}`,
    `離散ノッチ扱いの割合: ${s.discreteRatio === null ? "不明" : `${Math.round(s.discreteRatio * 100)}%`}`,
    `ステッパーが送ったスライス数: ${s.totalSlices}`,
    `バースト（${WHEEL_IDLE_MS}ms 以上の間で区切る）: ${s.bursts.length}`,
    ...s.bursts.map((b, i) => `  #${i + 1}: イベント ${b.events} / deltaY 合計 ${fmt(b.sumDy)} / スライス ${b.slices}`),
  ];
  return lines.join("\n");
}
