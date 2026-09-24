/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 「画面に見えている画像上の範囲」の検査。
 *
 * <p>ここが狂っても**例外にはならず、送られる画像の枠が少しずれるだけ**なので、
 * 目視では気付けない。数値で固定しておく。
 */
import { describe, it, expect } from "vitest";
import { clipToRect, visibleImageRegion } from "./visibleRegion";
import type { ImageRect } from "./overlayPlacement";

/** 画像の 3 隅（canvas 座標）から `ImageRect` を作る（`computeImageRect` と同じ規則）。 */
function rectFrom(tl: [number, number], tr: [number, number], bl: [number, number]): ImageRect {
  const ux = tr[0] - tl[0], uy = tr[1] - tl[1];
  const vx = bl[0] - tl[0], vy = bl[1] - tl[1];
  const width = Math.hypot(ux, uy);
  const height = Math.hypot(vx, vy);
  return {
    left: tl[0], top: tl[1], width, height,
    linear: [ux / width, uy / width, vx / height, vy / height],
  };
}

/** 四隅を小数 3 桁で丸めて比較しやすくする。 */
const round = (c: [number, number][]) => c.map(([x, y]) => [Math.round(x * 1e3) / 1e3, Math.round(y * 1e3) / 1e3]);

describe("clipToRect", () => {
  it("完全に内側なら形が変わらない", () => {
    const poly: [number, number][] = [[10, 10], [50, 10], [50, 40], [10, 40]];
    expect(clipToRect(poly, 0, 0, 100, 100)).toEqual(poly);
  });

  it("はみ出した分だけ切られる", () => {
    const poly: [number, number][] = [[-20, -20], [50, -20], [50, 40], [-20, 40]];
    const out = clipToRect(poly, 0, 0, 100, 100);
    for (const [x, y] of out) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
    }
  });

  it("完全に外なら空", () => {
    const poly: [number, number][] = [[200, 200], [300, 200], [300, 300], [200, 300]];
    expect(clipToRect(poly, 0, 0, 100, 100)).toEqual([]);
  });
});

describe("visibleImageRegion", () => {
  // 512x512 の画像が 800x600 のビューポートに Fit している状態。
  // 高さ 600 に合わせて 600x600 で描かれ、左右に 100px ずつ黒帯が出る。
  const FIT = rectFrom([100, 0], [700, 0], [100, 600]);

  it("🔴 Fit のときは画像ぴったり（黒帯を含まない）", () => {
    const r = visibleImageRegion(FIT, 512, 512, 800, 600);
    expect(r).not.toBeNull();
    // 四隅が画像の外形（-0.5 .. 511.5）に一致する＝余白が落ちている。
    expect(round(r!.corners)).toEqual([
      [-0.5, -0.5], [511.5, -0.5], [-0.5, 511.5], [511.5, 511.5],
    ]);
    // 画面上は 600x600 の正方形。
    expect(r!.screenWidth).toBeCloseTo(600);
    expect(r!.screenHeight).toBeCloseTo(600);
  });

  it("拡大してビューポートを埋めたら、見えている範囲だけになる", () => {
    // 2 倍に拡大（1200x1200）して中央に置くと、ビューポート 800x600 が全部画像。
    const zoomed = rectFrom([-200, -300], [1000, -300], [-200, 900]);
    const r = visibleImageRegion(zoomed, 512, 512, 800, 600);
    expect(r).not.toBeNull();
    expect(r!.screenWidth).toBeCloseTo(800);
    expect(r!.screenHeight).toBeCloseTo(600);
    // 画像 1200px = 512 画素なので、800px 幅 → 341.33 画素ぶん。
    const [tl, tr] = r!.corners;
    expect(tr[0] - tl[0]).toBeCloseTo((800 / 1200) * 512, 3);
  });

  it("パンすると切り出しの中心がずれる", () => {
    const centered = rectFrom([-200, -300], [1000, -300], [-200, 900]);
    const panned = rectFrom([-300, -300], [900, -300], [-300, 900]); // 左へ 100px
    const a = visibleImageRegion(centered, 512, 512, 800, 600)!;
    const b = visibleImageRegion(panned, 512, 512, 800, 600)!;
    // 画像を左へずらす＝見える範囲は右へ動く。
    expect(b.corners[0][0]).toBeGreaterThan(a.corners[0][0]);
    expect(b.corners[0][0] - a.corners[0][0]).toBeCloseTo((100 / 1200) * 512, 3);
  });

  it("左右反転すると、左上に来るのが画像の右端になる", () => {
    // U を反転（tr が左側）。
    const flipped = rectFrom([700, 0], [100, 0], [700, 600]);
    const r = visibleImageRegion(flipped, 512, 512, 800, 600)!;
    const [tl, tr] = r.corners;
    expect(tl[0]).toBeCloseTo(511.5, 3);
    expect(tr[0]).toBeCloseTo(-0.5, 3);
  });

  it("上下反転すると、左上に来るのが画像の下端になる", () => {
    const flipped = rectFrom([100, 600], [700, 600], [100, 0]);
    const r = visibleImageRegion(flipped, 512, 512, 800, 600)!;
    const [tl, , bl] = r.corners;
    expect(tl[1]).toBeCloseTo(511.5, 3);
    expect(bl[1]).toBeCloseTo(-0.5, 3);
  });

  it("90 度回転しても画像ぴったりで、行と列が入れ替わる", () => {
    // 列方向が画面の下向き、行方向が画面の左向き＝時計回り 90 度。
    // 512x512 が 600x600 で描かれ、左上隅は右上に来る。
    const rotated = rectFrom([700, 0], [700, 600], [100, 0]);
    const r = visibleImageRegion(rotated, 512, 512, 800, 600)!;
    expect(r.screenWidth).toBeCloseTo(600);
    expect(r.screenHeight).toBeCloseTo(600);
    // 画面の左上は、画像の (x=-0.5, y=511.5) 付近（＝元の左下）。
    const [tl] = r.corners;
    expect(tl[0]).toBeCloseTo(-0.5, 3);
    expect(tl[1]).toBeCloseTo(511.5, 3);
  });

  it("画面の外へ出ていたら null（見えていないものを埋めない）", () => {
    const off = rectFrom([2000, 2000], [2600, 2000], [2000, 2600]);
    expect(visibleImageRegion(off, 512, 512, 800, 600)).toBeNull();
  });

  it("退化した入力は null", () => {
    expect(visibleImageRegion(null, 512, 512, 800, 600)).toBeNull();
    expect(visibleImageRegion(FIT, 0, 512, 800, 600)).toBeNull();
    expect(visibleImageRegion(FIT, 512, 512, 0, 600)).toBeNull();
    expect(visibleImageRegion(rectFrom([0, 0], [0, 0], [0, 0]), 512, 512, 800, 600)).toBeNull();
  });

  it("非正方の画像でも縦横が入れ替わらない", () => {
    // 1024x512 の画像。Fit で 800x400 に描かれる。
    const rect = rectFrom([0, 100], [800, 100], [0, 500]);
    const r = visibleImageRegion(rect, 1024, 512, 800, 600)!;
    expect(round(r.corners)).toEqual([
      [-0.5, -0.5], [1023.5, -0.5], [-0.5, 511.5], [1023.5, 511.5],
    ]);
  });
});
