/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3 本指の縦ドラッグ → スライス送りの量を求める純関数（`fw/mobile-ui-design.md` §3.3）。
 *
 * <p>⚠️ **Cornerstone の `StackScrollTool` は使わない。** 表示スライスは `SeriesViewer` の
 * React state（z）が唯一の出所で、ツールが viewport の `imageIdIndex` を直接動かすと
 * 次の再描画で巻き戻る。ジェスチャの解釈だけをここで行い、状態更新は `SeriesViewer` に任せる。
 */

/** 1 スライス送るのに要る縦移動量 [px]。 */
export const SLICE_STEP_PX = 12;

/**
 * 起点からの縦移動量 [px] を送りスライス数へ。**下へなぞる = 正（次のスライス）**でホイールと同じ向き。
 *
 * <p>端数は切り捨てる（`Math.trunc`。負方向でも 0 に向かって丸める）。`Math.floor` だと
 * 上方向のわずかな揺れで −1 が出て、指を止めていてもスライスが動く。
 */
export function sliceStepsFromDrag(dy: number, stepPx: number = SLICE_STEP_PX): number {
  if (!Number.isFinite(dy) || !(stepPx > 0)) return 0;
  const steps = Math.trunc(dy / stepPx);
  // Math.trunc(-0.5) は -0 を返す。呼び出し側を驚かせないよう +0 に正規化する。
  return steps === 0 ? 0 : steps;
}

/**
 * 送った分だけ起点を進める（**端数は残す**）。
 * 起点を現在位置へ丸ごと移すと、切り捨てた端数が毎回捨てられて連続送りが引っかかる。
 */
export function advanceAnchor(anchorY: number, steps: number, stepPx: number = SLICE_STEP_PX): number {
  return anchorY + steps * stepPx;
}
