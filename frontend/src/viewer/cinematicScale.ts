/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// シネマティック（パストレース）の操作中の内部解像度を決める純関数。
// 設計: fw/render-environment-design.md「シネマティックの操作中の縮小描画」
//
// 描画の費用は画素数にほぼ比例する（レイは画素ごとに独立）。画面の更新間隔 tBudget に 1 フレームを収めるには、
// 一辺を 1/k（画素数を 1/k²）にすればよい。k は整数（蓄積テクスチャの大きさは整数画素）。
import type { RenderQuality } from "./renderEnv";

/** 中央値。外れ値（タブ切替で 1 秒空いた間隔など）を混ぜても動かない。空・非有限だけなら NaN。 */
export function medianInterval(samples: readonly number[]): number {
  const v = samples.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b);
  if (v.length === 0) return Number.NaN;
  const m = v.length >> 1;
  return v.length % 2 === 1 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/**
 * 1 フレームの費用のモデル: t(k) = fixedMs + perFullMs / k²（k は一辺の縮小率）。
 * perFullMs は画素数に比例する分（全解像度での値）、fixedMs は縮小しても残る固定の費用（描画の発行・GPU の完了待ちなど）。
 * 実測（Intel 内蔵 GPU・1736×1214）では k=1 が 10.8 ms、k=4 が 2.7 ms で、画素数に比例するだけ（k=4 で 1/16）にはならなかった。
 */
export interface CostModel {
  fixedMs: number;
  perFullMs: number;
}

export interface CostSample {
  /** 縮小率（一辺が 1/k）。 */
  k: number;
  /** その縮小率で 1 フレームを描いて GPU の完了まで待った実時間。 */
  ms: number;
}

/** t(k) の予測。 */
export function predictMs(m: CostModel, k: number): number {
  return m.fixedMs + m.perFullMs / (k * k);
}

/**
 * 実測から費用のモデルを当てはめる。縮小率ごとの中央値を取り、最小の k と最大の k の 2 点から fixed・perFull を解く。
 * - 縮小率が 1 種類だけ: 固定費は分からないので 0 とみなす（perFull = ms·k²。固定費があれば過大に見積もる＝縮小しすぎる側の誤り）
 * - 2 点が逆転（大きい k のほうが遅い＝雑音）または固定費が負: 最小の k の 1 点から固定費 0 とする
 * 使える実測が無ければ null。
 */
export function fitCostModel(samples: readonly CostSample[]): CostModel | null {
  const byK = new Map<number, number[]>();
  for (const s of samples) {
    if (!Number.isFinite(s.k) || s.k < 1 || !Number.isFinite(s.ms) || s.ms <= 0) continue;
    const a = byK.get(s.k) ?? [];
    a.push(s.ms);
    byK.set(s.k, a);
  }
  const ks = [...byK.keys()].sort((a, b) => a - b);
  if (ks.length === 0) return null;
  const med = (k: number) => medianInterval(byK.get(k) ?? []);
  const kLo = ks[0];
  const tLo = med(kLo);
  const proportional: CostModel = { fixedMs: 0, perFullMs: tLo * kLo * kLo };
  if (ks.length === 1) return proportional;
  const kHi = ks[ks.length - 1];
  const tHi = med(kHi);
  const perFull = (tLo - tHi) / (1 / (kLo * kLo) - 1 / (kHi * kHi));
  const fixed = tLo - perFull / (kLo * kLo);
  if (!(perFull > 0) || !(fixed >= 0)) return proportional;
  return { fixedMs: fixed, perFullMs: perFull };
}

/**
 * 操作中の内部解像度の縮小率 k（一辺が 1/k）: t(k) ≤ tBudget となる最小の整数 k。
 * k = ceil(√(perFull / (tBudget − fixed)))。固定費だけで更新間隔を超える（縮小しても間に合わない）ときは、固定費を除いて画素分だけを収める。
 * 全解像度で間に合う（fixed + perFull ≤ tBudget）なら 1（縮小しない）。上限は 1 画素まで（min(w, h)）。
 * 測れていない（null・NaN・0 以下）ときも 1（今までと同じ）。
 */
