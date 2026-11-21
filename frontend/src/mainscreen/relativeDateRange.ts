/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { addDays, ymd } from "./savedSearch";

/**
 * 検索条件の「今日」「昨日」「直近 N 日」のような、今日を基準にした期間。
 * 起動したまま日付をまたいでも、押した時点・日付が変わった時点の今日で計算し直すために、
 * 日数のずれ（今日 = 0）と、最後に当てはめた日付を持つ。
 */
export type RelRange = { fromOffset: number; toOffset: number; from: string; to: string };

/** 今日（`now`）を基準に、from = 今日+fromOffset、to = 今日+toOffset の期間を作る。 */
export function makeRel(fromOffset: number, toOffset: number, now: Date): RelRange {
  return {
    fromOffset,
    toOffset,
    from: ymd(addDays(now, fromOffset)),
    to: ymd(addDays(now, toOffset)),
  };
}

/**
 * 入力欄が、最後に当てはめた期間のまま（利用者が触っていない）で、日付が変わっていれば、
 * 新しい今日で計算し直した期間を返す。触られている・日付が変わっていないときは null。
 */
export function rollRel(rel: RelRange | null, current: { from: string; to: string }, now: Date): RelRange | null {
  if (!rel || current.from !== rel.from || current.to !== rel.to) return null;
  const next = makeRel(rel.fromOffset, rel.toOffset, now);
  return next.from === rel.from && next.to === rel.to ? null : next;
}
