/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { parseViewer3dCtx, shouldApplyPluginView, viewer3dCtxChanged, type Viewer3DPluginView } from "./viewer3dCtx";

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

const pv = (seq: number): Viewer3DPluginView => ({
  seq,
  camera: { direction: [0, 0, 1], up: [0, -1, 0] },
  provenance: { pluginId: "p", pluginName: "P", pluginVersion: "1" },
});

describe("pluginView", () => {
  it("視点だけの更新（pluginView の有無・seq の違い）は読み直しにならない", () => {
    const base = ctx();
    expect(viewer3dCtxChanged(base, { ...ctx(), pluginView: pv(1) })).toBe(false);
    expect(viewer3dCtxChanged({ ...base, pluginView: pv(1) }, { ...ctx(), pluginView: pv(2) })).toBe(false);
    // シリーズが違えば従来どおり読み直す（pluginView があっても）
    expect(viewer3dCtxChanged(base, { ...ctx("S", "R2"), pluginView: pv(1) })).toBe(true);
  });

  it("seq が大きいときだけ適用する（同じ・古いものは無視、初回は適用）", () => {
    expect(shouldApplyPluginView(null, pv(1))).toBe(true);
    expect(shouldApplyPluginView(1, pv(1))).toBe(false);
    expect(shouldApplyPluginView(2, pv(1))).toBe(false);
    expect(shouldApplyPluginView(1, pv(2))).toBe(true);
  });

  it("pluginView が無い・seq が非有限なら適用しない", () => {
    expect(shouldApplyPluginView(null, undefined)).toBe(false);
    expect(shouldApplyPluginView(null, null)).toBe(false);
    expect(shouldApplyPluginView(null, { ...pv(1), seq: NaN })).toBe(false);
  });
});
