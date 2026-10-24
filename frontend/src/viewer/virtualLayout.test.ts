/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { SeriesLayout } from "./seriesLayout";
import { parseSliceRange } from "../mainscreen/sliceRange";
import {
  checkConcat, concatLayouts, contiguousSpan, describeKept, positionsMm, rangeFromIndices, rangeToleranceMm,
  restrictLayout, tileIdFor, type ConcatPart,
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

/** 法線 +z・start mm から step mm 間隔で n 枚の連結用の 1 本。imageId は「名前:元の z」。 */
function part(name: string, start: number, n: number, over: Partial<ConcatPart> = {}, step = 1): ConcatPart {
  return {
    study: "st",
    series: name,
    layout: {
      nZ: n, nC: 1, nT: 1,
      zStack: () => Array.from({ length: n }, (_, z) => `${name}:${z}`),
      ippAt: (z) => [0, 0, start + z * step],
      normal: [0, 0, 1],
    },
    iop: [1, 0, 0, 0, 1, 0],
    pixelSpacing: [1, 1],
    rows: 512,
    columns: 512,
    patientId: "P1",
    frameOfReferenceUid: "FOR1",
    modality: "CT",
    ...over,
  };
}

/** 向きの許容角 s / (2L)（512x512・1 mm で約 6.9e-4 rad）。 */
const THETA = 1 / (2 * Math.hypot(511, 511));
const tilted = (rad: number) => [Math.cos(rad), 0, -Math.sin(rad), 0, 1, 0];

function concatOk(parts: ConcatPart[]) {
  const r = concatLayouts(parts);
  if (!r.ok) throw new Error("concat failed: " + r.violations.join(","));
  return r;
}

describe("concatLayouts", () => {
  it("overlap: cuts at the midpoint, no interleaving, uniform 1 mm", () => {
    const r = concatOk([part("A", 0, 100), part("B", 90, 110)]);
    expect(r.layout.nZ).toBe(200);
    const pos = positionsMm(r.layout)!;
    for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeCloseTo(1, 2);
    r.cells.forEach((c, i) => {
      if (c.series === "A") expect(pos[i]).toBeLessThanOrEqual(94 + 1e-9);
      else expect(pos[i]).toBeGreaterThanOrEqual(95 - 1e-9);
    });
    // 並びは A が先、B が後で、途中で入れ替わらない
    const firstB = r.cells.findIndex((c) => c.series === "B");
    expect(r.cells.slice(0, firstB).every((c) => c.series === "A")).toBe(true);
    expect(r.cells.slice(firstB).every((c) => c.series === "B")).toBe(true);
    expect(r.joints).toHaveLength(1);
    expect(r.joints[0].index).toBe(firstB);
    expect(r.joints[0].overlapMm).toBeCloseTo(10, 6);
    expect(r.joints[0].gapMm).toBe(0);
    const ids = r.layout.zStack(0, 0);
    expect(ids[0]).toBe("A:0");
    expect(ids[firstB]).toBe("B:5"); // B の 95 mm（B の先頭 90 mm から 5 枚目）
  });

  it("gap: keeps every slice and reports the edge-to-edge gap", () => {
    const r = concatOk([part("A", 0, 100), part("B", 110, 90)]);
    expect(r.layout.nZ).toBe(190);
    expect(r.joints[0].gapMm).toBeCloseTo(10, 6);
    expect(r.joints[0].overlapMm).toBe(0);
  });

  it("exactly adjacent: no overlap and no gap", () => {
    const r = concatOk([part("A", 0, 100), part("B", 100, 100)]);
    expect(r.layout.nZ).toBe(200);
    expect(r.joints[0].gapMm).toBeCloseTo(0, 9);
    expect(r.joints[0].overlapMm).toBeCloseTo(0, 9);
  });

  it("orders by position whatever order the parts are given, and keeps the source per cell", () => {
    const r = concatOk([part("B", 100, 100), part("A", 0, 100)]);
    expect(r.cells[0].series).toBe("A");
    expect(r.cells[199].series).toBe("B");
    expect(r.cells[0].partIndex).toBe(1);
  });

  it("three parts use the same rule at each seam", () => {
    const r = concatOk([part("A", 0, 50), part("B", 45, 50), part("C", 90, 60)]);
    const pos = positionsMm(r.layout)!;
    for (let i = 1; i < pos.length; i++) expect(pos[i] - pos[i - 1]).toBeCloseTo(1, 2);
    expect(r.joints).toHaveLength(2);
    expect(r.layout.nZ).toBe(150);
    expect(new Set(r.cells.map((c) => c.series))).toEqual(new Set(["A", "B", "C"]));
  });

  it("a series listed in descending order is output ascending", () => {
    const desc = part("A", 0, 100);
    desc.layout.ippAt = (z) => [0, 0, 99 - z];
    const r = concatOk([desc, part("B", 100, 100)]);
    const pos = positionsMm(r.layout)!;
    for (let i = 1; i < pos.length; i++) expect(pos[i]).toBeGreaterThan(pos[i - 1]);
  });

  it("ippAt follows the concatenated order", () => {
    const r = concatOk([part("A", 0, 100), part("B", 90, 110)]);
    expect(r.layout.ippAt!(0)).toEqual([0, 0, 0]);
    expect(r.layout.ippAt!(199)).toEqual([0, 0, 199]);
  });

  it("does not touch the source layouts", () => {
    const a = part("A", 0, 100);
    const b = part("B", 90, 110);
    concatOk([a, b]);
    expect(a.layout.nZ).toBe(100);
    expect(b.layout.nZ).toBe(110);
  });
});

describe("checkConcat violations", () => {
  const A = () => part("A", 0, 100);
  const B = () => part("B", 100, 100);
  const violations = (b: ConcatPart) => {
    const r = checkConcat([A(), b]);
    return r.ok ? [] : r.violations;
  };

  it("passes the clean pair (positive control)", () => {
    expect(checkConcat([A(), B()]).ok).toBe(true);
  });

  it("different FrameOfReferenceUID / empty", () => {
    expect(violations({ ...B(), frameOfReferenceUid: "FOR2" })).toEqual(["frameOfReference"]);
    expect(violations({ ...B(), frameOfReferenceUid: "" })).toContain("frameOfReference");
  });

  it("different patient", () => {
    expect(violations({ ...B(), patientId: "P2" })).toEqual(["patient"]);
  });

  it("different modality", () => {
    expect(violations({ ...B(), modality: "MR" })).toEqual(["modality"]);
  });

  it("orientation: rejects 2x tolerance, accepts 0.5x tolerance", () => {
    expect(violations({ ...B(), iop: tilted(2 * THETA) })).toEqual(["orientation"]);
    expect(violations({ ...B(), iop: tilted(0.5 * THETA) })).toEqual([]);
  });

  it("C or T above 1, or a T stack", () => {
    const multiC = B();
    multiC.layout = { ...multiC.layout, nC: 2 };
    expect(violations(multiC)).toEqual(["multiCT"]);
    const multiT = B();
    multiT.layout = { ...multiT.layout, nT: 2 };
    expect(violations(multiT)).toEqual(["multiCT"]);
    const tStack = B();
    tStack.layout = { ...tStack.layout, stackAxis: "t" };
    expect(violations(tStack)).toEqual(["multiCT"]);
  });

  it("no IPP", () => {
    const b = B();
    b.layout = { ...b.layout, ippAt: undefined };
    expect(violations(b)).toEqual(["noIpp"]);
  });

  it("one series only", () => {
    expect(checkConcat([A()])).toMatchObject({ ok: false, violations: ["tooFew"] });
  });

  it("a series inside another one (nothing left after the cut)", () => {
    const r = checkConcat([part("A", 0, 100), part("B", 40, 10)]);
    expect(r.ok).toBe(false);
    expect(r.violations).toContain("nested");
  });

  it("reports every violation at once", () => {
    const r = checkConcat([A(), { ...B(), patientId: "P2", modality: "MR", frameOfReferenceUid: "X" }]);
    expect(r.violations).toEqual(["patient", "frameOfReference", "modality"]);
  });

  it("concatLayouts refuses with the same violations", () => {
    const r = concatLayouts([A(), { ...B(), patientId: "P2" }]);
    expect(r).toMatchObject({ ok: false, violations: ["patient"] });
  });
});

describe("restrictLayout then concat (partial series in a concat)", () => {
  it("uses the restricted range of each part", () => {
    const a = part("A", 0, 100);
    const ra = restrictLayout(a.layout, { kind: "mm", fromMm: 50, toMm: 99 });
    expect(ra.ok).toBe(true);
    if (!ra.ok) return;
    const r = concatOk([{ ...a, layout: ra.layout }, part("B", 100, 100)]);
    expect(r.layout.nZ).toBe(150);
    expect(r.joints[0].gapMm).toBeCloseTo(0, 9);
  });
});
