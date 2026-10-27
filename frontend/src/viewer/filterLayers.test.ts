/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import type { Series, SeriesLayoutDto, Study, TagDumpRow } from "../api";
import {
  LAYER_COLORS, MAX_LAYERS, addLayer, gridMismatch, layerMetaFromTags, layerWindow, parseDerivation,
  removeLayer, singleColorLut,
} from "./filterLayers";

const layout = (over: Partial<SeriesLayoutDto> = {}): SeriesLayoutDto => ({
  nZ: 3, nC: 1, nT: 1, cDimension: null, tDimension: null, cells: [],
  imageOrientationPatient: [1, 0, 0, 0, 1, 0], pixelSpacingRow: 1, pixelSpacingCol: 1, imageWidth: 64, imageHeight: 64,
  zSpatial: [0, 1, 2].map((z) => ({ z, imagePositionPatient: [0, 0, z * 2] as [number, number, number] })),
  frameOfReferenceUID: "1.2", ...over,
});

describe("parseDerivation", () => {
  const d = "filter=LoG; r_mm=4; sigma_mm=2.8868; scale_to_sigma=SQRT_D; dim=2D; truncate_sigma=4.0; boundary=MIRROR; radiomicsj=2.5.2";
  it("reads r and sigma of a LoG series", () => {
    expect(parseDerivation(d)).toEqual({ rMm: 4, sigmaMm: 2.8868, dim: "2D" });
  });
  it("refuses anything that is not a complete LoG record", () => {
    expect(parseDerivation("filter=Gabor; r_mm=4; sigma_mm=2")).toBeNull();
    expect(parseDerivation("filter=LoG; r_mm=4")).toBeNull();
    expect(parseDerivation("filter=LoG; r_mm=0; sigma_mm=1")).toBeNull();
    expect(parseDerivation("")).toBeNull();
  });
});

describe("layerMetaFromTags", () => {
  const rows = (imageType: string, ww = "8"): TagDumpRow[] => [
    { depth: 0, tag: "(0008,0008)", name: "ImageType", vr: "CS", value: imageType },
    { depth: 0, tag: "(0008,2111)", name: "DerivationDescription", vr: "ST", value: "filter=LoG; r_mm=2; sigma_mm=1.4142; dim=2D" },
    { depth: 0, tag: "(0028,1051)", name: "WindowWidth", vr: "DS", value: ww },
  ];
  it("reads r, sigma and the window top (half of WindowWidth)", () => {
    expect(layerMetaFromTags(rows("DERIVED\\SECONDARY\\LOG"))).toEqual({ rMm: 2, sigmaMm: 1.4142, maxAbs: 4 });
  });
  it("refuses a series that is not a LoG image", () => {
    expect(layerMetaFromTags(rows("DERIVED\\SECONDARY"))).toBeNull();
    expect(layerMetaFromTags(rows("DERIVED\\SECONDARY\\LOG", "0"))).toBeNull();
    expect(layerMetaFromTags([])).toBeNull();
  });
});

describe("gridMismatch", () => {
  it("accepts the same grid", () => expect(gridMismatch(layout(), layout())).toBeNull());
  it("refuses a 0.01 mm shift of one slice position", () => {
    const shifted = layout({ zSpatial: [0, 1, 2].map((z) => ({ z, imagePositionPatient: [0, z === 1 ? 0.01 : 0, z * 2] as [number, number, number] })) });
    expect(gridMismatch(layout(), shifted)?.kind).toBe("position");
  });
  it("refuses another size, spacing, orientation, slice count, or missing geometry", () => {
    expect(gridMismatch(layout(), layout({ imageHeight: 32 }))?.kind).toBe("size");
    expect(gridMismatch(layout(), layout({ pixelSpacingCol: 0.9 }))?.kind).toBe("spacing");
    expect(gridMismatch(layout(), layout({ imageOrientationPatient: [0, 1, 0, 1, 0, 0] }))?.kind).toBe("orientation");
    expect(gridMismatch(layout(), layout({ zSpatial: layout().zSpatial!.slice(0, 2) }))?.kind).toBe("count");
    expect(gridMismatch(layout(), layout({ imageOrientationPatient: null }))?.kind).toBe("missing");
  });
});

describe("layerWindow and colours", () => {
  it("uses the threshold as the lower end and flips the sign for the negative side", () => {
    expect(layerWindow("negative", 0, 8)).toEqual({ center: 4, width: 8, invert: true });
    expect(layerWindow("positive", 2, 8)).toEqual({ center: 5, width: 6, invert: false });
    expect(layerWindow("positive", 9, 8).width).toBeGreaterThan(0);
  });
  it("makes a ramp from black to the colour", () => {
    const l = singleColorLut("#E69F00");
    expect([l.r[0], l.g[0], l.b[0]]).toEqual([0, 0, 0]);
    expect([l.r[255], l.g[255], l.b[255]]).toEqual([0xe6, 0x9f, 0]);
    expect(new Set(LAYER_COLORS).size).toBe(MAX_LAYERS);
  });
});

describe("layers", () => {
  const study = { studyInstanceUid: "s" } as Study;
  const mk = (id: string) => ({ id, study, series: { seriesInstanceUid: id } as Series, instances: [], rMm: 2, sigmaMm: 1.4, maxAbs: 4 });
  it("adds up to three layers with different colours and refuses a duplicate and a fourth", () => {
    let layers = [] as ReturnType<typeof removeLayer>;
    for (const id of ["a", "b", "c"]) {
      const r = addLayer(layers, mk(id));
      if ("error" in r) throw new Error(r.error);
      layers = r.layers;
    }
    expect(new Set(layers.map((l) => l.color)).size).toBe(3);
    expect(layers.every((l) => l.threshold === 0 && l.side === "negative" && l.visible)).toBe(true);
    expect(addLayer(layers, mk("a"))).toEqual({ error: "duplicate" });
    expect(addLayer(layers, mk("d"))).toEqual({ error: "max" });
    const rest = removeLayer(layers, "b");
    expect(rest.map((l) => l.id)).toEqual(["a", "c"]);
    const again = addLayer(rest, mk("d"));
    expect("layers" in again && again.layers[2].color).toBe(layers[1].color); // 外した層の色を使い回す
  });
});
