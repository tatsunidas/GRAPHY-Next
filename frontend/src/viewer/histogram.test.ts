/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `analyze()` は `analyzeValues()` へ委譲する形に切り出した（ROI 統計が同じ数式を使うため）。
 * 委譲でふるまいが変わっていないこと、および ROI 側が依存する性質を固定する。
 */
import { describe, expect, it } from "vitest";
import { analyze, analyzeValues, computeBinMask, suggestBinWidth, type Slice } from "./histogram";

const slice = (values: number[], unit = "HU"): Slice => ({
  values: Float32Array.from(values),
  width: values.length,
  height: 1,
  unit,
});

describe("analyze / analyzeValues", () => {
  it("スライス経由と値の並び経由で同じ結果になる（委譲の同一性）", () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const b = [2, 4, 6];
    const viaSlices = analyze([slice(a), slice(b)], { mode: "count", value: 16 });
    const viaValues = analyzeValues([a, b], "HU", { mode: "count", value: 16 });
    expect(viaValues).toEqual(viaSlices);
  });

  it("一次統計量が既知の値と一致する", () => {
    const h = analyzeValues([[1, 2, 3, 4, 5, 6, 7, 8, 9]], "HU", { mode: "count", value: 9 });
    expect(h.totalCount).toBe(9);
    expect(h.mean).toBeCloseTo(5, 9);
    expect(h.min).toBe(1);
    expect(h.max).toBe(9);
    // 母分散 20/3
    expect(h.variance).toBeCloseTo(20 / 3, 6);
    expect(h.stdDev).toBeCloseTo(Math.sqrt(20 / 3), 6);
    expect(h.skewness).toBeCloseTo(0, 9);
    expect(h.valueUnit).toBe("HU");
  });

  it("一様値ではエントロピーも SD も 0（ROI 統計の一様ファントム検証の土台）", () => {
    const h = analyzeValues([new Float32Array(64).fill(42)], "HU", { mode: "count", value: 256 });
    expect(h.stdDev).toBeCloseTo(0, 9);
    expect(h.entropy).toBeCloseTo(0, 9);
  });

  it("空の母集団は例外（0 で埋めない）", () => {
    expect(() => analyzeValues([], "HU", { mode: "count", value: 8 })).toThrow();
    expect(() => analyzeValues([[]], "HU", { mode: "count", value: 8 })).toThrow();
  });

  it("ビン数は上限で頭打ちする（描画・メモリの保護）", () => {
    const h = analyzeValues([[0, 1e9]], "raw", { mode: "width", value: 1 });
    expect(h.binCount).toBe(65536);
  });

  it("computeBinMask は [lo, hi) の半開区間", () => {
    const m = computeBinMask(slice([0, 5, 10, 15]), 5, 15);
    expect(Array.from(m)).toEqual([0, 1, 1, 0]);
  });
});

describe("NaN を含む float の画像（Parametric Map）", () => {
  it("NaN は数えず、統計とビンは有限値だけから出る", () => {
    const h = analyzeValues([[0.001, Number.NaN, 0.002, 0.003, Number.NaN]], "mm2/s", { mode: "count", value: 3 });
    expect(h.totalCount).toBe(3);
    expect(h.min).toBe(0.001);
    expect(h.max).toBe(0.003);
    expect(h.mean).toBeCloseTo(0.002, 12);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(3);
    expect(Number.isFinite(h.stdDev)).toBe(true);
  });

  it("NaN だけなら空の母集団として例外", () => {
    expect(() => analyzeValues([[Number.NaN, Number.NaN]], "raw", { mode: "count", value: 4 })).toThrow();
  });

  it("ビン幅の提案: 整数の画像は null（既定の幅のまま）、小さい float は値域に見合う幅", () => {
    expect(suggestBinWidth([0, 1, 2, 3, 100])).toBeNull();
    const adc = Array.from({ length: 1000 }, (_, i) => 0.0007 + (0.0011 * i) / 999);
    adc.push(Number.NaN);
    const w = suggestBinWidth(adc)!;
    // 一様分布 1000 個: IQR = 0.00055、2·IQR/10 = 0.00011
    expect(w).toBeCloseTo(0.00011, 6);
    expect(analyzeValues([adc], "mm2/s", { mode: "width", value: w }).binCount).toBe(10);
  });
});
