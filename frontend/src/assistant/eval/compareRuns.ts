/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 回帰評価の 2 回の実行を比べる（純関数）。質問セットの版が違う実行どうしは比べない。
export interface StoredEvalRun {
  ts: string;
  /** 質問の組。組が違う実行どうしは比べない。 */
  suite: "basic" | "plugin-pos";
  suiteVersion: number;
  provider: string | null;
  modelId: string | null;
  modelVersion: string | null;
  total: number;
  passed: number;
  /** 全質問の応答時間の合計（ms）。1 問でも欠けた・古い行は null＝未取得。 */
  totalLatencyMs?: number | null;
  cases: { id: string; pass: boolean; passes: number; n: number; latencyMs?: number }[];
}

export interface RunComparison {
  comparable: boolean;
  /** モデル ID または版が変わったか。どちらかが不明（null）のときは判断しない（false）。 */
  modelChanged: boolean;
  /** 前回は一致・今回は不一致の質問。 */
  regressed: string[];
  /** 前回は不一致・今回は一致の質問。 */
  fixed: string[];
}

export function compareRuns(prev: StoredEvalRun, cur: StoredEvalRun): RunComparison {
  if (prev.suite !== cur.suite || prev.suiteVersion !== cur.suiteVersion) return { comparable: false, modelChanged: false, regressed: [], fixed: [] };
  const was = new Map(prev.cases.map((c) => [c.id, c.pass]));
  const regressed: string[] = [];
  const fixed: string[] = [];
  for (const c of cur.cases) {
    const before = was.get(c.id);
    if (before === undefined) continue;
    if (before && !c.pass) regressed.push(c.id);
    if (!before && c.pass) fixed.push(c.id);
  }
  const differs = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;
  return { comparable: true, modelChanged: differs(prev.modelId, cur.modelId) || differs(prev.modelVersion, cur.modelVersion), regressed, fixed };
}
