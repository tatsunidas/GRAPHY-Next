/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI・マスクの幾何を、**実装と独立な解析解**で確かめる（幾何検証・段 2）。
 *
 * 真値は患者座標（mm）の図形から手計算で出す（円 πr²、楕円 πab、立方体の辺）。
 * ハンドルは「mm の図形を、画素間隔で割って画素座標にした点」として作る。
 * Cornerstone の円・楕円は mm 空間（world）の図形なので、画素間隔が非正方でも mm の円・楕円になる。
 */
import { describe, it, expect } from "vitest";
import { computeRoiStatsFrom } from "./roiStats";
import type { PointPx } from "./roiRead";

// 非正方画素: 行間隔 0.9・列間隔 0.6（PixelSpacing = [行, 列]）。x は列、y は行。
const COL_MM = 0.6;
const ROW_MM = 0.9;
const toPx = (xMm: number, yMm: number): PointPx => [xMm / COL_MM, yMm / ROW_MM];

function areaOf(tool: string, pts: PointPx[]): number | undefined {
  const r = computeRoiStatsFrom({
    roiUid: "t", tool, imageId: "x", pointsPx: pts, unit: "HU",
    spacingX: COL_MM, spacingY: ROW_MM, worldBasis: { col: COL_MM, row: ROW_MM },
  });
  return r.geometry.areaMm2;
}

describe("円 ROI の面積（非正方画素・mm の円）", () => {
  const r = 10; // mm
  const truth = Math.PI * r * r;
  // 中心 (30,30) mm。縁のハンドルを mm 空間の 3 方向（+x / +y / 斜め 45°）に置く。
  const cases: Array<[string, number, number]> = [
    ["縁が +x（列）方向", r, 0],
    ["縁が +y（行）方向", 0, r],
    ["縁が 45° 方向", r / Math.SQRT2, r / Math.SQRT2],
  ];
  for (const [name, dx, dy] of cases) {
    it(`${name}: 面積 = πr²`, () => {
      const a = areaOf("CircleROI", [toPx(30, 30), toPx(30 + dx, 30 + dy)]);
      expect(a).toBeDefined();
      expect(Math.abs(a! - truth) / truth).toBeLessThan(1e-3);
    });
  }
  it("正方画素なら向きによらず πr²（対照）", () => {
    const sq = (x: number, y: number): PointPx => [x / 0.75, y / 0.75];
    const r1 = computeRoiStatsFrom({
      roiUid: "t", tool: "CircleROI", imageId: "x", pointsPx: [sq(30, 30), sq(40, 30)], unit: "HU",
      spacingX: 0.75, spacingY: 0.75,
    });
    expect(Math.abs(r1.geometry.areaMm2! - truth) / truth).toBeLessThan(1e-3);
  });
});

describe("楕円 ROI の面積（非正方画素）", () => {
  const a = 12, b = 7; // mm 半軸（x 向き a、y 向き b）
  const truth = Math.PI * a * b;
  it("mm の楕円（4 ハンドル）の面積 = πab", () => {
    // handles = [bottom, top, left, right]（Cornerstone の順）
    const pts = [toPx(30, 30 + b), toPx(30, 30 - b), toPx(30 - a, 30), toPx(30 + a, 30)];
    const area = areaOf("EllipticalROI", pts);
    expect(Math.abs(area! - truth) / truth).toBeLessThan(1e-3);
  });
});
