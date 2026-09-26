/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slab MIP（厚板投影）の共通定義 — 2D ThickSlab / MPR / 3D SLAB で共有する（fw/slab-mip-design.md）。
 *
 * 厚みは常に<b>全幅 mm</b>（中心面から ±厚み/2）。スライス枚数ではなく mm で持つのは、Z 間隔が
 * 非等方なシリーズでも同じ臨床的意味（例: 肺結節 MIP 10mm）になるようにするため。
 *
 * 既定値の根拠:
 * - MIP 5mm: 冠動脈の長軸観察（角辻, インナービジョン 2009-10「Slab MIP で心臓 CT を診る！」）。
 * - 8〜10mm: 肺結節の検出感度が最良（Kawel 2009 AJR: 8mm / AJR 2019: 充実性 10mm MIP）。
 * - MinIP 3mm: 亜充実性結節・気道（AJR 2019: 3mm MinIP が最良）。
 * - 15〜20mm: CTA の慣行値。
 */

/** 投影方式。MIP=最大値 / MINIP=最小値 / AVG=平均（AvgIP）。 */
export type SlabProjection = "MIP" | "MINIP" | "AVG";

export const SLAB_PROJECTIONS: readonly SlabProjection[] = ["MIP", "MINIP", "AVG"];

/** UI に出すスラブ厚(mm)のプリセット（全幅）。 */
export const SLAB_THICKNESS_PRESETS_MM = [3, 5, 8, 10, 15, 20] as const;

/** 任意入力で受け付ける厚みの範囲(mm)。 */
export const SLAB_MIN_MM = 0.5;
export const SLAB_MAX_MM = 200;

/** 投影方式ごとの既定の厚み(mm)。 */
export function defaultSlabThickness(p: SlabProjection): number {
  return p === "MINIP" ? 3 : 5;
}

/** 任意入力の厚みを受理範囲へ丸める（非数は既定 5mm）。 */
export function clampSlabThickness(mm: number): number {
  if (!Number.isFinite(mm)) return 5;
  return Math.min(SLAB_MAX_MM, Math.max(SLAB_MIN_MM, mm));
}
