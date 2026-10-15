/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { parseViewer3dCtx, viewer3dCtxChanged } from "./viewer3dCtx";

const ctx = (s = "S", r = "R", c?: number, t?: number, ts = 1) => ({ study: { studyInstanceUid: s }, series: { seriesInstanceUid: r }, c, t, ts });

describe("viewer3dCtxChanged", () => {
  it("ignores ts-only changes and treats missing c/t as 0", () => {
    expect(viewer3dCtxChanged(ctx(), ctx("S", "R", 0, 0, 99))).toBe(false);
  });
  it("detects a different study, series, c or t", () => {
    expect(viewer3dCtxChanged(ctx(), ctx("S2"))).toBe(true);
    expect(viewer3dCtxChanged(ctx(), ctx("S", "R2"))).toBe(true);
    expect(viewer3dCtxChanged(ctx(), ctx("S", "R", 1))).toBe(true);
    expect(viewer3dCtxChanged(ctx(), ctx("S", "R", 0, 3))).toBe(true);
  });
  it("does not reload for a removed/invalid value", () => {
    expect(viewer3dCtxChanged(ctx(), null)).toBe(false);
    expect(viewer3dCtxChanged(ctx(), parseViewer3dCtx("{broken"))).toBe(false);
  });
});
