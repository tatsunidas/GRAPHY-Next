/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 画像に重ねるオーバーレイの配置（純関数・DOM も cornerstone も import しない）。
 *
 * <p>`Viewer2D.tsx` から切り出してある。あちらは cornerstone を import するので
 * node の vitest から読めず、**配置の数値を自動テストで固定できない**。
 * 回転・反転の追従はまさに「目視でしか分からなかった」箇所なので、
 * ここだけは必ずブラウザ無しで検証できる状態に保つ。
 */

export interface ImageRect {
  /** 画像の左上隅（index (−0.5,−0.5)）の canvas 座標。**回転していても左上隅そのもの**。 */
  left: number;
  top: number;
  /** 回転前の画像の幅・高さ（canvas px）。列方向・行方向の実長。 */
  width: number;
  height: number;
  /**
   * 回転・反転を表す線形部 `[a, b, c, d]`（CSS `matrix(a,b,c,d,0,0)` と同じ並び）。
   *
   * <p>`left/top` に置いた `width × height` の箱を、`transform-origin: 0 0` で
   * この行列に掛けると画像の実際の平行四辺形に一致する。
   * **回転も反転も無いときは `[1,0,0,1]`（恒等）**なので、従来の
   * `left/top/width/height` だけの配置と完全に同じ結果になる。
   */
  linear: readonly [number, number, number, number];
}

/**
 * オーバーレイ要素を画像にぴったり重ねる CSS を作る。
 *
 * <p>回転・反転は `transform` の線形部で表す。軸並行 BBox に置くだけだと、
 * base を回したときにオーバーレイだけ回らずに残る（長らくの既知の限界だった）。
 * 手動位置合わせが入って、ズレが**調整量由来か未追従由来か**切り分けられなく
 * なったため直した。
 */
export function overlayPlacement(rect: ImageRect): {
  position: "absolute";
  left: number;
  top: number;
  width: number;
  height: number;
  transformOrigin: string;
  transform: string;
} {
  const [a, b, c, d] = rect.linear;
  return {
    position: "absolute",
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    transformOrigin: "0 0",
    transform: `matrix(${a}, ${b}, ${c}, ${d}, 0, 0)`,
  };
}
