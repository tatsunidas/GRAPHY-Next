/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  parseScaleBarSetting,
  scaleBarColors,
  scaleBarLabels,
  scaleBarRange,
  serializeScaleBarSetting,
} from "./valueScaleBar";

describe("parseScaleBarSetting", () => {
  it("保存値 1 だけが ON", () => {
    expect(parseScaleBarSetting("1")).toBe(true);
    expect(parseScaleBarSetting("0")).toBe(false);
  });
  it("欠損・不正値は OFF", () => {
    for (const g of [null, undefined, "", "true", "on", "yes", "{}", "2"]) expect(parseScaleBarSetting(g)).toBe(false);
  });
  it("保存して読み戻すと元に戻る", () => {
    expect(parseScaleBarSetting(serializeScaleBarSetting(true))).toBe(true);
    expect(parseScaleBarSetting(serializeScaleBarSetting(false))).toBe(false);
  });
});

describe("scaleBarRange", () => {
  it("中心 ± 幅/2", () => {
    expect(scaleBarRange(40, 400)).toEqual({ min: -160, max: 240 });
    expect(scaleBarRange(0.5, 1)).toEqual({ min: 0, max: 1 });
  });
  it("窓幅が 0・負・NaN・非有限なら NaN（捏造しない）", () => {
    for (const w of [0, -5, NaN, Infinity]) {
      const r = scaleBarRange(10, w);
      expect(r.min).toBeNaN();
      expect(r.max).toBeNaN();
    }
    expect(scaleBarRange(NaN, 100).max).toBeNaN();
  });
});

describe("scaleBarLabels", () => {
  it("HU は整数近傍で表示", () => {
    expect(scaleBarLabels(40, 400)).toEqual({ max: "240", min: "-160" });
  });
  it("小さな値域を 0.0 に潰さない（ADC 風 0.0007）", () => {
    // 中心 0.00035・幅 0.0007 → 0〜0.0007
    const l = scaleBarLabels(0.00035, 0.0007);
    expect(l.min).toBe("0");
    expect(l.max).toBe("0.0007");
    // 1e-5 級は指数表記
    expect(scaleBarLabels(0.000005, 0.00001).max).toBe("1.000e-5");
  });
  it("不正な窓は NaN 文字列ではなく「—」", () => {
    expect(scaleBarLabels(10, 0)).toEqual({ max: "—", min: "—" });
    expect(scaleBarLabels(NaN, NaN)).toEqual({ max: "—", min: "—" });
  });
});

describe("scaleBarColors", () => {
  it("LUT 無しはグレースケールで 256 色、上が最大（白）・下が最小（黒）", () => {
    const c = scaleBarColors(null, false);
    expect(c).toHaveLength(256);
    expect(c[0]).toBe("rgb(255,255,255)");
    expect(c[255]).toBe("rgb(0,0,0)");
    expect(c[100]).toBe("rgb(155,155,155)");
  });
  it("invert で並びが逆（上が黒）", () => {
    const c = scaleBarColors(null, true);
    expect(c[0]).toBe("rgb(0,0,0)");
    expect(c[255]).toBe("rgb(255,255,255)");
    expect(c).toEqual([...scaleBarColors(null, false)].reverse());
  });
  it("LUT は index の色を使い、上が index 255", () => {
    const lut = {
      r: Array.from({ length: 256 }, (_, i) => i),
      g: Array.from({ length: 256 }, () => 7),
      b: Array.from({ length: 256 }, (_, i) => 255 - i),
    };
    const c = scaleBarColors(lut, false);
    expect(c[0]).toBe("rgb(255,7,0)");
    expect(c[255]).toBe("rgb(0,7,255)");
    expect(scaleBarColors(lut, true)[0]).toBe("rgb(0,7,255)");
  });
});
