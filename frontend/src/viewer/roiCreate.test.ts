import { describe, expect, it } from "vitest";
import { buildRoiHandles, type CreateRoiRequest, type RoiCreateGeometry } from "./roiCreate";

/** canvas(px) → world(mm) の仮のアフィン。world = origin + cx·ex·mmPerPx + cy·ey·mmPerPx。 */
function geom(over: Partial<{ origin: number[]; ex: number[]; ey: number[]; mmPerPx: number; focal: number[]; normal: number[]; tol: number; max: number }> = {}): RoiCreateGeometry {
  const o = over.origin ?? [-100, -100, 5];
  const ex = over.ex ?? [1, 0, 0];
  const ey = over.ey ?? [0, 1, 0];
  const k = over.mmPerPx ?? 0.5;
  const toWorld = (c: [number, number]): [number, number, number] => [o[0] + (c[0] * ex[0] + c[1] * ey[0]) * k, o[1] + (c[0] * ex[1] + c[1] * ey[1]) * k, o[2] + (c[0] * ex[2] + c[1] * ey[2]) * k];
  const toCanvas = (p: number[]): [number, number] => {
    const d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    return [(d[0] * ex[0] + d[1] * ex[1] + d[2] * ex[2]) / k, (d[0] * ey[0] + d[1] * ey[1] + d[2] * ey[2]) / k];
  };
  return {
    worldToCanvas: toCanvas,
    canvasToWorld: toWorld,
    focalPoint: over.focal ?? [0, 0, 5],
    viewPlaneNormal: over.normal ?? [0, 0, 1],
    sliceToleranceMm: over.tol ?? 1.25,
    maxExtentMm: over.max ?? 400,
  };
}
const cv = (g: RoiCreateGeometry, p: number[]): [number, number] => g.worldToCanvas(p)!;
const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const ell = (over: Partial<CreateRoiRequest> = {}): CreateRoiRequest => ({ tool: "EllipticalROI", centerLps: [10, 20, 5], radiiMm: [20, 10], ...over });

