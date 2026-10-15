/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * マスクの範囲（scope.z）とスタックへの当てはめ。純関数（`fw/roi-mask-model.md` §10）。
 *
 * <ul>
 *   <li>演算・SPLIT・球・ROI→Mask の結果の {@code scope.z} は、入力のメタを引き継がず
 *       <b>前景のあるスライスから決める</b>（1 枚ならその番号、2 枚以上なら "all"）。</li>
 *   <li>1 スライスのマスクは「シリーズ全体の大きさに 1 枚だけ塗る」形と「1 枚だけのラベルマップ」形の
 *       2 通りがある。演算では各スライスを referencedImageId で元のスタックへ当てはめて、両方を同じに扱う。</li>
 * </ul>
 */

import { isSegmentForeground } from "./maskStatsCore";

/** 前景のあるスライス（スタック上の番号）から scope.z を決める。前景が無ければ null（メタを変えない）。 */
export function scopeZFromForeground(stackIndices: ReadonlyArray<number>): number | "all" | null {
  const uniq = new Set(stackIndices);
  if (uniq.size === 0) return null;
  if (uniq.size === 1) return [...uniq][0];
  return "all";
}

/**
 * マスクのスライス（sourceIds）を、元のスタック（target）の各スライスへ当てはめる。
 * 戻り値の [s] は target[s] に当たるマスク側の番号（無ければ -1）。target に無い sourceId があれば null。
 */
export function alignToStack(target: ReadonlyArray<string>, sourceIds: ReadonlyArray<string>): Int32Array | null {
  const pos = new Map<string, number>();
  target.forEach((id, s) => pos.set(id, s));
  const out = new Int32Array(target.length).fill(-1);
  for (let k = 0; k < sourceIds.length; k++) {
    const s = pos.get(sourceIds[k]);
    if (s === undefined) return null;
    out[s] = k;
  }
  return out;
}

export type BoolOp = "or" | "and" | "xor";

/** n 個の入力のうち cnt 個が前景のとき、結果が前景か。 */
export function boolOn(op: BoolOp, cnt: number, n: number): boolean {
  return op === "or" ? cnt > 0 : op === "and" ? cnt === n : cnt % 2 === 1;
}

/** 演算の入力 1 件のスライス。`labels` が null ならそのスライスは全背景。`segIndex` 指定時はその segment のみ前景。 */
export interface CombineInput {
  labels: ArrayLike<number> | null;
  segIndex?: number;
}

/**
 * 複数入力の 1 スライスを OR/AND/XOR で合成し、前景 1・背景 0 の Uint8 を返す。
 * 前景の定義は統計と同じ {@link isSegmentForeground}（segment 指定ならその値だけ）。
 */
export function combineLabelSlices(op: BoolOp, inputs: ReadonlyArray<CombineInput>, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    let cnt = 0;
    for (const inp of inputs) {
      if (inp.labels && i < inp.labels.length && isSegmentForeground(inp.labels[i], inp.segIndex)) cnt++;
    }
    if (boolOn(op, cnt, inputs.length)) out[i] = 1;
  }
  return out;
}
