/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { imageToWorldOnPlane, worldToImageOnPlane, type PlaneGeometry } from "./imageCoords";

// Axial, pixels 0.9 mm between rows (y) and 0.6 mm between columns (x): GNBP-1M-MR.
const mr: PlaneGeometry = {
  imagePositionPatient: [-76.5, -107.55, 0],
  rowCosines: [1, 0, 0],
  columnCosines: [0, 1, 0],
  rowPixelSpacing: 0.9,
  columnPixelSpacing: 0.6,
};

describe("worldToImageOnPlane", () => {
  it("divides x by the column spacing and y by the row spacing", () => {
    // 30 columns and 20 rows apart = 18 mm and 18 mm.
    const a = worldToImageOnPlane(mr, [0, 0, 0]);
    const b = worldToImageOnPlane(mr, [18, 18, 0]);
    expect(b[0] - a[0]).toBeCloseTo(30, 9);
    expect(b[1] - a[1]).toBeCloseTo(20, 9);
  });

  it("puts the centre of pixel (0,0) at (0.5, 0.5), as Cornerstone does", () => {
    const ic = worldToImageOnPlane(mr, mr.imagePositionPatient);
    expect(ic[0]).toBeCloseTo(0.5, 12);
    expect(ic[1]).toBeCloseTo(0.5, 12);
  });

  it("is the inverse of imageToWorldOnPlane, also when oblique", () => {
    const s = Math.SQRT1_2;
    const oblique: PlaneGeometry = { ...mr, rowCosines: [s, s, 0], columnCosines: [0, 0, -1] };
    for (const ic of [[0, 0], [12.25, 7.5], [255, 239]]) {
      const back = worldToImageOnPlane(oblique, imageToWorldOnPlane(oblique, ic));
      expect(back[0]).toBeCloseTo(ic[0], 9);
      expect(back[1]).toBeCloseTo(ic[1], 9);
    }
  });

  it("equals the upstream formula for isotropic pixels", () => {
    const iso: PlaneGeometry = { ...mr, rowPixelSpacing: 0.5, columnPixelSpacing: 0.5 };
    // upstream: ((w - o + r*rs/2 + c*cs/2)·r)/rs, (·c)/cs with rs = cs
    const w = [3.3, -7.1, 0];
    const up = [(w[0] - (-76.5) + 0.25) / 0.5, (w[1] - (-107.55) + 0.25) / 0.5];
    const ic = worldToImageOnPlane(iso, w);
    expect(ic[0]).toBeCloseTo(up[0], 12);
    expect(ic[1]).toBeCloseTo(up[1], 12);
  });

  it("returns NaN without geometry, so callers fall back as they did with Cornerstone", () => {
    const nan = [Number.NaN, Number.NaN, Number.NaN];
    const ic = worldToImageOnPlane({ ...mr, imagePositionPatient: nan }, [1, 2, 3]);
    expect(Number.isNaN(ic[0]) && Number.isNaN(ic[1])).toBe(true);
  });
});
