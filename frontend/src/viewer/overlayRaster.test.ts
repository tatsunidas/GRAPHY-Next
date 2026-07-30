/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { autoWindow, rasterizeOverlay, toGrayLevel } from "./overlayRaster";
import type { LutData } from "../api";

/** r=index, g=255-index, b=0 の判別しやすい LUT。 */
const LUT: LutData = {
  name: "test",
  r: Array.from({ length: 256 }, (_, i) => i),
  g: Array.from({ length: 256 }, (_, i) => 255 - i),
  b: Array.from({ length: 256 }, () => 0),
};

describe("autoWindow", () => {
  it("NaN を無視して min/max から窓を作る", () => {
    expect(autoWindow(new Float32Array([0, NaN, 100]))).toEqual({ center: 50, width: 100 });
  });

  it("全 NaN・定数・空は null（濃淡を作れない）", () => {
    expect(autoWindow(new Float32Array([NaN, NaN]))).toBeNull();
    expect(autoWindow(new Float32Array([5, 5, 5]))).toBeNull();
    expect(autoWindow(new Float32Array([]))).toBeNull();
  });
});

describe("toGrayLevel", () => {
  it("窓の中で 0..255 に線形写像する", () => {
    const win = { center: 50, width: 100 };
    expect(toGrayLevel(0, win)).toBe(0);
    expect(toGrayLevel(50, win)).toBe(128);
    expect(toGrayLevel(100, win)).toBe(255);
  });

  it("窓の外は飽和する", () => {
    const win = { center: 50, width: 100 };
    expect(toGrayLevel(-999, win)).toBe(0);
    expect(toGrayLevel(999, win)).toBe(255);
  });

  it("窓が無い（定数マップ）ときは一律最大濃度", () => {
    expect(toGrayLevel(1, null)).toBe(255);
    expect(toGrayLevel(1, { center: 1, width: 0 })).toBe(255);
  });
});

describe("rasterizeOverlay", () => {
  it("NaN は透明、それ以外は指定の不透明度になる", () => {
    const rgba = rasterizeOverlay(new Float32Array([NaN, 0]), 0.5, { center: 0, width: 10 }, null);
    expect(rgba[3]).toBe(0);
    // 値による α 変調はしない（マスクの縁が半端に薄くならないように）。
    expect(rgba[7]).toBe(128);
  });

  it("LUT があれば濃淡を色に置き換える", () => {
    const rgba = rasterizeOverlay(new Float32Array([100]), 1, { center: 50, width: 100 }, LUT);
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([255, 0, 0, 255]);
  });

  it("LUT が無ければグレースケール", () => {
    const rgba = rasterizeOverlay(new Float32Array([100]), 1, { center: 50, width: 100 }, null);
    expect([rgba[0], rgba[1], rgba[2]]).toEqual([255, 255, 255]);
  });

  it("長さは rows*cols*4、不透明度は 0..1 に丸める", () => {
    expect(rasterizeOverlay(new Float32Array(6), 1, null, null)).toHaveLength(24);
    expect(rasterizeOverlay(new Float32Array([0]), 9, null, null)[3]).toBe(255);
    expect(rasterizeOverlay(new Float32Array([0]), -1, null, null)[3]).toBe(0);
  });
});
