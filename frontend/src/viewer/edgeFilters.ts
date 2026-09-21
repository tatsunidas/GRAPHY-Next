/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D の勾配・エッジ強調と構造テンソル（`fw/angio-design.md` §6.7）。**純関数だけ**。
 *
 * <p>DOM も Cornerstone も import しない。{@link ./xaTracking} と、将来の DSA のエッジ
 * 位置合わせ（Phase 3）が共用する。
 *
 * <h3>ガウシアンをここに置かない ★</h3>
 * 平滑化は {@link ./dsa#blurSeparable} を使う。リポジトリには既に 3 本のガウシアンがあり
 * （`dsa.ts` / `levelSetsCore.ts` / `regGeometry.ts`）、4 本目を足すと「どれで平滑化したか」で
 * 数値が変わる。DSA の探索が σ=0.8 で踏んだ教訓（端数シフトへの引き込み）は `dsa.ts` に
 * 書いてあるので、**同じ実装を共有していること自体が仕様**である。
 */

import { blurSeparable } from "./dsa";

/**
 * 矩形（画像 px・端を含む）。
 *
 * <p>`timiFrameCount.ts` の `TimiRect` と構造が同じなので、そのまま渡せる（構造的型付け）。
 * 名前を分けているのは、こちらが TIMI とは無関係の汎用ユーティリティだからである。
 */
export interface PixelRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 矩形を画像内へ丸める（端を含む整数範囲にする）。 */
export function clampRect(rect: PixelRect, width: number, height: number): PixelRect {
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(Math.min(rect.x0, rect.x1))));
  const x1 = Math.max(0, Math.min(width - 1, Math.ceil(Math.max(rect.x0, rect.x1))));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(Math.min(rect.y0, rect.y1))));
  const y1 = Math.max(0, Math.min(height - 1, Math.ceil(Math.max(rect.y0, rect.y1))));
  return { x0, y0, x1, y1 };
}

/** 端は複製（`blurSeparable` と同じ規約。黒縁を作らないため）。 */
function clampIndex(v: number, hi: number): number {
  return v < 0 ? 0 : v > hi ? hi : v;
}

/**
 * Sobel の勾配成分。**1 画素あたりの傾き**になるよう 1/8 で正規化してある
 * （`f(x,y)=x` を入れると `gx` が全域で 1.0 になる）。正規化しないと σ や画像サイズを
 * 変えたときに閾値が意味を失う。
 */
export function sobelGradients(
  src: Float32Array,
  width: number,
  height: number,
): { gx: Float32Array; gy: Float32Array } {
  const gx = new Float32Array(src.length);
  const gy = new Float32Array(src.length);
  for (let y = 0; y < height; y++) {
    const ym = clampIndex(y - 1, height - 1) * width;
    const y0 = y * width;
    const yp = clampIndex(y + 1, height - 1) * width;
    for (let x = 0; x < width; x++) {
      const xm = clampIndex(x - 1, width - 1);
      const xp = clampIndex(x + 1, width - 1);
      const a = src[ym + xm], b = src[ym + x], c = src[ym + xp];
      const d = src[y0 + xm], /* e */ f = src[y0 + xp];
      const g = src[yp + xm], h = src[yp + x], i = src[yp + xp];
      gx[y0 + x] = (-a + c - 2 * d + 2 * f - g + i) / 8;
      gy[y0 + x] = (-a - 2 * b - c + g + 2 * h + i) / 8;
    }
  }
  return { gx, gy };
}