describe("buildRoiHandles", () => {
  it("ellipse: [bottom, top, left, right] with the requested radii (distance measured in world mm)", () => {
    const r = buildRoiHandles(ell(), geom());
    if (!r.ok) throw new Error(r.reason);
    const [bottom, top, left, right] = r.points;
    expect(dist(left, right)).toBeCloseTo(40, 6);
    expect(dist(top, bottom)).toBeCloseTo(20, 6);
    // 中心は辺の中点
    expect(dist([(left[0] + right[0]) / 2, (left[1] + right[1]) / 2, (left[2] + right[2]) / 2], [10, 20, 5])).toBeCloseTo(0, 6);
    // canvas では y が下向き: bottom の canvas y > top の canvas y、left の x < right の x
    const g = geom();
    expect(cv(g, bottom)[1]).toBeGreaterThan(cv(g, top)[1]);
    expect(cv(g, left)[0]).toBeLessThan(cv(g, right)[0]);
    // すべて同じ面（z=5）に乗る
    for (const p of r.points) expect(p[2]).toBeCloseTo(5, 9);
  });

  it("rectangle: [bottomLeft, bottomRight, topLeft, topRight] spanning half-widths", () => {
    const r = buildRoiHandles(ell({ tool: "RectangleROI", radiiMm: [15, 5] }), geom());
    if (!r.ok) throw new Error(r.reason);
    const [bl, br, tl, tr] = r.points;
    expect(dist(bl, br)).toBeCloseTo(30, 6);
    expect(dist(tl, tr)).toBeCloseTo(30, 6);
    expect(dist(bl, tl)).toBeCloseTo(10, 6);
    const g = geom();
    expect(cv(g, bl)[0]).toBeLessThan(cv(g, br)[0]);
    expect(cv(g, bl)[1]).toBeGreaterThan(cv(g, tl)[1]);
    // 0 と 3 は対角（Cornerstone が points[0] と points[3] から残りを作る）
    expect(cv(g, tr)[0]).toBeGreaterThan(cv(g, bl)[0]);
    expect(cv(g, tr)[1]).toBeLessThan(cv(g, bl)[1]);
  });

  it("holds for a rotated and flipped display (radii stay in mm along the display axes)", () => {
    const s = Math.SQRT1_2;
    const rotated = geom({ ex: [s, s, 0], ey: [-s, s, 0], mmPerPx: 0.3 });
    const r = buildRoiHandles(ell(), rotated);
    if (!r.ok) throw new Error(r.reason);
    expect(dist(r.points[2], r.points[3])).toBeCloseTo(40, 6);
    expect(dist(r.points[0], r.points[1])).toBeCloseTo(20, 6);
    const flipped = geom({ ex: [-1, 0, 0], ey: [0, 1, 0] });
    const f = buildRoiHandles(ell(), flipped);
    if (!f.ok) throw new Error(f.reason);
    expect(dist(f.points[2], f.points[3])).toBeCloseTo(40, 6);
    expect(cv(flipped, f.points[2])[0]).toBeLessThan(cv(flipped, f.points[3])[0]);
  });

  it("works on a tilted slice plane (oblique normal)", () => {
    const n = [0, Math.SQRT1_2, Math.SQRT1_2];
    const g = geom({ ex: [1, 0, 0], ey: [0, Math.SQRT1_2, -Math.SQRT1_2], normal: n, focal: [0, 0, 5] });
    const center = [3, 0, 5];
    const r = buildRoiHandles(ell({ centerLps: center as [number, number, number] }), g);
    if (!r.ok) throw new Error(r.reason);
    expect(dist(r.points[2], r.points[3])).toBeCloseTo(40, 6);
    expect(dist(r.points[0], r.points[1])).toBeCloseTo(20, 6);
  });

  it("negative: centers off the displayed slice are rejected; on-plane (within tolerance) is accepted (control)", () => {
    expect(buildRoiHandles(ell({ centerLps: [10, 20, 5 + 1.0] }), geom()).ok).toBe(true);
    for (const z of [5 + 1.3, 5 - 1.3, 50, -50]) {
      expect(buildRoiHandles(ell({ centerLps: [10, 20, z] }), geom())).toEqual({ ok: false, reason: "off-slice" });
    }
  });

  it("negative: bad tools, centers and radii", () => {
    const bad: Partial<CreateRoiRequest>[] = [
      { tool: "Length" as never },
      { tool: "" as never },
      { centerLps: [NaN, 0, 5] },
      { centerLps: [0, 0] as never },
      { centerLps: "x" as never },
      { radiiMm: [0, 5] },
      { radiiMm: [-1, 5] },
      { radiiMm: [5, Infinity] },
      { radiiMm: [5] as never },
      { radiiMm: ["5", 5] as never },
    ];
    for (const b of bad) expect(buildRoiHandles(ell(b), geom()), JSON.stringify(b)).toEqual({ ok: false, reason: "bad-request" });
    expect(buildRoiHandles(null as never, geom())).toEqual({ ok: false, reason: "bad-request" });
  });

  it("negative: radii above the image-derived extent are rejected (boundary: equal is accepted)", () => {
    expect(buildRoiHandles(ell({ radiiMm: [400, 10] }), geom({ max: 400 })).ok).toBe(true);
    expect(buildRoiHandles(ell({ radiiMm: [400.01, 10] }), geom({ max: 400 }))).toEqual({ ok: false, reason: "too-large" });
  });

  it("negative: unusable geometry (zero normal, zero scale, missing projection) is reported, never guessed", () => {
    expect(buildRoiHandles(ell(), geom({ normal: [0, 0, 0] }))).toEqual({ ok: false, reason: "no-geometry" });
    expect(buildRoiHandles(ell(), { ...geom(), sliceToleranceMm: 0 })).toEqual({ ok: false, reason: "no-geometry" });
    expect(buildRoiHandles(ell(), { ...geom(), maxExtentMm: NaN })).toEqual({ ok: false, reason: "no-geometry" });
    expect(buildRoiHandles(ell(), { ...geom(), worldToCanvas: () => null })).toEqual({ ok: false, reason: "no-geometry" });
    expect(buildRoiHandles(ell(), { ...geom(), canvasToWorld: () => null })).toEqual({ ok: false, reason: "no-geometry" });
    expect(buildRoiHandles(ell(), { ...geom(), canvasToWorld: () => [0, 0, 0] })).toEqual({ ok: false, reason: "no-geometry" });
  });
});

import { maxExtentFromImage, sliceToleranceFromStack } from "./roiCreate";

