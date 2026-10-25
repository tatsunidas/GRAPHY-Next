import { describe, expect, it } from "vitest";
import { buildCurvedMprContext, validateCurvedMprSpec, type PluginCurvedMprSpec } from "./pluginCurvedMprApi";
import { countOutOfBounds, toVoxelIndex } from "../curvedmpr/curveBounds";

const resolver = (uid: string) => (uid === "S1" ? "ST1" : undefined);
const line: [number, number, number][] = [[0, 0, 0], [0, 0, 10], [0, 0, 20]];
const base = (over: Partial<PluginCurvedMprSpec> = {}): PluginCurvedMprSpec => ({ source: { seriesUid: "S1" }, centerline: line, ...over });

describe("validateCurvedMprSpec", () => {
  it("accepts a helix and a straight line", () => {
    const helix: [number, number, number][] = Array.from({ length: 40 }, (_, i) => [10 * Math.cos(i / 4), 10 * Math.sin(i / 4), i * 1.5]);
    expect(validateCurvedMprSpec(base({ centerline: helix }), resolver)).toEqual({ ok: true, studyUid: "ST1" });
    expect(validateCurvedMprSpec(base(), resolver)).toEqual({ ok: true, studyUid: "ST1" });
  });
  it("rejects a single point, NaN, non-finite and duplicate neighbours", () => {
    expect(validateCurvedMprSpec(base({ centerline: [[0, 0, 0]] }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ centerline: [[0, 0, 0], [NaN, 0, 1]] }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ centerline: [[0, 0, 0], [Infinity, 0, 1]] }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ centerline: [[0, 0, 0], [1, 1, 1], [1, 1, 1]] }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ centerline: [[0, 0], [1, 1]] as unknown as [number, number, number][] }), resolver).ok).toBe(false);
  });
  it("rejects a series that is not open, and a mismatching studyUid", () => {
    expect(validateCurvedMprSpec(base({ source: { seriesUid: "X" } }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ source: { seriesUid: "S1", studyUid: "OTHER" } }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ source: { seriesUid: "S1", studyUid: "ST1" } }), resolver).ok).toBe(true);
  });
  it("rejects bad options", () => {
    expect(validateCurvedMprSpec(base({ options: { secondAxisRangeMm: [5, 5] } }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ options: { secondAxisRangeMm: [10, -10] } }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ options: { arcStepMm: 0 } }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ options: { bandHalfWidthMm: -1 } }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ options: { frameMode: "X" as never } }), resolver).ok).toBe(false);
    expect(validateCurvedMprSpec(base({ options: { secondAxisRangeMm: [-20, 20], arcStepMm: 0.5, bandHalfWidthMm: 2 } }), resolver).ok).toBe(true);
  });
});

describe("buildCurvedMprContext", () => {
  const producer = { id: "p", name: "P", version: "1.0.0" };
  it("takes provenance from the host and defaults frameMode to ROTATION_MINIMIZING", () => {
    const ctx = buildCurvedMprContext(base({ title: "RCA" }), producer, { studyInstanceUid: "ST1" } as never, undefined, "RCA");
    expect(ctx.provenance).toEqual({ pluginId: "p", pluginName: "P", pluginVersion: "1.0.0", title: "RCA" });
    expect(ctx.options?.frameMode).toBe("ROTATION_MINIMIZING");
    expect(ctx.centerline).toEqual(line);
    expect(ctx.centerline).not.toBe(line);
  });
  it("keeps an explicit frameMode", () => {
    const ctx = buildCurvedMprContext(base({ options: { frameMode: "FIXED_Z" } }), producer, { studyInstanceUid: "ST1" } as never, undefined);
    expect(ctx.options?.frameMode).toBe("FIXED_Z");
  });
});

describe("countOutOfBounds", () => {
  const vol = { direction: [1, 0, 0, 0, 1, 0, 0, 0, 1], origin: [0, 0, 0], spacing: [2, 2, 2], dimensions: [10, 10, 10] } as never;
  it("maps LPS mm to voxel index", () => {
    expect(toVoxelIndex(vol, [4, 6, 8])).toEqual([2, 3, 4]);
  });
  it("counts none for points inside and reports the first outside point (positive and negative cases)", () => {
    expect(countOutOfBounds(vol, [[0, 0, 0], [18, 18, 18]]).outside).toBe(0);
    const r = countOutOfBounds(vol, [[0, 0, 0], [19, 0, 0], [0, -0.1, 0]]);
    expect(r.outside).toBe(2);
    expect(r.total).toBe(3);
    expect(r.first).toEqual([19, 0, 0]);
  });
});