/** 勾配強度 `sqrt(gx^2 + gy^2)`。 */
export function sobelMagnitude(src: Float32Array, width: number, height: number): Float32Array {
  const { gx, gy } = sobelGradients(src, width, height);
  const out = new Float32Array(src.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.hypot(gx[i], gy[i]);
  return out;
}

/**
 * アンシャープマスク `out = src + amount * (src - blur(src))`。
 *
 * <p>DSA の目視用。**追尾の前処理には使わない**——ノイズも一緒に持ち上がるので、
 * 相関のピークがノイズで尖ってしまい、信頼度の判定（{@link structureTensorEigen}）が
 * 甘くなる。追尾は {@link sobelMagnitude} を使うこと。
 */
export function unsharpMask(
  src: Float32Array,
  width: number,
  height: number,
  sigma: number,
  amount: number,
): Float32Array {
  const lowpass = blurSeparable(src, width, height, sigma);
  const out = new Float32Array(src.length);
  for (let i = 0; i < out.length; i++) out[i] = src[i] + amount * (src[i] - lowpass[i]);
  return out;
}

/** 構造テンソルの固有値（`lambda1 >= lambda2`）と主方向。 */
export interface StructureTensor {
  /** 大きいほうの固有値。 */
  lambda1: number;
  /**
   * 小さいほうの固有値。**これが 0 に近い＝一方向の構造しか無い＝アパーチャ問題**。
   * 帯に沿った平行移動は像を変えないので、どんな推定器でも位置を決められない。
   */
  lambda2: number;
  /** `lambda2 / lambda1`。スケール不変なので閾値に使えるのはこちら。 */
  anisotropy: number;
  /** 主方向（`lambda1` 側の固有ベクトルの角度 [rad]）。 */
  orientationRad: number;
}

/**
 * 矩形の中の構造テンソル `J = Σ [[gx², gxgy], [gxgy, gy²]]`（画素数で割った平均）。
 *
 * <p>Shi-Tomasi の「良い特徴点」と同じ量である。**追尾できる ROI かどうかを、追尾する前に
 * 判定する**ために使う。
 *
 * <p>🚨 `fw/angio-design.md` §6.4.1 の罠 1 と同じ話——GNBP-XA-2 の背景が斜めの帯 2 本だけ
 * だったため、帯に沿った体動が**原理的に回収できなかった**。当時はファントム側の欠陥として
 * 背景を作り直したが、**実データでは ROI の置き場所次第で普通に起きる**。だからこちらは
 * 「作り直す」のではなく「**その ROI では測れないと言う**」ために測る。
 *
 * <p>入力は**平滑化済みの生画像**を渡すこと（勾配強度像ではない。勾配の勾配になってしまう）。
 */
export function structureTensorEigen(
  src: Float32Array,
  width: number,
  height: number,
  rect: PixelRect,
): StructureTensor {
  const { gx, gy } = sobelGradients(src, width, height);
  return structureTensorFromGradients(gx, gy, width, height, rect);
}

/**
 * 勾配を計算済みのときの {@link structureTensorEigen}。
 *
 * <p>🚨 **タイルを総なめする用途では必ずこちらを使う。** `structureTensorEigen` は矩形 1 つに
 * つき画像全体の Sobel を回すので、タイル数 × 画像サイズになって実用にならない
 * （`suggestTrackingRois` が 200 タイル以上を評価する）。
 */
export function structureTensorFromGradients(
  gx: Float32Array,
  gy: Float32Array,
  width: number,
  height: number,
  rect: PixelRect,
): StructureTensor {
  const r = clampRect(rect, width, height);
  let jxx = 0, jxy = 0, jyy = 0, n = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    const row = y * width;
    for (let x = r.x0; x <= r.x1; x++) {
      const a = gx[row + x];
      const b = gy[row + x];
      jxx += a * a;
      jxy += a * b;
      jyy += b * b;
      n++;
    }
  }
  if (n === 0) return { lambda1: 0, lambda2: 0, anisotropy: 0, orientationRad: 0 };
  jxx /= n; jxy /= n; jyy /= n;
  const tr = jxx + jyy;
  const diff = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy);
  const lambda1 = (tr + diff) / 2;
  const lambda2 = Math.max(0, (tr - diff) / 2);
  return {
    lambda1,
    lambda2,
    anisotropy: lambda1 > 1e-20 ? lambda2 / lambda1 : 0,
    orientationRad: 0.5 * Math.atan2(2 * jxy, jxx - jyy),
  };
}
