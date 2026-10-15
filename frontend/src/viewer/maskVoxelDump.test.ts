/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { iterateMaskVoxels, maskVoxelDumpCsvChunks, maskVoxelDumpHeader, type MaskDumpSlice } from "./maskVoxelDump";
import { accumulateMaskStats, collectMaskValues } from "./maskStatsCore";
import { summarizeValues } from "./roiStats";
import type { PlaneGeometry } from "./imageCoords";

const W = 4;
const plane = (z: number): PlaneGeometry => ({
  imagePositionPatient: [-10, 20, z],
  rowCosines: [1, 0, 0],
  columnCosines: [0, 1, 0],
  rowPixelSpacing: 2,
  columnPixelSpacing: 1.5,
});

// 渡す順はわざとスライス順と逆にする（出力はスライス順に並ぶこと）。
const slices: MaskDumpSlice[] = [
  { sliceIndex: 5, imageId: "img5", width: W, labels: [0, 2, 0, 0, 0, 0, 0, 1], values: [9, 50, 9, 9, 9, 9, 9, 70], plane: plane(-3) },
  { sliceIndex: 3, imageId: "img3", width: W, labels: [1, 0, 0, 0, 0, 1, 0, 0], values: [10, 9, 9, 9, 9, NaN, 9, 9], plane: plane(-9) },
  { sliceIndex: 4, imageId: "img4", width: W, labels: [0, 0, 0, 0, 0, 0, 0, 0], values: [1, 1, 1, 1, 1, 1, 1, 1], plane: plane(-6) },
];

const lines = (chunks: string[]) => chunks.join("").replace(/^﻿/, "").trimEnd().split("\r\n");

describe("iterateMaskVoxels", () => {
  it("前景だけを、スライス順・画素順に、ビューアと同じ 1 始まりのスライス番号で出す", () => {
    const rows = [...iterateMaskVoxels(slices)];
    expect(rows.map((r) => [r.slice, r.col, r.row, r.segment])).toEqual([
      [4, 0, 0, 1],
      [4, 1, 1, 1],
      [6, 1, 0, 2],
      [6, 3, 1, 1],
    ]);
  });

  it("座標は画素の中心（col+0.5, row+0.5）を患者座標にしたもの", () => {
    const r = [...iterateMaskVoxels(slices)][1]; // slice 4 (index 3), col 1, row 1
    // IPP は画素 (0,0) の中心。列は 1.5 mm、行は 2 mm。
    expect(r.x).toBeCloseTo(-10 + 1 * 1.5);
    expect(r.y).toBeCloseTo(20 + 1 * 2);
    expect(r.z).toBeCloseTo(-9);
  });

  it("NaN の値・幾何の無いスライスは空のまま（0 で埋めない）で、行は残す", () => {
    const noGeom = slices.map((s) => ({ ...s, plane: null }));
    const rows = [...iterateMaskVoxels(noGeom)];
    expect(rows).toHaveLength(4);
    expect(rows[1].value).toBeUndefined();
    expect(rows.every((r) => r.x === undefined && r.z === undefined)).toBe(true);
  });

  it("行数は Σ³ のボクセル数と同じ（母集団が同じ）", () => {
    const n = [...iterateMaskVoxels(slices)].length;
    expect(n).toBe(accumulateMaskStats(slices.map((s) => ({ labels: s.labels, values: s.values }))).voxels);
  });
});

describe("maskVoxelDumpCsvChunks", () => {
  it("1 枚の表: 見出し 1 行＋ボクセル数ぶんの行。BOM は先頭だけ", () => {
    const chunks = maskVoxelDumpCsvChunks(slices, { label: "Liver", maskId: "seg-1", unit: "HU" }, 2);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].startsWith("﻿")).toBe(true);
    expect(chunks.slice(1).some((c) => c.includes("﻿"))).toBe(false);
    const ls = lines(chunks);
    expect(ls[0].split(",")).toEqual(maskVoxelDumpHeader("HU"));
    expect(ls).toHaveLength(1 + 4);
    const h = ls[0].split(",");
    const row2 = ls[2].split(",");
    expect(row2[h.indexOf("slice")]).toBe("4");
    expect(row2[h.indexOf("value[HU]")]).toBe(""); // NaN は空セル
    expect(ls[3].split(",")[h.indexOf("segment")]).toBe("2");
  });

  it("見出しの列の並びを固定する", () => {
    expect(maskVoxelDumpHeader("SUVbw")).toEqual([
      "label", "maskId", "slice", "segment", "col", "row", "x[mm]", "y[mm]", "z[mm]", "value[SUVbw]", "imageId",
    ]);
  });
});