export function cinematicScaleForModel(m: CostModel | null, tBudgetMs: number, w: number, h: number): number {
  if (!m || !Number.isFinite(m.fixedMs) || !Number.isFinite(m.perFullMs) || m.perFullMs <= 0 || !Number.isFinite(tBudgetMs) || tBudgetMs <= 0) return 1;
  const cap = Math.max(1, Math.floor(Math.min(w, h)));
  const room = tBudgetMs - Math.max(0, m.fixedMs);
  const need = m.perFullMs / (room > 0 ? room : tBudgetMs);
  const k = Math.ceil(Math.sqrt(need));
  return Math.min(Math.max(k, 1), cap);
}

/** 固定費 0 のモデル（費用が画素数に比例するだけ）での縮小率。tFull は全解像度の 1 フレームの時間。 */
export function cinematicScaleFor(tFullMs: number, tBudgetMs: number, w: number, h: number): number {
  if (!Number.isFinite(tFullMs) || tFullMs <= 0) return 1;
  return cinematicScaleForModel({ fixedMs: 0, perFullMs: tFullMs }, tBudgetMs, w, h);
}

/** 画質設定を含めた縮小率。full は常に 1（操作中も全解像度）。 */
export function cinematicScaleForQuality(quality: RenderQuality, m: CostModel | null, tBudgetMs: number, w: number, h: number): number {
  return quality === "full" ? 1 : cinematicScaleForModel(m, tBudgetMs, w, h);
}

/**
 * 「カメラが止まった」とみなすまでの待ち（ms）= 3 × 画面の更新間隔。
 * ポインタ操作のサンプルが 2 表示フレーム抜けても止まったと誤認しない長さ（実測した更新間隔から導く。固定の ms は置かない）。
 * 測れていないときは NaN（呼び出し側は縮小しない）。
 */
export function settleHoldMs(tBudgetMs: number): number {
  return Number.isFinite(tBudgetMs) && tBudgetMs > 0 ? 3 * tBudgetMs : Number.NaN;
}

/** k で試し描きした 1 フレームの時間から、全解像度の 1 フレームの秒数を見積もる（費用は画素数に比例）。 */
export function estimateFrameSeconds(tProbeMs: number, kProbe: number): number {
  if (!Number.isFinite(tProbeMs) || tProbeMs <= 0 || !Number.isFinite(kProbe) || kProbe < 1) return Number.NaN;
  return (tProbeMs * kProbe * kProbe) / 1000;
}

/** シネマティックの描画の実測（デバッグ API 用）。読めなければ null。 */
export interface CinematicStats {
  /** measuring＝画面の更新間隔を測っている／probing＝確認用の試し描き／confirm＝利用者の確認待ち／running */
  phase: "measuring" | "probing" | "confirm" | "running";
  /** 内部解像度の縮小率 k（操作中だけ 1 より大きい）。 */
  scale: number;
  internalWidth: number;
  internalHeight: number;
  canvasWidth: number;
  canvasHeight: number;
  frameCount: number;
  /** 画面の更新間隔（rAF の中央値）。 */
  tBudgetMs: number;
  /** 費用のモデル t(k) = fixedMs + perFullMs/k² の当てはめ（実測が無ければ NaN）。 */
  fixedMs: number;
  perFullMs: number;
  /** 全解像度の 1 フレームの予測時間 fixedMs + perFullMs（無ければ NaN）。 */
  tFullMs: number;
  /** 確認用の試し描きから見積もった全解像度 1 フレームの秒数（ソフトウェア描画のときだけ）。 */
  estimateSeconds: number | null;
  quality: RenderQuality;
  /** カメラが動いているとみなしている間 true。 */
  moving: boolean;
  /** 当てはめに使っている実測（縮小率ごとに直近 3 つ）。 */
  samples: CostSample[];
}
