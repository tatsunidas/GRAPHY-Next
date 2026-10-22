/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { SeriesLayout } from "./seriesLayout";
import { parseSliceRange } from "../mainscreen/sliceRange";
import {
  contiguousSpan, describeKept, positionsMm, rangeFromIndices, rangeToleranceMm, restrictLayout, tileIdFor,
} from "./virtualLayout";

/** 300 枚・1 mm 間隔・法線 +z の合成レイアウト（imageId は z と c・t が分かる文字列）。 */
function layout(nZ = 300, over: Partial<SeriesLayout> = {}, nC = 1): SeriesLayout {
  return {
    nZ,
    nC,
    nT: 1,
    zStack: (c, t) => Array.from({ length: nZ }, (_, z) => `c${c}t${t}z${z}`),
    ippAt: (z) => [0, 0, z],
    normal: [0, 0, 1],
    ...over,
  };
}

const posOf = (l: SeriesLayout) => positionsMm(l)!;

describe("restrictLayout (mm)", () => {
  it("keeps the slices whose position is inside the range and renumbers them", () => {
    const r = restrictLayout(layout(), { kind: "mm", fromMm: 100, toMm: 199 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.nZ).toBe(100);
    expect(r.keptZ[0]).toBe(100);
    expect(r.keptZ[99]).toBe(199);
    expect(r.layout.zStack(0, 0)[0]).toBe("c0t0z100");
    expect(r.layout.zStack(0, 0)[99]).toBe("c0t0z199");
    expect(posOf(r.layout)[0]).toBeCloseTo(100.0, 6);
    expect(posOf(r.layout)[99]).toBeCloseTo(199.0, 6);
    expect(r.total).toBe(300);
  });

  it("is the same whether the range was typed as slice numbers or millimetres", () => {
    const l = layout();
    const parsed = parseSliceRange("101-200");
    const span = contiguousSpan(parsed.indices)!;
    const fromIdx = rangeFromIndices(l, span.from, span.to)!;
    expect(fromIdx).toEqual({ kind: "mm", fromMm: 100, toMm: 199 });
    const a = restrictLayout(l, fromIdx);
    const b = restrictLayout(l, { kind: "mm", fromMm: 100, toMm: 199 });
    expect(a.ok && b.ok && JSON.stringify(a.keptZ) === JSON.stringify(b.keptZ)).toBe(true);
  });

  it("keeps every C and T (the same Z survive for each channel)", () => {
    const l = layout(300, {}, 2);
    const r = restrictLayout(l, { kind: "mm", fromMm: 10, toMm: 14 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.nC).toBe(2);
    expect(r.layout.zStack(1, 0)).toEqual(["c1t0z10", "c1t0z11", "c1t0z12", "c1t0z13", "c1t0z14"]);
    expect(r.layout.zStack(0, 0)).toEqual(["c0t0z10", "c0t0z11", "c0t0z12", "c0t0z13", "c0t0z14"]);
  });

  it("is independent of the stored Z order (descending series)", () => {
    // 位置が降順に並ぶシリーズ（z=0 が 299 mm）でも、mm の区間は同じ断面を指す
    const l = layout(300, { ippAt: (z) => [0, 0, 299 - z] });
    const r = restrictLayout(l, { kind: "mm", fromMm: 100, toMm: 199 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.nZ).toBe(100);
    const p = posOf(r.layout);
    expect(Math.min(...p)).toBeCloseTo(100, 6);
    expect(Math.max(...p)).toBeCloseTo(199, 6);
  });

  it("treats the edges with a tolerance of 1% of the spacing (capped at 0.01 mm)", () => {
    const l = layout(300, { ippAt: (z) => [0, 0, z === 200 ? 199.004 : z === 201 ? 199.02 : z] });
    const inside = restrictLayout(l, { kind: "mm", fromMm: 100, toMm: 199 });
    expect(inside.ok && inside.keptZ.includes(200)).toBe(true); // 199.004 は入る
    expect(inside.ok && inside.keptZ.includes(201)).toBe(false); // 199.02 は入らない
    expect(rangeToleranceMm(posOf(layout()))).toBeCloseTo(0.01, 9);
    // 間隔 0.1 mm のシリーズでは許容が 0.001 mm に縮む
    expect(rangeToleranceMm(Array.from({ length: 10 }, (_, i) => i * 0.1))).toBeCloseTo(0.001, 9);
  });

  it("refuses a range that misses the series, one that has no slice in it, and a missing IPP", () => {
    const l = layout();
    expect(restrictLayout(l, { kind: "mm", fromMm: 500, toMm: 600 })).toEqual({ ok: false, reason: "outOfRange" });
    expect(restrictLayout(l, { kind: "mm", fromMm: 10.3, toMm: 10.7 })).toEqual({ ok: false, reason: "empty" });
    expect(restrictLayout(l, { kind: "mm", fromMm: NaN, toMm: 5 })).toEqual({ ok: false, reason: "invalid" });
    const noIpp = layout(300, { ippAt: undefined });
    expect(restrictLayout(noIpp, { kind: "mm", fromMm: 1, toMm: 5 })).toEqual({ ok: false, reason: "noIpp" });
    // 1 つでも IPP が欠けていたら、黙って飛ばさずに断る
    const holey = layout(300, { ippAt: (z) => (z === 50 ? null : [0, 0, z]) });
    expect(restrictLayout(holey, { kind: "mm", fromMm: 1, toMm: 5 })).toEqual({ ok: false, reason: "noIpp" });
  });

  it("passes the IPP and the T stack through the renumbering", () => {
    const l = layout(300, {
      tStack: (z, c) => [`z${z}c${c}t0`, `z${z}c${c}t1`],
    });
    const r = restrictLayout(l, { kind: "mm", fromMm: 100, toMm: 102 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.layout.ippAt!(0)).toEqual([0, 0, 100]);
    expect(r.layout.tStack!(2, 0)).toEqual(["z102c0t0", "z102c0t1"]);
  });
});

describe("restrictLayout (index, for series without IPP)", () => {
  const noIpp = layout(300, { ippAt: undefined, normal: null });

  it("restricts by Z number", () => {
    const r = restrictLayout(noIpp, { kind: "index", from: 100, to: 199 });
    expect(r.ok && r.layout.nZ).toBe(100);
    expect(rangeFromIndices(noIpp, 100, 199)).toEqual({ kind: "index", from: 100, to: 199 });
  });

  it("refuses out of range and reversed", () => {
    expect(restrictLayout(noIpp, { kind: "index", from: 250, to: 400 })).toEqual({ ok: false, reason: "outOfRange" });
    expect(restrictLayout(noIpp, { kind: "index", from: 20, to: 10 })).toEqual({ ok: false, reason: "invalid" });
    expect(rangeFromIndices(noIpp, 20, 10)).toBeNull();
    expect(rangeFromIndices(noIpp, 0, 300)).toBeNull();
  });
});

describe("contiguousSpan / describeKept / tileIdFor", () => {
  it("accepts one contiguous run and refuses gaps and empty input", () => {
    expect(contiguousSpan([100, 101, 102])).toEqual({ from: 100, to: 102 });
    expect(contiguousSpan([7])).toEqual({ from: 7, to: 7 });
    expect(contiguousSpan(parseSliceRange("1-5, 8").indices)).toBeNull();
    expect(contiguousSpan([])).toBeNull();
  });

  it("describes the kept range with 1-origin numbers", () => {
    const r = restrictLayout(layout(), { kind: "mm", fromMm: 100, toMm: 199 });
    expect(r.ok && describeKept(r.keptZ, r.total)).toEqual({ from: 101, to: 200, count: 100, total: 300 });
  });

  it("keeps the old tile id without a range and makes a different id for a different range", () => {
    expect(tileIdFor("S", "R")).toBe("S|R");
    const a = tileIdFor("S", "R", { kind: "mm", fromMm: 100, toMm: 199 });
    const b = tileIdFor("S", "R", { kind: "mm", fromMm: 100, toMm: 150 });
    expect(a).not.toBe("S|R");
    expect(a).not.toBe(b);
    expect(tileIdFor("S", "R", { kind: "mm", fromMm: 199, toMm: 100 })).toBe(a); // 順序によらない
    expect(tileIdFor("S", "R", { kind: "index", from: 0, to: 9 })).toBe("S|R|#1-10");
  });
});
