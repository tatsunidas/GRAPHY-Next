/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  announceKey,
  buildAnnounceEntries,
  dedupeAnnounce,
  dimMatches,
  segmentRoiLabel,
  selectSegmentIndices,
  type AnnounceSource,
} from "./maskBridgeCore";
import { sceneSourceKey } from "../viewer3d/scene3dStore";
import { nextDefaultRoiNumber } from "./roiRows";
import type { RoiMaskMeta } from "./roiMaskStore";

const scope = (c?: number | "all", t?: number | "all") => ({ studyUid: "S", seriesUid: "R", c, t });

function source(metas: Record<string, RoiMaskMeta>, segs: Record<string, number[]>, spheres: AnnounceSource["spheres"] = []): AnnounceSource {
  return {
    segmentations: Object.keys(metas).map((segmentationId) => ({ segmentationId })),
    metaOf: (id) => metas[id],
    segmentsOf: (id) => segs[id] ?? [1],
    colorOf: (_id, i) => [i * 10, 0, 0],
    spheres,
  };
}

describe("buildAnnounceEntries", () => {
  const q = { studyUid: "S", seriesUid: "R", c: 0, t: 0 };

  it("emits one entry per segment with the 2D row names and colors", () => {
    const src = source(
      { a: { label: "Liver", scope: scope(0, 0), segments: [1, 2], segmentLabels: { "1": "Lobe R" } } },
      { a: [1, 2] },
    );
    const out = buildAnnounceEntries(q, src);
    expect(out.map((e) => e.kind === "painted" && [e.segmentIndex, e.label, e.color])).toEqual([
      [1, "Lobe R", [10, 0, 0]],
      [2, "Liver #2", [20, 0, 0]],
    ]);
  });

  it("filters by study/series and by c/t, treating all/undefined as a match", () => {
    const src = source(
      {
        same: { label: "same", scope: scope(0, 0) },
        otherC: { label: "oc", scope: scope(1, 0) },
        otherT: { label: "ot", scope: scope(0, 2) },
        allC: { label: "ac", scope: scope("all", "all") },
        noCT: { label: "nc", scope: scope(undefined, undefined) },
        otherSeries: { label: "os", scope: { studyUid: "S", seriesUid: "X", c: 0, t: 0 } },
        noScope: { label: "none" },
      },
      {},
    );
    const ids = buildAnnounceEntries(q, src).map((e) => e.kind === "painted" && e.segmentationId);
    expect(ids).toEqual(["same", "allC", "noCT"]);
    // c/t を問わない問い合わせでは c/t の違いは除外されない
    const loose = buildAnnounceEntries({ studyUid: "S", seriesUid: "R" }, src).length;
    expect(loose).toBe(5);
  });

  it("includes parametric spheres in the same series/c/t only", () => {
    const sp = (id: string, o: Partial<AnnounceSource["spheres"][number]> = {}) => ({
      id, studyUid: "S", seriesUid: "R", center: [1, 2, 3] as [number, number, number], radiusMm: 5, c: 0 as number | "all", t: "all" as number | "all", color: "#ff8000", ...o,
    });
    const out = buildAnnounceEntries(q, source({}, {}, [sp("s1", { label: "Tumor" }), sp("s2"), sp("s3", { c: 1 }), sp("s4", { seriesUid: "X" })]));
    expect(out).toEqual([
      { kind: "sphere", sphereId: "s1", label: "Tumor", color: [255, 128, 0], center: [1, 2, 3], radiusMm: 5, c: 0, t: "all" },
      { kind: "sphere", sphereId: "s2", label: "ROI 2", color: [255, 128, 0], center: [1, 2, 3], radiusMm: 5, c: 0, t: "all" },
    ]);
  });
});

describe("segmentRoiLabel", () => {
  it("single segment uses meta.label; multi uses name then 'label #n'; nothing -> neutral ROI n", () => {
    expect(segmentRoiLabel({ label: "Mask A" }, 1, true)).toBe("Mask A");
    expect(segmentRoiLabel({ label: "Mask A" }, 2, false)).toBe("Mask A #2");
    expect(segmentRoiLabel({ label: "Mask A", segmentLabels: { "2": "Kidney" } }, 2, false)).toBe("Kidney");
    expect(segmentRoiLabel(undefined, 3, false)).toBe("ROI 3");
    expect(segmentRoiLabel({}, 1, true)).toBe("ROI 1");
  });
});

describe("selectSegmentIndices", () => {
  it("returns all, or only the requested segment (empty when absent)", () => {
    expect(selectSegmentIndices([1, 2, 3])).toEqual([1, 2, 3]);
    expect(selectSegmentIndices([1, 2, 3], 2)).toEqual([2]);
    expect(selectSegmentIndices([1, 2, 3], 9)).toEqual([]);
  });
});

describe("dimMatches", () => {
  it("matches any when either side is unspecified or all", () => {
    expect(dimMatches(undefined, 1)).toBe(true);
    expect(dimMatches("all", 1)).toBe(true);
    expect(dimMatches(1, undefined)).toBe(true);
    expect(dimMatches(1, 1)).toBe(true);
    expect(dimMatches(0, 1)).toBe(false);
  });
});

describe("announce / source keys", () => {
  it("dedupes by key and agrees with SceneObject.source keys", () => {
    const p = { kind: "painted" as const, segmentationId: "m", segmentIndex: 2, label: "x", color: null, c: 0 as const, t: 0 as const };
    expect(dedupeAnnounce([p, { ...p, label: "dup" }, { ...p, segmentIndex: 1 }])).toHaveLength(2);
    expect(announceKey(p)).toBe(sceneSourceKey({ origin: "2d", segmentationId: "m", segmentIndex: 2 }));
    expect(announceKey({ kind: "sphere", sphereId: "s", label: "", color: null, center: [0, 0, 0], radiusMm: 1, c: 0, t: 0 })).toBe(
      sceneSourceKey({ origin: "2d", sphereId: "s" }),
    );
    expect(sceneSourceKey({ origin: "server" })).toBeNull();
  });
});

describe("nextDefaultRoiNumber", () => {
  it("is max existing 'ROI n' + 1", () => {
    expect(nextDefaultRoiNumber([])).toBe(1);
    expect(nextDefaultRoiNumber(["ROI 1", "ROI 3", "Liver", undefined])).toBe(4);
  });
});
