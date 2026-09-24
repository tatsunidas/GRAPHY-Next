/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 画面に見えている画像上の範囲（純関数・DOM も cornerstone も import しない）。
 *
 * <p>`overlayPlacement.ts` と同じ理由でここに切り出してある。`Viewer2D.tsx` は
 * cornerstone を import するので node の vitest から読めず、**幾何の数値を自動テストで
 * 固定できない**。回転・反転・拡大・パンの絡む計算はまさに「目視でしか分からない」種類で、
 * しかも間違っても例外にならず**枠が少しずれるだけ**なので、ここだけは必ず
 * ブラウザ無しで検証できる状態に保つ。
 *
 * <h3>world 座標を経由しない</h3>
 * 🔑 入力の {@link ImageRect} は **画像 index → canvas** の向きで作られている
 * （`Viewer2D.computeImageRect`）。この向きは `transformIndexToWorld` が vtk の格子を
 * 使うため **IPP/IOP に依存せず、幾何を持たない XA でも成立する**。
 * 逆向き（world → 画素）は XA で 1 点も変換できず計測が丸ごと落ちた実績があるので
 * （`roiRead.ts` の注記、2026-08-25 に実機で判明）、**こちらの向きだけを使う。**
 */
import type { ImageRect } from "./overlayPlacement";

/** 画面に見えている画像上の範囲。 */
export interface VisibleRegion {
  /**
   * 四隅の**画像画素座標**（0 origin＝最初の画素の中心が 0）。
   * 並びは**画面から見た** 左上・右上・左下・右下。
   * 回転・反転・拡大・パンはすべてこの 4 点に畳み込まれている。
   */
  corners: [number, number][];
  /** その範囲の画面上の大きさ（CSS px）。出力の縦横比に使う。 */
  screenWidth: number;
  screenHeight: number;
}

type Pt = [number, number];

function finite(...xs: number[]): boolean {
  return xs.every((x) => Number.isFinite(x));
}

/**
 * 凸多角形を軸並行矩形で切る（Sutherland–Hodgman）。
 *
 * <p>入力は凸（画像は平行四辺形）なので、出力も凸で頂点は高々 8 個。
 */
export function clipToRect(poly: Pt[], x0: number, y0: number, x1: number, y1: number): Pt[] {
  // 各辺: 内側判定と、辺との交点。
  const edges: { inside: (p: Pt) => boolean; cut: (a: Pt, b: Pt) => Pt }[] = [
    {
      inside: (p) => p[0] >= x0,
      cut: (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])],
    },
    {
      inside: (p) => p[0] <= x1,
      cut: (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])],
    },
    {
      inside: (p) => p[1] >= y0,
      cut: (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0],
    },
    {
      inside: (p) => p[1] <= y1,
      cut: (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1],
    },
  ];

  let out = poly;
  for (const e of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i];
      const prev = src[(i + src.length - 1) % src.length];
      const curIn = e.inside(cur);
      const prevIn = e.inside(prev);
      if (curIn) {
        if (!prevIn) out.push(e.cut(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(e.cut(prev, cur));
      }
    }
    if (out.length === 0) return [];
  }
  return out;
}

/**
 * 画面に見えている画像上の範囲を求める。
 *
 * <p>手順は 3 つだけ。
 *   1. 画像の平行四辺形（canvas 座標）を、ビューポートの矩形で切る
 *   2. 切った結果の**画面上の軸並行 BBox** を取る＝出力はスクリーン基準になるので、
 *      回転は「回って見える」まま出る
 *   3. その BBox の四隅を画像画素座標へ戻す
 *
 * <p>🔴 **画像の外側（Fit のときの黒帯）は 1 で落ちる。** 何も操作していないときは
 * 画像の矩形そのものが残るので、**従来どおり画像ぴったり**が出る。拡大していれば
 * ビューポート側が効いて、見えている範囲だけが残る。
 *
 * @param rect 画像の表示矩形（`Viewer2D.computeImageRect` の戻り）
 * @param cols 画像の列数（画素）
 * @param rows 画像の行数（画素）
 * @param viewportWidth  表示領域の幅（CSS px）
 * @param viewportHeight 表示領域の高さ（CSS px）
 * @returns 求まらなければ null（🔴 **分からないものを埋めない**。呼び出し側は画像全体へ落ちる）
 */
export function visibleImageRegion(
  rect: ImageRect | null | undefined,
  cols: number,
  rows: number,
  viewportWidth: number,
  viewportHeight: number,
): VisibleRegion | null {
  if (!rect) return null;
  if (!(cols > 0) || !(rows > 0)) return null;
  if (!(viewportWidth > 0) || !(viewportHeight > 0)) return null;
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  const [a, b, c, d] = rect.linear;
  if (!finite(rect.left, rect.top, rect.width, rect.height, a, b, c, d)) return null;

  // 画像の 2 辺ベクトル（canvas 座標・全長）。回転・反転はここに入っている。
  const U: Pt = [a * rect.width, b * rect.width];
  const V: Pt = [c * rect.height, d * rect.height];
  const o: Pt = [rect.left, rect.top];

  // 1) 画像の平行四辺形をビューポートで切る。
  const quad: Pt[] = [
    o,
    [o[0] + U[0], o[1] + U[1]],
    [o[0] + U[0] + V[0], o[1] + U[1] + V[1]],
    [o[0] + V[0], o[1] + V[1]],
  ];
  const clipped = clipToRect(quad, 0, 0, viewportWidth, viewportHeight);
  if (clipped.length < 3) return null; // 画面の外（見えていない）

  // 2) 画面上の軸並行 BBox。出力をスクリーン基準にするので回転が回って見える。
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of clipped) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1];
    if (p[1] > y1) y1 = p[1];
  }
  const screenWidth = x1 - x0;
  const screenHeight = y1 - y0;
  if (!(screenWidth > 0) || !(screenHeight > 0)) return null;

  // 3) BBox の四隅を画像画素座標へ戻す。o + s·U + t·V = p を解く。
  const det = U[0] * V[1] - U[1] * V[0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-9) return null;

  const toImagePx = (p: Pt): Pt => {
    const dx = p[0] - o[0];
    const dy = p[1] - o[1];
    const s = (dx * V[1] - dy * V[0]) / det;
    const t = (U[0] * dy - U[1] * dx) / det;
    // s,t は 0..1 の辺沿い比率。画素座標は「最初の画素の中心が 0」なので -0.5 する。
    return [s * cols - 0.5, t * rows - 0.5];
  };

  const corners: Pt[] = [
    toImagePx([x0, y0]),
    toImagePx([x1, y0]),
    toImagePx([x0, y1]),
    toImagePx([x1, y1]),
  ];
  for (const p of corners) {
    if (!finite(p[0], p[1])) return null;
  }

  return { corners, screenWidth, screenHeight };
}
