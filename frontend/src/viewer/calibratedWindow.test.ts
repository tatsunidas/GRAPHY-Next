import { describe, expect, it } from "vitest";
import { defaultCalibratedWindow } from "./calibratedWindow";

describe("defaultCalibratedWindow", () => {
  it("SUV 4 種は校正値 0〜7（モダリティ値では 7/scale）", () => {
    for (const t of ["bw", "sul-james", "sul-janma", "bsa"] as const) {
      expect(defaultCalibratedWindow(t, 2e-4, [1, 2, 3])).toEqual({ lower: 0, upper: 7 / 2e-4 });
    }
  });
  it("scale が正でなければ null", () => {
    expect(defaultCalibratedWindow("pid", 0, [1])).toBeNull();
    expect(defaultCalibratedWindow("bw", NaN, [1])).toBeNull();
  });
  it("%ID/cc は校正値の 99.5 百分位を上限にし、モダリティ値へ戻す", () => {
    // 校正値 0.001..1.000（1000 点）。99.5 百分位 = index 995 → 0.996。
    const vals = Float32Array.from({ length: 1000 }, (_, i) => (i + 1) / 1000);
    const w = defaultCalibratedWindow("pid", 4, vals)!;
    expect(w.lower).toBe(0);
    expect(w.upper).toBeCloseTo(0.996 / 4, 6);
  });
  it("SUVR も %ID/cc と同じく分布から決める", () => {
    const vals = Float32Array.from({ length: 1000 }, (_, i) => (i + 1) / 250); // 0.004..4
    const w = defaultCalibratedWindow("suvr", 2, vals)!;
    expect(w.lower).toBe(0);
    expect(w.upper).toBeCloseTo(3.984 / 2, 6);
  });
  it("%ID/cc: 外れ値 1 点（0.5% 未満）は上限に影響しない", () => {
    const vals = new Float32Array(1000).fill(1);
    vals[0] = 1e6;
    expect(defaultCalibratedWindow("pid", 1, vals)!.upper).toBeCloseTo(1, 6);
  });
  it("%ID/cc: 値なし・全部 0 は SUV と同じ 0〜7 に戻す（真っ黒にしない）", () => {
    expect(defaultCalibratedWindow("pid", 2, null)).toEqual({ lower: 0, upper: 3.5 });
    expect(defaultCalibratedWindow("pid", 2, new Float32Array(16))).toEqual({ lower: 0, upper: 3.5 });
    expect(defaultCalibratedWindow("pid", 2, [NaN, -1])).toEqual({ lower: 0, upper: 3.5 });
  });
});
