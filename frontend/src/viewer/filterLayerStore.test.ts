/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Series, Study } from "../api";
import { _resetFilterLayerStore, getFilterLayers, setFilterLayers } from "./filterLayerStore";
import { addLayer } from "./filterLayers";

describe("filterLayerStore", () => {
  beforeEach(_resetFilterLayerStore);
  it("keeps layers per tile and returns the same empty array for a tile without layers", () => {
    const r = addLayer([], { id: "a", study: {} as Study, series: {} as Series, instances: [], rMm: 4, sigmaMm: 2, maxAbs: 3 });
    if ("error" in r) throw new Error(r.error);
    setFilterLayers("t1", r.layers);
    expect(getFilterLayers("t1")).toHaveLength(1);
    expect(getFilterLayers("t2")).toBe(getFilterLayers("t3"));
    setFilterLayers("t1", []);
    expect(getFilterLayers("t1")).toHaveLength(0);
  });
});
