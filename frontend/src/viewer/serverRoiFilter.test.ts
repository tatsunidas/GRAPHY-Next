/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { filterRtRois, filterSegSegments } from "./serverRoiFilter";

const sops = new Set(["a", "b"]);
const f = (u: string | null) => ({ referencedSopInstanceUid: u });

describe("server SEG/RTSTRUCT filter", () => {
  it("keeps segments/ROIs that reference the displayed series and drops unreferenced ones", () => {
    const segs = [{ n: 1, frames: [f("x"), f("a")] }, { n: 2, frames: [f("x")] }, { n: 3, frames: [f(null)] }];
    expect(filterSegSegments(segs, sops).map((s) => s.n)).toEqual([1]);
    const rois = [{ n: "p", contours: [f("b")] }, { n: "q", contours: [f("z")] }, { n: "r", contours: [] }];
    expect(filterRtRois(rois, sops).map((r) => r.n)).toEqual(["p"]);
  });
});
