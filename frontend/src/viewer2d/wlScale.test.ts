import { describe, expect, it } from "vitest";
import { decimalsFor, minWindowWidth, roundTo } from "./wlScale";

describe("wlScale — 値域の小さい float（ADC）でも W/L を扱える", () => {
  it("整数の画像は 1 段、非整数はスライダー 1 目盛り", () => {
    expect(minWindowWidth(true, -1024, 3071, 1, 1000)).toBe(1);
    expect(minWindowWidth(false, 0.0007, 0.0018, 1, 1000)).toBeCloseTo(1.1e-6, 12);
    expect(minWindowWidth(false, 0.002, 0.002, 1, 1000)).toBeGreaterThan(0);
  });

  it("表示の桁は刻みが見分けられるだけ（CT は今まで通り 1 桁）", () => {
    expect(decimalsFor(4.1)).toBe(1);
    expect(decimalsFor(1.1e-6)).toBe(6);
    expect(roundTo(0.00125, decimalsFor(1.1e-6))).toBe(0.00125);
    expect(roundTo(40.04, decimalsFor(4.1))).toBe(40);
  });
});
