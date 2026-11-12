/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 円 ROI は world（mm）空間の円。画素間隔が非正方（行 ≠ 列）でも、面積・周長・塗る画素が mm の円（πr²）になること。
 * 真値は mm の図形から手計算する（実装と同じ式を期待値に使わない）。ハンドルは「mm の点を画素間隔で割った画素座標」。
 */
import { describe, it, expect } from "vitest";
import { computeRoiStatsFrom, buildRoiMesh, meshAreaMm2, meshLengthMm } from "./roiStats";
import { rasterizeCircleFg } from "./roiCircleRaster";
import { maskPolygonFromResolved } from "./anonMaskExport";
import type { PointPx } from "./roiRead";

const COL = 0.6; // PixelSpacing[1]（列間隔。x）
const ROW = 0.9; // PixelSpacing[0]（行間隔。y）
const BASIS = { col: COL, row: ROW };
const px = (xMm: number, yMm: number): PointPx => [xMm / COL, yMm / ROW];
const R = 10; // mm
const AREA = Math.PI * R * R;
// 縁を mm 空間の +x / +y / 45° に置く
const EDGES: Array<[string, number, number]> = [
  ["+x（列）", R, 0],
  ["+y（行）", 0, R],
  ["45°", R / Math.SQRT2, R / Math.SQRT2],
];

describe("円 ROI の統計（非正方画素）", () => {
  for (const [name, dx, dy] of EDGES) {
    it(`縁が ${name}: 面積 = πr²、周長 = 2πr`, () => {
      const r = computeRoiStatsFrom({
        roiUid: "t", tool: "CircleROI", imageId: "x", unit: "HU",
        pointsPx: [px(30, 30), px(30 + dx, 30 + dy)],
        spacingX: COL, spacingY: ROW, worldBasis: BASIS,
      });
      expect(Math.abs(r.geometry.areaMm2! - AREA) / AREA).toBeLessThan(2e-3);
      const per = 2 * Math.PI * R;
      expect(Math.abs(r.geometry.perimeterMm! - per) / per).toBeLessThan(2e-3);
    });
  }

  it("基準間隔を渡さないと従来どおり画素空間の円（正方画素の対照）", () => {
    const sq = (x: number, y: number): PointPx => [x / 0.75, y / 0.75];
    const r = computeRoiStatsFrom({
      roiUid: "t", tool: "CircleROI", imageId: "x", unit: "HU",
      pointsPx: [sq(30, 30), sq(40, 30)], spacingX: 0.75, spacingY: 0.75,
    });
    expect(Math.abs(r.geometry.areaMm2! - AREA) / AREA).toBeLessThan(2e-3);
  });

  it("負例: 基準間隔の行と列を入れ替えると面積が崩れる（検査が効いている）", () => {
    const mesh = buildRoiMesh("CircleROI", [px(30, 30), px(30 + R, 30)], undefined, undefined, { col: ROW, row: COL })!;
    const a = meshAreaMm2(mesh, COL, ROW)!;
    expect(Math.abs(a - AREA) / AREA).toBeGreaterThan(0.2);
  });

  it("楕円 ROI は変更なしで πab（対照）", () => {
    const a = 12, b = 7;
    const r = computeRoiStatsFrom({
      roiUid: "t", tool: "EllipticalROI", imageId: "x", unit: "HU",
      pointsPx: [px(30, 30 + b), px(30, 30 - b), px(30 - a, 30), px(30 + a, 30)],
      spacingX: COL, spacingY: ROW, worldBasis: BASIS,
    });
    expect(Math.abs(r.geometry.areaMm2! - Math.PI * a * b) / (Math.PI * a * b)).toBeLessThan(2e-3);
    expect(meshLengthMm).toBeDefined();
  });
});

describe("円 ROI のラスタ化（マスク化）", () => {
  const cols = 120, rows = 90;
  for (const [name, dx, dy] of EDGES) {
    it(`縁が ${name}: 画素数 × 画素面積 ≈ πr²（上限は 周長 × 最大画素辺 / 2 + 画素面積）`, () => {
      const [c, e] = [px(30, 30), px(30 + dx, 30 + dy)];
      const fg = rasterizeCircleFg(c, e, cols, rows, BASIS);
      let n = 0;
      for (const v of fg) n += v;
      const pixArea = COL * ROW;
      const bound = (2 * Math.PI * R * Math.max(COL, ROW)) / 2 + pixArea;
      expect(Math.abs(n * pixArea - AREA)).toBeLessThanOrEqual(bound);
      // 画素中心が mm の円の内側にある画素だけが塗られている（全画素を独立に判定）
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          const dmm = Math.hypot((x + 0.5) * COL - 30, (y + 0.5) * ROW - 30);
          if (dmm < R - 1e-6) expect(fg[y * cols + x]).toBe(1);
          if (dmm > R + 1e-6) expect(fg[y * cols + x]).toBe(0);
        }
    });
  }

  it("負例: 行と列を入れ替えた基準では、mm の円の外側を塗る", () => {
    const fg = rasterizeCircleFg(px(30, 30), px(30 + R, 30), cols, rows, { col: ROW, row: COL });
    let outside = 0;
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++)
        if (fg[y * cols + x] && Math.hypot((x + 0.5) * COL - 30, (y + 0.5) * ROW - 30) > R + 1e-6) outside++;
    expect(outside).toBeGreaterThan(50);
  });

  it("等方（既定）の円は従来と同じ（半径 5 画素の画素数）", () => {
    const fg = rasterizeCircleFg([20, 20], [25, 20], 40, 40);
    let n = 0;
    for (const v of fg) n += v;
    expect(Math.abs(n - Math.PI * 25)).toBeLessThan(8);
  });
});

describe("匿名化の焼き込み多角形（円）", () => {
  it("非正方画素で、多角形の面積が mm の円（πr²）になる", () => {
    const r = maskPolygonFromResolved(
      "CircleROI", [px(30, 30), px(30 + R, 30)], undefined, "1.2.3", null, "wholeInstance", BASIS,
    );
    if (!("polygon" in r)) throw new Error("polygon expected");
    const { xs, ys } = r.polygon;
    let a2 = 0;
    for (let i = 0; i < xs.length; i++) {
      const j = (i + 1) % xs.length;
      a2 += xs[i] * ys[j] - xs[j] * ys[i];
    }
    const areaMm2 = (Math.abs(a2) / 2) * COL * ROW;
    expect(Math.abs(areaMm2 - AREA) / AREA).toBeLessThan(2e-3);
  });
});