describe("collectMaskValues", () => {
  it("数え方は Σ³ と同じで、有限の値だけなら平均も同じ", () => {
    const finite = [
      { labels: [1, 0, 1, 2], values: [1, 100, 3, 10] },
      { labels: [0, 0, 0, 0], values: [5, 5, 5, 5] },
      { labels: [1, 1, 0, 2], values: [2, 4, 100, 20] },
    ];
    const a = accumulateMaskStats(finite);
    const c = collectMaskValues(finite);
    expect(c.voxels).toBe(a.voxels);
    expect(c.slices).toBe(a.slices);
    expect(c.missingValueSlices).toBe(0);
    const s = summarizeValues(c.values, "HU")!;
    expect(s.n).toBe(a.voxels);
    expect(s.mean).toBeCloseTo(a.mean!, 10);
    expect(s.sd).toBeCloseTo(a.sd!, 10);
    expect(s.min).toBe(a.min);
    expect(s.max).toBe(a.max);
  });

  it("値を読めないスライスは Σ³ と同じく数える", () => {
    const c = collectMaskValues([
      { labels: [1, 1], values: null },
      { labels: [0, 1], values: [3, 4] },
    ]);
    expect(c.voxels).toBe(3);
    expect(c.missingValueSlices).toBe(1);
  });
});

describe("segment 指定（塗りの ROI 1 件）", () => {
  it("iterateMaskVoxels は指定した segment のボクセルだけを出す", () => {
    expect([...iterateMaskVoxels(slices, 2)].map((r) => [r.slice, r.col, r.row, r.segment])).toEqual([[6, 1, 0, 2]]);
    const one = [...iterateMaskVoxels(slices, 1)];
    expect(one.map((r) => r.segment)).toEqual([1, 1, 1]);
    expect(one).toHaveLength(3);
  });

  it("存在しない segment は 0 行（全体にはならない）", () => {
    expect([...iterateMaskVoxels(slices, 9)]).toHaveLength(0);
  });

  it("CSV は meta.segmentIndex で絞り、行数は同じ segment の Σ³ と一致する", () => {
    const body = lines(maskVoxelDumpCsvChunks(slices, { label: "L", maskId: "m", unit: "HU", segmentIndex: 1 }, 2)).slice(1);
    expect(body).toHaveLength(3);
    expect(body.every((l) => l.split(",")[3] === "1")).toBe(true);
    const inputs = slices.map((s) => ({ labels: s.labels, values: s.values }));
    expect(body).toHaveLength(accumulateMaskStats(inputs, 1).voxels);
  });

  it("collectMaskValues の母集団は accumulateMaskStats の同じ segment と一致する", () => {
    const inputs = [
      { labels: [1, 2, 1, 2], values: [1, 100, 3, 200] },
      { labels: [2, 0, 1, 0], values: [300, 5, 5, 5] },
    ];
    for (const seg of [1, 2]) {
      const a = accumulateMaskStats(inputs, seg);
      const c = collectMaskValues(inputs, seg);
      expect(c.voxels).toBe(a.voxels);
      expect(c.slices).toBe(a.slices);
      const s = summarizeValues(c.values, "HU")!;
      expect(s.mean).toBeCloseTo(a.mean!, 10);
    }
    expect(collectMaskValues(inputs, 2).voxels).toBe(3);
    expect(collectMaskValues(inputs).voxels).toBe(6);
  });
});
