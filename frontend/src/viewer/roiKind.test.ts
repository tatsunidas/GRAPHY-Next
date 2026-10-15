import { describe, expect, it } from "vitest";
import { roiKindOf, annotationRoiKind, type RoiKind } from "./roiKind";
import { isAreaRoi } from "./roiBooleanOps";

describe("roiKindOf", () => {
  const cases: Array<[string, boolean | undefined, RoiKind | null]> = [
    ["Length", undefined, "measure"],
    // "Bidirectional" は名前に "rect" を含む。面として扱ってはいけない。
    ["Bidirectional", undefined, "measure"],
    ["Angle", undefined, "measure"],
    ["CobbAngle", undefined, "measure"],
    ["Probe", undefined, "measure"],
    ["DragProbe", undefined, "measure"],
    ["EllipticalROI", undefined, "area"],
    ["CircleROI", undefined, "area"],
    ["RectangleROI", undefined, "area"],
    ["RectangleROIThreshold", undefined, "area"],
    ["PlanarFreehandROI", undefined, "area"],
    ["PlanarFreehandROI", true, "area"],
    ["PlanarFreehandROI", false, "line"],
    ["SplineROI", true, "area"],
    ["SplineROI", false, "line"],
    ["GraphyPolygonROI", undefined, "area"],
    ["GraphyFreehandROI", undefined, "area"],
    ["GraphyPolylineROI", undefined, "line"],
    ["GraphyFreeLineROI", undefined, "line"],
    ["GraphyPointROI", undefined, "point"],
    ["graphypointroi", undefined, "point"],
    ["ArrowAnnotate", undefined, null],
    ["", undefined, null],
  ];
  for (const [tool, closed, want] of cases) {
    it(`${tool || "(empty)"} closed=${String(closed)} -> ${String(want)}`, () => {
      expect(roiKindOf(tool, closed)).toBe(want);
    });
  }

  it("undefined のツール名は null", () => {
    expect(roiKindOf(undefined)).toBeNull();
  });

  it("Graphy の閉じる/開くツールは closed の値に左右されない", () => {
    expect(roiKindOf("GraphyPolylineROI", true)).toBe("line");
    expect(roiKindOf("GraphyPolygonROI", false)).toBe("area");
  });

  it("annotation から contour.closed を読む", () => {
    expect(annotationRoiKind({ metadata: { toolName: "PlanarFreehandROI" }, data: { contour: { closed: false } } })).toBe("line");
    expect(annotationRoiKind({ metadata: { toolName: "Bidirectional" } })).toBe("measure");
    expect(annotationRoiKind(null)).toBeNull();
  });

  it("isAreaRoi は面だけ true（Bidirectional・線・点は false）", () => {
    expect(isAreaRoi("EllipticalROI")).toBe(true);
    expect(isAreaRoi("GraphyPolygonROI")).toBe(true);
    expect(isAreaRoi("Bidirectional")).toBe(false);
    expect(isAreaRoi("GraphyPolylineROI")).toBe(false);
    expect(isAreaRoi("GraphyPointROI")).toBe(false);
    expect(isAreaRoi("Length")).toBe(false);
  });
});
