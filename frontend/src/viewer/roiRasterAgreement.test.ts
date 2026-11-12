/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI → マスクのラスタ化が、ROI 統計と同じ図形・同じ規則（画素中心の偶奇判定）で塗ること。
 * 真値は mm の図形から手計算する。ハンドルは「mm の点を画素間隔で割った画素座標」。
 */
import { describe, it, expect } from "vitest";
import { rasterizeRoiPx } from "./roiRaster";
import { buildRoiMesh, sampleInsideMeshIndices } from "./roiStats";
import { seedPixelOf } from "./seedPixel";
import { ovalOrRectShape } from "./imagejExport";
import type { PointPx } from "./roiRead";

const COL = 0.6, ROW = 0.9;
const BASIS = { col: COL, row: ROW };
const px = (xMm: number, yMm: number): PointPx => [xMm / COL, yMm / ROW];
const cols = 160, rows = 110;

function count(fg: Uint8Array): number {
  let n = 0;
  for (const v of fg) n += v;
  return n;
}

describe("矩形のマスク化", () => {
  // 辺が画素の途中（0.3 / 0.7）に乗る矩形。x: 10.13..31.07 mm、y: 8.05..22.95 mm
  const x0 = 10.13, x1 = 31.07, y0 = 8.05, y1 = 22.95;
  const rect: PointPx[] = [px(x0, y0), px(x1, y0), px(x1, y1), px(x0, y1)];

  it("塗る画素 = 画素中心が矩形の内側の画素（外側 0・内側の未塗り 0）", () => {
    const fg = rasterizeRoiPx("RectangleROI", rect, undefined, cols, rows, BASIS)!;
    let extra = 0, missing = 0, nIn = 0;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const cx = (x + 0.5) * COL, cy = (y + 0.5) * ROW;
        const inside = cx > x0 && cx < x1 && cy > y0 && cy < y1;
        if (inside) nIn++;
        if (inside && !fg[y * cols + x]) missing++;
        if (!inside && fg[y * cols + x]) extra++;
      }
    expect(nIn).toBeGreaterThan(200);
    expect(extra).toBe(0);
    expect(missing).toBe(0);
  });

  it("画素数 × 画素面積と 幅×高さ の差が 周長 × 最大辺 / 2 以内", () => {
    const fg = rasterizeRoiPx("RectangleROI", rect, undefined, cols, rows, BASIS)!;
    const w = x1 - x0, h = y1 - y0;
    const bound = (2 * (w + h) * Math.max(COL, ROW)) / 2 + COL * ROW;
    expect(Math.abs(count(fg) * COL * ROW - w * h)).toBeLessThanOrEqual(bound);
  });

  it("統計の母集団（sampleInsideMeshIndices）と同じ画素集合", () => {
    const fg = rasterizeRoiPx("RectangleROI", rect, undefined, cols, rows, BASIS)!;
    const mesh = buildRoiMesh("RectangleROI", rect, undefined)!;
    const idx = new Set(sampleInsideMeshIndices(mesh, new Float32Array(cols * rows), cols, rows));
    expect(idx.size).toBe(count(fg));
    for (const i of idx) expect(fg[i]).toBe(1);
  });

  it("ハンドルの並びが入れ替わっても（操作したハンドルで変わる）同じ", () => {
    const a = rasterizeRoiPx("RectangleROI", rect, undefined, cols, rows, BASIS)!;
    const b = rasterizeRoiPx("RectangleROI", [rect[2], rect[0], rect[3], rect[1]], undefined, cols, rows, BASIS)!;
    expect(count(b)).toBe(count(a));
  });

  it("負例: 外接 bbox の全画素で塗る旧式は、外側の画素を塗る（検査が効いている）", () => {
    const xs = rect.map((p) => p[0]), ys = rect.map((p) => p[1]);
    const old = new Uint8Array(cols * rows);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++)
      for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) old[y * cols + x] = 1;
    const fg = rasterizeRoiPx("RectangleROI", rect, undefined, cols, rows, BASIS)!;
    expect(count(old)).toBeGreaterThan(count(fg));
  });
});

