/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { ASPECT_ONLY_KEY, aspectOf, calibratedSpacingOf, isAspectOnly, parsePixelAspect } from "./pixelAspect";
import { computeRoiStatsFrom } from "./roiStats";

describe("parsePixelAspect（PixelAspectRatio = 垂直:水平）", () => {
  it("6\\5 → 1.2、5\\6 → 0.8333", () => {
    expect(parsePixelAspect("6\\5")).toBeCloseTo(1.2, 12);
    expect(parsePixelAspect("5\\6")).toBeCloseTo(5 / 6, 12);
    expect(parsePixelAspect([6, 5])).toBeCloseTo(1.2, 12);
    expect(parsePixelAspect(" 3 \\ 2 ")).toBeCloseTo(1.5, 12);
  });
  it("1:1・不正・0 以下・値が足りないは null（比を使わない）", () => {
    for (const v of ["1\\1", "4\\4", "", "6", "0\\5", "6\\0", "-6\\5", "a\\b", undefined, null, 12]) {
      expect(parsePixelAspect(v)).toBeNull();
    }
    expect(parsePixelAspect("1000\\1001")).toBeNull(); // 比 0.999（1:1 から 1e-3 以内）は 1:1 とみなす
  });
});

describe("縦横比だけの間隔（mm の寸法ではない）", () => {
  const plain = { rowPixelSpacing: 0.9, columnPixelSpacing: 0.6 };
  const aspect = { rowPixelSpacing: 1.2, columnPixelSpacing: 1, [ASPECT_ONLY_KEY]: true };
  it("校正済みの間隔は mm として読む", () => {
    expect(calibratedSpacingOf(plain)).toEqual({ col: 0.6, row: 0.9 });
    expect(isAspectOnly(plain)).toBe(false);
    expect(aspectOf(plain)).toBeNull();
  });
  it("縦横比だけの間隔は mm として読まない（px の値に mm を付けない）。比は別に取れる", () => {
    expect(isAspectOnly(aspect)).toBe(true);
    expect(calibratedSpacingOf(aspect)).toBeNull();
    expect(aspectOf(aspect)).toBeCloseTo(1.2, 12);
  });
  it("間隔が無い・不正は null", () => {
    expect(calibratedSpacingOf({})).toBeNull();
    expect(calibratedSpacingOf(null)).toBeNull();
    expect(calibratedSpacingOf({ rowPixelSpacing: 0, columnPixelSpacing: 1 })).toBeNull();
    expect(aspectOf(plain)).toBeNull();
  });
  it("負例: 旧式（間隔が正なら mm）だと、縦横比だけの間隔が mm の寸法に見える", () => {
    const old = (p: { rowPixelSpacing?: number; columnPixelSpacing?: number }) =>
      Number(p.rowPixelSpacing) > 0 && Number(p.columnPixelSpacing) > 0;
    expect(old(aspect)).toBe(true);
    expect(calibratedSpacingOf(aspect)).toBeNull();
  });
});

describe("ROI の px の値に縦横比を反映する（未校正）", () => {
  const stats = (tool: string, pointsPx: Array<[number, number]>, over: Record<string, unknown> = {}) =>
    computeRoiStatsFrom({
      roiUid: "t", tool, imageId: "x", unit: "px", pointsPx, spacingX: null, spacingY: null, ...over,
    });

  it("縦 100 画素の Length は 120 px、水平 100 画素は 100 px（比 1.2）", () => {
    const v = stats("Length", [[10, 10], [10, 110]], { pixelAspect: 1.2 });
    expect(v.geometry.spatiallyCalibrated).toBe(false);
    expect(v.geometry.perimeterPx).toBeCloseTo(120, 9);
    const h = stats("Length", [[10, 10], [110, 10]], { pixelAspect: 1.2 });
    expect(h.geometry.perimeterPx).toBeCloseTo(100, 9);
    expect(v.geometry.perimeterMm).toBeUndefined(); // mm は出さない
  });
  it("矩形 10×10 画素の面積は 120 px²", () => {
    const r = stats("RectangleROI", [[10, 10], [20, 10], [20, 20], [10, 20]], { pixelAspect: 1.2 });
    expect(r.geometry.areaPx2).toBeCloseTo(120, 9);
    expect(r.geometry.areaMm2).toBeUndefined();
  });
  it("円（#676 の worldBasis 経由）は画素空間で縦長の楕円になり、面積は π r²（px²）", () => {
    // 比 1.2（画素は縦長）: 画面上の円は、画素では横 r・縦 r/1.2 の楕円。水平に縁を引いた r = 10 px → 面積は π r²（px²）
    const r = stats("CircleROI", [[50, 50], [60, 50]], { pixelAspect: 1.2, worldBasis: { col: 1, row: 1.2 } });
    expect(Math.abs(r.geometry.areaPx2! - Math.PI * 100) / (Math.PI * 100)).toBeLessThan(2e-3);
  });
  it("比なし・校正済みは不変", () => {
    const a = stats("Length", [[10, 10], [10, 110]]);
    expect(a.geometry.perimeterPx).toBeCloseTo(100, 9);
    const c = stats("Length", [[10, 10], [10, 110]], { spacingX: 0.6, spacingY: 0.9, pixelAspect: 1.2 });
    expect(c.geometry.perimeterPx).toBeCloseTo(100, 9); // 校正済みの px は従来どおり
    expect(c.geometry.perimeterMm).toBeCloseTo(90, 9);
  });
  it("負例: 比を無視する旧式だと縦の長さが 0.83 倍", () => {
    const v = stats("Length", [[10, 10], [10, 110]]);
    expect(v.geometry.perimeterPx! / 120).toBeCloseTo(1 / 1.2, 9);
  });
});