describe("sliceToleranceFromStack / maxExtentFromImage", () => {
  it("half the distance to the neighboring slice", () => {
    expect(sliceToleranceFromStack([0, 0, 0], [0, 0, 2.5], 0.7)).toBeCloseTo(1.25, 9);
    expect(sliceToleranceFromStack([0, 0, 0], [3, 4, 0], null)).toBeCloseTo(2.5, 9);
  });
  it("falls back to half the given spacing when there is no distinct neighbor (single slice / multiframe at one position)", () => {
    expect(sliceToleranceFromStack([1, 2, 3], undefined, 0.8)).toBeCloseTo(0.4, 9);
    expect(sliceToleranceFromStack([1, 2, 3], [1, 2, 3], 0.8)).toBeCloseTo(0.4, 9);
  });
  it("is null (not a guess) without any usable information", () => {
    expect(sliceToleranceFromStack(undefined, undefined, null)).toBeNull();
    expect(sliceToleranceFromStack([1, 2, 3], [1, 2, 3], null)).toBeNull();
    expect(sliceToleranceFromStack([NaN, 0, 0], [1, 0, 0], 0)).toBeNull();
    expect(sliceToleranceFromStack([0, 0, 0], [1, 0, 0], -1)).toBe(0.5);
  });
  it("image extent is the diagonal in mm; invalid dimensions give null", () => {
    expect(maxExtentFromImage(512, 512, 0.5, 0.5)).toBeCloseTo(Math.hypot(256, 256), 9);
    for (const a of [[0, 512, 1, 1], [512, NaN, 1, 1], [512, 512, 0, 1], ["512", 512, 1, 1]] as const) expect(maxExtentFromImage(...(a as [unknown, unknown, unknown, unknown]))).toBeNull();
  });
});

describe("buildRoiHandles: centerPx", () => {
  // 画素 → world: z=5 の面で 0.5 mm/px、原点 (-100,-100)
  const px = (p: [number, number]): number[] => [-100 + p[0] * 0.5, -100 + p[1] * 0.5, 5];
  const withPx = (over: Partial<CreateRoiRequest> = {}): CreateRoiRequest => ({ tool: "EllipticalROI", centerPx: [200, 240], radiiMm: [20, 10], ...over });

  it("converts the pixel center through the slice geometry and returns the resolved LPS center", () => {
    const r = buildRoiHandles(withPx(), { ...geom(), pixelToWorld: px });
    if (!r.ok) throw new Error(r.reason);
    expect(r.centerLps).toEqual([0, 20, 5]);
    expect(dist(r.points[2], r.points[3])).toBeCloseTo(40, 6);
    expect(dist(r.points[0], r.points[1])).toBeCloseTo(20, 6);
  });

  it("the LPS echoed back can be fed to centerLps and gives the same handles (round trip)", () => {
    const a = buildRoiHandles(withPx(), { ...geom(), pixelToWorld: px });
    if (!a.ok) throw new Error(a.reason);
    const b = buildRoiHandles({ tool: "EllipticalROI", centerLps: a.centerLps, radiiMm: [20, 10] }, geom());
    if (!b.ok) throw new Error(b.reason);
    for (let i = 0; i < 4; i++) expect(dist(a.points[i], b.points[i])).toBeCloseTo(0, 9);
  });

  it("negative: both or neither center, bad pixels, and no pixel geometry", () => {
    const g = { ...geom(), pixelToWorld: px };
    expect(buildRoiHandles(withPx({ centerLps: [0, 20, 5] }), g)).toEqual({ ok: false, reason: "bad-request" });
    expect(buildRoiHandles(withPx({ centerPx: undefined }), g)).toEqual({ ok: false, reason: "bad-request" });
    for (const c of [[NaN, 1], [1], [1, 2, 3], ["1", 2], null]) {
      expect(buildRoiHandles(withPx({ centerPx: c as never }), g), JSON.stringify(c)).toEqual({ ok: false, reason: "bad-request" });
    }
    expect(buildRoiHandles(withPx(), geom())).toEqual({ ok: false, reason: "no-geometry" });
    expect(buildRoiHandles(withPx(), { ...geom(), pixelToWorld: () => null })).toEqual({ ok: false, reason: "no-geometry" });
    expect(buildRoiHandles(withPx(), { ...geom(), pixelToWorld: () => [NaN, 0, 5] })).toEqual({ ok: false, reason: "no-geometry" });
  });

  it("a pixel center whose world position is off the displayed slice is still rejected", () => {
    expect(buildRoiHandles(withPx(), { ...geom(), pixelToWorld: (p) => [p[0], p[1], 99] })).toEqual({ ok: false, reason: "off-slice" });
  });
});
