/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 画素座標の原点は、幾何（IPP/IOP）の有無によらず「画素の左上隅が 0」（画素 i の中心が i+0.5）。
 * 幾何の無い画像（XA など）は world の原点が画素 (0,0) の中心なので、roiPointsPx のフォールバックで +0.5 して揃える。
 * 真値は物理的な画素の位置から手計算する（画素 (10, 20) の中心は、画素座標で (10.5, 20.5)）。
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@cornerstonejs/core", () => ({
  metaData: { get: () => ({ columnPixelSpacing: 0.6, rowPixelSpacing: 0.9 }) },
  cache: {},
  utilities: {},
  Enums: {},
}));
vi.mock("@cornerstonejs/tools", () => ({ annotation: { state: {} }, utilities: {}, Enums: {} }));

import { roiPointsPx, worldToPixelOnPlane } from "./roiRead";
import { computeRoiStatsFrom, buildRoiMesh, sampleInsideMeshIndices } from "./roiStats";
import { seedPixelOf } from "./seedPixel";

const COL = 0.6, ROW = 0.9;
const noGeometry = () => null; // 幾何の無い画像: world → 画素の変換器は何も返さない（NaN と同じ扱い）

describe("roiPointsPx: 幾何なしと幾何ありで、同じ物理的な画素中心が同じ画素座標", () => {
  it("幾何なし: world = 画素 × 間隔（画素 (10,20) の中心は world (6, 18)）→ 画素座標 (10.5, 20.5)", () => {
    const p = roiPointsPx([[10 * COL, 20 * ROW, 0]], noGeometry, COL, ROW);
    expect(p[0][0]).toBeCloseTo(10.5, 12);
    expect(p[0][1]).toBeCloseTo(20.5, 12);
  });

  it("幾何あり（IPP = 画素 (0,0) の中心）で同じ画素の中心を変換した値と一致", () => {
    // 画素 (10,20) の中心の world（IPP が原点、IOP が標準）
    const world = [10 * COL, 20 * ROW, 0];
    const geo = worldToPixelOnPlane(world, [0, 0, 0], [1, 0, 0, 0, 1, 0], ROW, COL)!;
    const none = roiPointsPx([world], noGeometry, COL, ROW)[0];
    expect(none[0]).toBeCloseTo(geo[0], 12);
    expect(none[1]).toBeCloseTo(geo[1], 12);
  });

  it("負例: +0.5 を外す旧式だと、幾何ありと半画素ずれる（検査が効いている）", () => {
    const world = [10 * COL, 20 * ROW, 0];
    const geo = worldToPixelOnPlane(world, [0, 0, 0], [1, 0, 0, 0, 1, 0], ROW, COL)!;
    const old = [world[0] / COL, world[1] / ROW];
    expect(Math.abs(old[0] - geo[0])).toBeCloseTo(0.5, 12);
  });
});

describe("幾何なしの画像の ROI 統計の母集団 = 幾何ありと同じ（画素境界に合わせた矩形）", () => {
  it("x 44〜54 × y 20〜30 の矩形が選ぶ画素は列 44..53・行 20..29（100 画素）", () => {
    // 画素境界 44, 54, 20, 30 の world（画素の左上隅 = 中心から −0.5 画素）
    const corner = (x: number, y: number) => [(x - 0.5) * COL, (y - 0.5) * ROW, 0];
    const pts = roiPointsPx([corner(44, 20), corner(54, 20), corner(54, 30), corner(44, 30)], noGeometry, COL, ROW);
    const mesh = buildRoiMesh("RectangleROI", pts, undefined)!;
    const cols = 80, rows = 60;
    const idx = Array.from(sampleInsideMeshIndices(mesh, new Float32Array(cols * rows), cols, rows));
    expect(idx.length).toBe(100);
    const xs = new Set(idx.map((i) => i % cols)), ys = new Set(idx.map((i) => Math.floor(i / cols)));
    expect(Math.min(...xs)).toBe(44); expect(Math.max(...xs)).toBe(53);
    expect(Math.min(...ys)).toBe(20); expect(Math.max(...ys)).toBe(29);
    const r = computeRoiStatsFrom({
      roiUid: "t", tool: "RectangleROI", imageId: "x", unit: "HU", pointsPx: pts,
      spacingX: COL, spacingY: ROW,
      slice: { values: new Float32Array(cols * rows).fill(5), width: cols, height: rows },
    });
    expect(r.geometry.sampleCount).toBe(100);
  });
});

describe("シード画素（幾何の有無によらず隅原点）", () => {
  it("画素 5 の中のどこを押しても（4 象限）画素 5。round だと右半分で 6", () => {
    for (const dx of [0.05, 0.3, 0.5, 0.7, 0.95]) {
      expect(seedPixelOf([5 + dx, 7 + dx], 20, 20)).toEqual([5, 7]);
    }
    expect(Math.round(5.7)).toBe(6); // 旧式（負例）
  });
  it("幾何なしの画像で画素 (10,20) の中心を押したときのシードも (10,20)", () => {
    const [x, y] = roiPointsPx([[10 * COL, 20 * ROW, 0]], noGeometry, COL, ROW)[0];
    expect(seedPixelOf([x, y], 80, 60)).toEqual([10, 20]);
  });
  it("画像の外・非有限値は null", () => {
    expect(seedPixelOf([-0.01, 3], 20, 20)).toBeNull();
    expect(seedPixelOf([20, 3], 20, 20)).toBeNull();
    expect(seedPixelOf([Number.NaN, 3], 20, 20)).toBeNull();
  });
});
