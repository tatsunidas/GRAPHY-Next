import { describe, expect, it } from "vitest";
import { canConvertMeasureToRoi, measureToSavedRoi } from "./measureToRoi";

const base = { roiUid: "new-1", sopInstanceUid: "1.2.3", frame: null as number | null };

describe("canConvertMeasureToRoi", () => {
  it("Length と Probe だけ変換できる", () => {
    expect(canConvertMeasureToRoi("Length")).toBe(true);
    expect(canConvertMeasureToRoi("Probe")).toBe(true);
    for (const t of ["Bidirectional", "Angle", "CobbAngle", "EllipticalROI", "GraphyPointROI", undefined]) {
      expect(canConvertMeasureToRoi(t), String(t)).toBe(false);
    }
  });
});

describe("measureToSavedRoi", () => {
  it("Length -> 開いたポリゴンライン（2 点・直線補間）", () => {
    const r = measureToSavedRoi("Length", [[0, 0, 0], [3, 4, 0]], { ...base, label: "病変", custom: { a: "1" } });
    expect(r).toMatchObject({
      roiUid: "new-1",
      tool: "GraphyPolylineROI",
      points: [[0, 0, 0], [3, 4, 0]],
      polyline: [[0, 0, 0], [3, 4, 0]],
      isOpenContour: true,
      splineType: "LINEAR",
      label: "病変",
      custom: { a: "1" },
    });
    expect(r?.frame).toBeUndefined();
  });

  it("Probe -> 点 ROI（先頭の 1 点）", () => {
    const r = measureToSavedRoi("Probe", [[1, 2, 3]], { ...base, frame: 4 });
    expect(r).toMatchObject({ tool: "GraphyPointROI", points: [[1, 2, 3]], frame: 4 });
    expect(r?.polyline).toBeUndefined();
  });

  it("scope と origin を引き継ぎ、scope から study/series/c/t を埋める", () => {
    const scope = { studyUid: "S", seriesUid: "R", z: "all" as const, c: 0, t: 2 };
    const r = measureToSavedRoi("Probe", [[1, 2, 3]], { ...base, scope });
    expect(r).toMatchObject({ scope, origin: scope, studyUid: "S", seriesUid: "R", c: 0, t: 2 });
  });

  it("点が足りない・非有限・対象外は null", () => {
    expect(measureToSavedRoi("Length", [[0, 0, 0]], base)).toBeNull();
    expect(measureToSavedRoi("Probe", [], base)).toBeNull();
    expect(measureToSavedRoi("Probe", [[NaN, 0, 0]], base)).toBeNull();
    expect(measureToSavedRoi("Angle", [[0, 0, 0], [1, 0, 0], [1, 1, 0]], base)).toBeNull();
  });
});
