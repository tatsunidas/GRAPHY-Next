import { describe, expect, it, vi } from "vitest";

// thickSlab は Cornerstone に触るので、触る口だけ差し替えて純ロジック（投影・写像）を検査する。
vi.mock("@cornerstonejs/core", () => ({
  metaData: { get: () => undefined, addProvider: () => undefined },
  registerImageLoader: () => undefined,
  utilities: { VoxelManager: { createImageVoxelManager: () => ({ getScalarData: () => new Float32Array(0) }) } },
}));
vi.mock("./pixelCalibration", () => ({ readModalitySlice: async () => null }));

import {
  projectSamples,
  registerThickSlabSession,
  thickSlabThicknessesFor,
  THICK_SLAB_THICKNESSES,
} from "./thickSlab";
import { clampSlabThickness, defaultSlabThickness } from "./slabPresets";

const a = [0, 10, -5];
const b = [4, 2, -1];
const c = [8, 6, -9];

describe("projectSamples", () => {
  const samples = [
    { s0: a, s1: null, f: 0 },
    { s0: b, s1: null, f: 0 },
    { s0: c, s1: null, f: 0 },
  ];
  it("AVG は画素ごとの平均", () => {
    expect(Array.from(projectSamples(samples, 3, "AVG"))).toEqual([4, 6, -5]);
  });
  it("MIP は画素ごとの最大", () => {
    expect(Array.from(projectSamples(samples, 3, "MIP"))).toEqual([8, 10, -1]);
  });
  it("MINIP は画素ごとの最小", () => {
    expect(Array.from(projectSamples(samples, 3, "MINIP"))).toEqual([0, 2, -9]);
  });
  it("Z 補間したサンプル値に対して投影する", () => {
    // 0.25 の位置: a*0.75 + c*0.25 = [2, 9, -6]
    const out = projectSamples([{ s0: a, s1: c, f: 0.25 }], 3, "MIP");
    expect(Array.from(out)).toEqual([2, 9, -6]);
  });
  it("欠けたサンプル面は MIP/MinIP に寄与しない。全欠けは 0", () => {
    expect(Array.from(projectSamples([{ s0: null, s1: null, f: 0 }, { s0: b, s1: null, f: 0 }], 3, "MINIP"))).toEqual(
      [4, 2, -1],
    );
    expect(Array.from(projectSamples([{ s0: null, s1: null, f: 0 }], 3, "MIP"))).toEqual([0, 0, 0]);
  });
});

describe("セッション・選択肢", () => {
  const base = { seriesUid: "1.2", c: 0, t: 0, thicknessMm: 5, spacingZmm: 1, nativeIds: ["a", "b", "c"] };
  it("投影方式が違えば別トークン（＝別 imageId で再合成）", () => {
    const avg = registerThickSlabSession(base);
    const mip = registerThickSlabSession({ ...base, projection: "MIP" });
    expect(avg).not.toBe(mip);
    expect(registerThickSlabSession({ ...base, projection: "AVG" })).toBe(avg);
  });
  it("MIP/MinIP だけ厚い選択肢を足す", () => {
    expect(thickSlabThicknessesFor("AVG")).toEqual([...THICK_SLAB_THICKNESSES]);
    expect(thickSlabThicknessesFor("MIP")).toContain(10);
    expect(thickSlabThicknessesFor("MINIP")).toContain(20);
  });
  it("既定の厚みと任意入力のクランプ", () => {
    expect(defaultSlabThickness("MIP")).toBe(5);
    expect(defaultSlabThickness("MINIP")).toBe(3);
    expect(clampSlabThickness(0)).toBe(0.5);
    expect(clampSlabThickness(1e6)).toBe(200);
    expect(clampSlabThickness(Number.NaN)).toBe(5);
  });
});