describe("楕円・多角形のマスク化", () => {
  it("楕円: 画素中心が mm の楕円の内側 = 塗る（境界 ±0.02 を除く）。回転表示（ハンドルの軸が入れ替わる）でも同じ面積", () => {
    const a = 12, b = 7, cx = 30, cy = 30;
    const upright = [px(cx, cy + b), px(cx, cy - b), px(cx - a, cy), px(cx + a, cy)];
    const fg = rasterizeRoiPx("EllipticalROI", upright, undefined, cols, rows, BASIS)!;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        const nx = ((x + 0.5) * COL - cx) / a, ny = ((y + 0.5) * ROW - cy) / b;
        const r = nx * nx + ny * ny;
        if (r < 0.98) expect(fg[y * cols + x]).toBe(1);
        if (r > 1.02) expect(fg[y * cols + x]).toBe(0);
      }
    // 90° 回転表示: 4 ハンドルの役割が入れ替わる（下・上が左・右の位置へ）。面積は同じ
    const swapped = [upright[2], upright[3], upright[0], upright[1]];
    const fg2 = rasterizeRoiPx("EllipticalROI", swapped, undefined, cols, rows, BASIS)!;
    expect(Math.abs(count(fg2) - count(fg))).toBeLessThan(count(fg) * 0.03);
  });

  it("多角形（閉）は従来どおり画素中心の偶奇判定", () => {
    const tri: PointPx[] = [[10, 10], [30, 10], [10, 30]];
    const fg = rasterizeRoiPx("GraphyPolygonROI", tri, true, cols, rows)!;
    expect(fg[11 * cols + 11]).toBe(1); // 内側
    expect(fg[29 * cols + 29]).toBe(0); // 外側
  });

  it("面積を持たない ROI（Length・開いた輪郭）は null", () => {
    expect(rasterizeRoiPx("Length", [[1, 1], [5, 5]], undefined, cols, rows)).toBeNull();
    expect(rasterizeRoiPx("GraphyPolylineROI", [[1, 1], [5, 5], [9, 1]], false, cols, rows)).toBeNull();
  });
});

describe("シード画素（Wand・Level Sets）", () => {
  it("画素 5 の中のどこを押しても（4 象限）画素 5 を返す。round だと右半分で 6", () => {
    for (const dx of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      expect(seedPixelOf([5 + dx, 7 + dx], 20, 20)).toEqual([5, 7]);
    }
    expect(Math.round(5.7)).toBe(6); // 旧式（負例）
  });
  it("画像の外・非有限値は null", () => {
    expect(seedPixelOf([-0.01, 3], 20, 20)).toBeNull();
    expect(seedPixelOf([20, 3], 20, 20)).toBeNull();
    expect(seedPixelOf([3, 20.5], 20, 20)).toBeNull();
    expect(seedPixelOf([Number.NaN, 3], 20, 20)).toBeNull();
  });
});

describe("ImageJ 書き出しの oval / rect", () => {
  it("円: bbox = 中心 ± r/列間隔, r/行間隔（非正方画素）", () => {
    const r = 10;
    const s = ovalOrRectShape("CircleROI", "oval", [px(30, 30), px(30 + r, 30)], BASIS);
    if (s.kind !== "bbox") throw new Error("bbox expected");
    expect(s.bbox.bw).toBeCloseTo((2 * r) / COL, 2);
    expect(s.bbox.bh).toBeCloseTo((2 * r) / ROW, 2);
    expect(s.bbox.bx).toBeCloseTo((30 - r) / COL, 2);
    expect(s.bbox.by).toBeCloseTo((30 - r) / ROW, 2);
  });
  it("楕円（軸整列）は bbox、回転表示（整列しない）は polygon", () => {
    const a = 12, b = 7;
    const al = [px(30, 30 + b), px(30, 30 - b), px(30 - a, 30), px(30 + a, 30)];
    const s1 = ovalOrRectShape("EllipticalROI", "oval", al, BASIS);
    if (s1.kind !== "bbox") throw new Error("bbox expected");
    expect(s1.bbox.bw).toBeCloseTo((2 * a) / COL, 1);
    expect(s1.bbox.bh).toBeCloseTo((2 * b) / ROW, 1);
    const tilted: PointPx[] = [[50, 45], [50, 20], [30, 33], [70, 37]];
    expect(ovalOrRectShape("EllipticalROI", "oval", tilted, BASIS).kind).toBe("polygon");
  });
  it("矩形: 軸整列は bbox、傾いていれば polygon（凸包の 4 頂点）", () => {
    const s1 = ovalOrRectShape("RectangleROI", "rect", [[10, 10], [40, 10], [40, 30], [10, 30]]);
    if (s1.kind !== "bbox") throw new Error("bbox expected");
    expect(s1.bbox).toEqual({ bx: 10, by: 10, bw: 30, bh: 20 });
    const s2 = ovalOrRectShape("RectangleROI", "rect", [[20, 10], [40, 20], [30, 40], [10, 30]]);
    expect(s2.kind).toBe("polygon");
    if (s2.kind === "polygon") expect(s2.xs.length).toBe(4);
  });
});

describe("シード画素（幾何なしの画像）", () => {
  it("画素中心が整数の座標では round: 画素 5 の中（4.5〜5.5 未満）を押すと 5", () => {
    for (const dx of [-0.45, -0.2, 0, 0.2, 0.45]) {
      expect(seedPixelOf([5 + dx, 7 + dx], 20, 20, "center")).toEqual([5, 7]);
    }
    // 隅原点の floor を当てると、左半分で隣（4）を掴む（実機の失敗の再現）
    expect(Math.floor(5 - 0.3)).toBe(4);
  });
});
