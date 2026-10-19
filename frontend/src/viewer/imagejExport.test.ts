/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { imagejRoiType } from "./imagejExport";

describe("imagejRoiType", () => {
  it("Cobb 角は書き出さず、角度は従来どおり ANGLE", () => {
    expect(imagejRoiType("CobbAngle")).toBeNull();
    expect(imagejRoiType("Angle")).toBe("angle");
  });

  it("ほかのツールの振り分けは変わらない", () => {
    expect(imagejRoiType("EllipticalROI")).toBe("oval");
    expect(imagejRoiType("CircleROI")).toBe("oval");
    expect(imagejRoiType("RectangleROI")).toBe("rect");
    expect(imagejRoiType("PlanarFreehandROI")).toBe("freehand");
    expect(imagejRoiType("Length")).toBe("polyline");
    expect(imagejRoiType("Bidirectional")).toBe("polyline");
    expect(imagejRoiType("Probe")).toBe("point");
    expect(imagejRoiType("GraphyPointROI")).toBe("point");
    expect(imagejRoiType("GraphyPolylineROI")).toBe("polyline");
    expect(imagejRoiType("Unknown")).toBe("polygon");
  });
});
