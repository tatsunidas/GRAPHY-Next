/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QCA のエッジを**まとめて**直すブラシ（`fw/angio-design.md` §8.8）。純関数だけを置く。
 *
 * <h3>なぜ要るのか（実機で言われた・2026-08-27）</h3>
 * エッジの手修正は 1 点ずつ掴んで法線方向へ引く作りだった。計測点は数百あるので、
 * **自動エッジが外れた区間を直すのに何十回もドラッグする**ことになり、実用に耐えない。
 *
 * <h3>どう動かすか — 「押す」のであって「置く」のではない</h3>
 * 掴んだ点の**移動量 Δ** を、中心線に沿って近い点へ**重みを付けて配る**:
 *
 * <pre>
 *   offset_i ← offset_i + Δ · w(距離_i)
 * </pre>
 *
 * <p>🔴 **各点にポインタ位置を直接当てはめない。** 法線の向きは点ごとに違うので、
 * 離れた点にポインタの射影を当てると**血管の曲がりに沿って捻れる**。
 * 「いまの形からどれだけ動かすか」を配れば、**もとの形は保たれたまま区間全体が押される**。
 *
 * <p>重みは**弧長**（`QcaResult.positions`）で測る。計測点の番号で測ると、点の間隔が
 * 変わったときにブラシの効く範囲が変わってしまう。
 */

/** 重みの形。中心で 1、半径で 0、両端で傾き 0（＝境目に段差が出ない）。純関数。 */
export function brushWeight(distance: number, radius: number): number {
  if (!(radius > 0)) return distance === 0 ? 1 : 0;
  const d = Math.abs(distance);
  if (d >= radius) return 0;
  return 0.5 * (1 + Math.cos((Math.PI * d) / radius));
}

/** ブラシ 1 回ぶんの結果（そのまま `edgeEdits` へマージできる形）。 */
export interface BrushedEdge {
  pathIndex: number;
  side: "left" | "right";
  offset: number;
}

export interface BrushInput {
  /** 各計測点の弧長（`QcaResult.positions`。単位は mm または px）。 */
  positions: readonly number[];
  /** 計測点 → 中心線（path）インデックス（`QcaResult.pathIndices`）。 */
  pathIndices: readonly number[];
  /** 各計測点の現在のエッジ位置（`QcaResult.edgeOffsets`）。 */
  edgeOffsets: readonly { left: number; right: number }[];
  /** 掴んだ計測点。 */
  centerIndex: number;
  /** どちら側のエッジか。 */
  side: "left" | "right";
  /** 掴んだ点での**目標**オフセット（ポインタを法線へ射影した値）。 */
  targetOffset: number;
  /** ブラシ半径（`positions` と同じ単位）。 */
  radius: number;
}

/**
 * ブラシを 1 回当てた結果を返す。純関数。
 *
 * <p>掴んだ点は必ず目標値になり、そこから半径まで滑らかに減衰する。半径の外は触らない
 * （＝結果に含めない。含めると「動かしていないのに手修正済み」になる）。
 *
 * <p>符号は中心線をまたげない（左は負・右は正）。ここで潰すと径が 0 になる。
 */
export function brushEdges(input: BrushInput): BrushedEdge[] {
  const { positions, pathIndices, edgeOffsets, centerIndex, side, targetOffset, radius } = input;
  const n = Math.min(positions.length, pathIndices.length, edgeOffsets.length);
  if (centerIndex < 0 || centerIndex >= n) return [];
  const current = edgeOffsets[centerIndex][side];
  const delta = targetOffset - current;
  if (!Number.isFinite(delta) || delta === 0) return [];

  const p0 = positions[centerIndex];
  const out: BrushedEdge[] = [];
  for (let i = 0; i < n; i++) {
    const w = brushWeight(positions[i] - p0, radius);
    if (w <= 0) continue;
    const next = edgeOffsets[i][side] + delta * w;
    // 中心線をまたがせない（またぐと径が負になる）。
    const clamped = side === "left" ? Math.min(-0.25, next) : Math.max(0.25, next);
    out.push({ pathIndex: pathIndices[i], side, offset: clamped });
  }
  return out;
}

/** ブラシ半径の既定値（`positions` の単位＝校正済みなら mm）。冠動脈の径 2〜4mm に対して控えめ。 */
export const DEFAULT_BRUSH_RADIUS_MM = 1.5;
/** 未校正（px）のときの既定値。 */
export const DEFAULT_BRUSH_RADIUS_PX = 8;

/** 単位に応じた既定半径。純関数。 */
export function defaultBrushRadius(unit: "mm" | "px"): number {
  return unit === "mm" ? DEFAULT_BRUSH_RADIUS_MM : DEFAULT_BRUSH_RADIUS_PX;
}

/**
 * ブラシの結果を既存の手修正へマージする。純関数。
 *
 * <p>後から当てたブラシが勝つ（同じ点を 2 度なぞったら 2 度目が残る）。
 */
export function mergeEdgeEdits(
  current: Readonly<Record<number, { left?: number; right?: number }>>,
  brushed: readonly BrushedEdge[],
): Record<number, { left?: number; right?: number }> {
  const next: Record<number, { left?: number; right?: number }> = { ...current };
  for (const b of brushed) {
    next[b.pathIndex] = { ...next[b.pathIndex], [b.side]: b.offset };
  }
  return next;
}
