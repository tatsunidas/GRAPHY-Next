import { describe, expect, it } from "vitest";
import {
  clampRect,
  sobelGradients,
  sobelMagnitude,
  structureTensorEigen,
  unsharpMask,
} from "./edgeFilters";

/** w×h の画像を作る（f(x,y) で値を決める）。 */
function img(w: number, h: number, f: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = f(x, y);
  return out;
}

describe("sobelGradients — 1 画素あたりの傾きに正規化してある", () => {
  it("★ f(x,y)=x の勾配は内部で gx=1 / gy=0", () => {
    const w = 16, h = 16;
    const { gx, gy } = sobelGradients(img(w, h, (x) => x), w, h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        expect(gx[y * w + x]).toBeCloseTo(1, 6);
        expect(gy[y * w + x]).toBeCloseTo(0, 6);
      }
    }
  });

  it("f(x,y)=3y の勾配は gy=3 / gx=0", () => {
    const w = 16, h = 16;
    const { gx, gy } = sobelGradients(img(w, h, (_x, y) => 3 * y), w, h);
    expect(gy[8 * w + 8]).toBeCloseTo(3, 6);
    expect(gx[8 * w + 8]).toBeCloseTo(0, 6);
  });

  it("一様な画像の勾配は 0（端を複製しているので縁にも段差が出ない）", () => {
    const w = 8, h = 8;
    const { gx, gy } = sobelGradients(img(w, h, () => 42), w, h);
    for (let i = 0; i < w * h; i++) {
      expect(gx[i]).toBeCloseTo(0, 6);
      expect(gy[i]).toBeCloseTo(0, 6);
    }
  });

  it("勾配強度は hypot(gx, gy)", () => {
    const w = 16, h = 16;
    const src = img(w, h, (x, y) => 3 * x + 4 * y);
    const mag = sobelMagnitude(src, w, h);
    expect(mag[8 * w + 8]).toBeCloseTo(5, 5);
  });
});

describe("structureTensorEigen — 追尾できる ROI かを追尾する前に判定する", () => {
  const w = 64, h = 64;
  const rect = { x0: 16, y0: 16, x1: 47, y1: 47 };

  it("🚨 一方向の縞だけなら lambda2 ≒ 0（アパーチャ問題）", () => {
    const stripes = img(w, h, (x, y) => 100 * Math.sin(((0.6 * x + 0.8 * y) * 2 * Math.PI) / 9));
    const t = structureTensorEigen(stripes, w, h, rect);
    expect(t.lambda1).toBeGreaterThan(1);
    expect(t.anisotropy).toBeLessThan(0.01);
  });

  it("向きの違う構造が重なっていれば lambda2 が立つ", () => {
    const mixed = img(w, h, (x, y) =>
      100 * Math.sin(((0.6 * x + 0.8 * y) * 2 * Math.PI) / 9) +
      120 * Math.exp(-(((x - 30) / 4) ** 2)) +
      80 * Math.sin((y * 2 * Math.PI) / 13));
    const t = structureTensorEigen(mixed, w, h, rect);
    expect(t.anisotropy).toBeGreaterThan(0.1);
  });

  it("一様な ROI は lambda1 も 0（無地）", () => {
    const flat = img(w, h, () => 500);
    const t = structureTensorEigen(flat, w, h, rect);
    expect(t.lambda1).toBeCloseTo(0, 9);
    expect(t.anisotropy).toBe(0);
  });
});

describe("unsharpMask", () => {
  it("段差の振幅を持ち上げる（amount=0 は恒等）", () => {
    const w = 32, h = 32;
    const step = img(w, h, (x) => (x < 16 ? 0 : 100));
    const same = unsharpMask(step, w, h, 1.5, 0);
    expect(same[10 * w + 20]).toBeCloseTo(step[10 * w + 20], 5);

    const sharp = unsharpMask(step, w, h, 1.5, 1.5);
    // 段差の明るい側は元より明るく、暗い側は元より暗くなる（オーバーシュート）。
    expect(sharp[10 * w + 16]).toBeGreaterThan(step[10 * w + 16]);
    expect(sharp[10 * w + 15]).toBeLessThan(step[10 * w + 15]);
  });
});

describe("clampRect", () => {
  it("画像の外へ出た矩形を内側へ丸める", () => {
    expect(clampRect({ x0: -5, y0: -5, x1: 100, y1: 100 }, 10, 10)).toEqual({ x0: 0, y0: 0, x1: 9, y1: 9 });
  });

  it("左右・上下が逆でも正規化する", () => {
    expect(clampRect({ x0: 7, y0: 8, x1: 2, y1: 3 }, 10, 10)).toEqual({ x0: 2, y0: 3, x1: 7, y1: 8 });
  });
});
