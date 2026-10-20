/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { describeEstimate, ellipsoidVolumeMl, estimate, sphereVolumeMl } from "./volumeEstimate";

// 期待値は式とは別に手計算した値:
//   φ10 mm の球 = π·1000/6 mm³ = 523.598… mm³ = 0.5236 mL
//   φ20 mm の球 = 8 倍 = 4.18879… mL
//   20×10×10 mm の楕円体 = π·2000/6 mm³ = 1047.19… mm³ = 1.0472 mL
describe("sphereVolumeMl / ellipsoidVolumeMl", () => {
  it("手計算の期待値と一致する", () => {
    expect(sphereVolumeMl(10)).toBeCloseTo(0.5235988, 6);
    expect(sphereVolumeMl(20)).toBeCloseTo(4.1887902, 6);
    expect(ellipsoidVolumeMl(20, 10, 10)).toBeCloseTo(1.0471976, 6);
  });
  it("球は径の 3 乗に比例し、a=b=c の楕円体と一致する", () => {
    expect(sphereVolumeMl(20)! / sphereVolumeMl(10)!).toBeCloseTo(8, 10);
    for (const d of [3.7, 10, 42.5]) expect(sphereVolumeMl(d)).toBeCloseTo(ellipsoidVolumeMl(d, d, d)!, 12);
  });
  it("0・負・非数・無限は null（黙って 0 や丸めた値にしない）", () => {
    for (const bad of [0, -1, NaN, Infinity, -Infinity]) {
      expect(sphereVolumeMl(bad)).toBeNull();
      expect(ellipsoidVolumeMl(bad, 10, 10)).toBeNull();
      expect(ellipsoidVolumeMl(10, bad, 10)).toBeNull();
      expect(ellipsoidVolumeMl(10, 10, bad)).toBeNull();
    }
  });
});

describe("estimate", () => {
  it("径の数が合わなければ null（楕円体に 2 径・球に 3 径）", () => {
    expect(estimate("ellipsoid", [20, 10])).toBeNull();
    expect(estimate("sphere", [10, 10, 10])).toBeNull();
    expect(estimate("sphere", [])).toBeNull();
  });
  it("正しい入力は体積と使った径を返す", () => {
    const r = estimate("ellipsoid", [20, 10, 10])!;
    expect(r.kind).toBe("ellipsoid");
    expect(r.diametersMm).toEqual([20, 10, 10]);
    expect(r.volumeMl).toBeCloseTo(1.0471976, 6);
  });
});

describe("describeEstimate", () => {
  it("表示した径から手計算した体積が、表示した体積と一致する（丸めで食い違わない）", () => {
    const r = estimate("ellipsoid", [68.07, 52.94, 12])!;
    const text = describeEstimate(r);
    const shown = Number(text.match(/≈ ([0-9.]+) mL/)![1]);
    const dia = text.match(/: ([0-9.]+) × ([0-9.]+) × ([0-9.]+) mm/)!.slice(1).map(Number);
    expect(shown).toBeCloseTo(ellipsoidVolumeMl(dia[0], dia[1], dia[2])!, 2);
  });
  it("値と仮定を並べる（日・英）", () => {
    expect(describeEstimate(estimate("sphere", [10])!)).toBe("≈ 0.52 mL（球の仮定: φ10 mm）");
    expect(describeEstimate(estimate("ellipsoid", [20, 10, 10])!)).toBe("≈ 1.05 mL（楕円体の仮定: 20 × 10 × 10 mm）");
    expect(describeEstimate(estimate("sphere", [10])!, "en")).toBe("≈ 0.52 mL (assuming a sphere: φ10 mm)");
    expect(describeEstimate(estimate("ellipsoid", [12.34, 5, 7.5])!, "en")).toContain("12.34 × 5 × 7.5 mm");
  });
});
