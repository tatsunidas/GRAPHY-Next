/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  CONTOUR_TOOL_NAMES,
  isClosedContourTool,
  isOpenContourTool,
  openContour,
  splineTypeFor,
  supportsSplineFit,
} from "./roiContourTools";
import { hasShapeCalipers } from "./roiRead";
import { buildAnnotationData, toSavedRoi } from "./roiPersistence";

describe("輪郭系 ROI ツールの分類", () => {
  it("閉じる方だけを面として扱う", () => {
    expect(isClosedContourTool(CONTOUR_TOOL_NAMES.polygon)).toBe(true);
    expect(isClosedContourTool(CONTOUR_TOOL_NAMES.freehand)).toBe(true);
    expect(isClosedContourTool(CONTOUR_TOOL_NAMES.polyline)).toBe(false);
    expect(isClosedContourTool(CONTOUR_TOOL_NAMES.freeLine)).toBe(false);
  });

  it("開く方は線として扱う", () => {
    expect(isOpenContourTool(CONTOUR_TOOL_NAMES.polyline)).toBe(true);
    expect(isOpenContourTool(CONTOUR_TOOL_NAMES.freeLine)).toBe(true);
    expect(isOpenContourTool(CONTOUR_TOOL_NAMES.polygon)).toBe(false);
  });

  it("長径・短径は閉じた輪郭にだけ出す（開いた線には出さない）", () => {
    expect(hasShapeCalipers(CONTOUR_TOOL_NAMES.polygon)).toBe(true);
    expect(hasShapeCalipers(CONTOUR_TOOL_NAMES.freehand)).toBe(true);
    expect(hasShapeCalipers(CONTOUR_TOOL_NAMES.polyline)).toBe(false);
    expect(hasShapeCalipers(CONTOUR_TOOL_NAMES.freeLine)).toBe(false);
  });

  it("スプライン Fit が効くのはポリゴン系だけ（フリーハンドは点が密で意味が無い）", () => {
    expect(supportsSplineFit(CONTOUR_TOOL_NAMES.polygon)).toBe(true);
    expect(supportsSplineFit(CONTOUR_TOOL_NAMES.polyline)).toBe(true);
    expect(supportsSplineFit(CONTOUR_TOOL_NAMES.freehand)).toBe(false);
    expect(supportsSplineFit(CONTOUR_TOOL_NAMES.freeLine)).toBe(false);
  });

  it("スプライン Fit の ON/OFF が補間方法に対応する", () => {
    expect(splineTypeFor(false)).toBe("LINEAR");
    expect(splineTypeFor(true)).toBe("CATMULLROM");
  });
});

describe("開いた輪郭への矯正", () => {
  it("closed を落とし、開いた輪郭として印を付ける", () => {
    const ann = {
      data: { contour: { closed: true, polyline: [[0, 0, 0]] }, spline: { instance: { closed: true } } },
      invalidated: false,
    };
    openContour(ann);
    expect(ann.data.contour.closed).toBe(false);
    expect(ann.data.spline.instance.closed).toBe(false);
    expect((ann.data as { isOpenContour?: boolean }).isOpenContour).toBe(true);
    expect(ann.invalidated).toBe(true);
  });

  it("データが無くても落ちない", () => {
    expect(() => openContour(undefined)).not.toThrow();
    expect(() => openContour({})).not.toThrow();
  });
});

describe("スプライン Fit の永続化", () => {
  const ctx = {
    sopOf: () => "1.2.3",
    metaOf: () => undefined,
    ct: { c: 0, t: 0 },
  };

  const base = {
    annotationUID: "a1",
    metadata: { toolName: CONTOUR_TOOL_NAMES.polygon, referencedImageId: "wadouri:x" },
    data: {
      handles: { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] },
      contour: { polyline: [[0, 0, 0], [1, 0, 0], [1, 1, 0]], closed: true },
      spline: { type: "CATMULLROM" },
    },
  };

  it("補間方法を保存する（保存しないと読み直しでカクカクに戻る）", () => {
    const saved = toSavedRoi(base, ctx);
    expect(saved?.splineType).toBe("CATMULLROM");
  });

  it("復元すると同じ補間方法に戻る（インスタンスは持たせない）", () => {
    const saved = toSavedRoi(base, ctx);
    const data = buildAnnotationData(saved!) as { spline?: { type?: string; instance?: unknown } };
    expect(data.spline?.type).toBe("CATMULLROM");
    expect(data.spline?.instance).toBeUndefined();
  });

  it("スプラインでない ROI では splineType を書かない", () => {
    const plain = {
      annotationUID: "a2",
      metadata: { toolName: "EllipticalROI", referencedImageId: "wadouri:x" },
      data: { handles: { points: [[0, 0, 0], [1, 1, 0]] } },
    };
    const saved = toSavedRoi(plain, ctx);
    expect(saved?.splineType).toBeUndefined();
  });

  it("開いた線は復元しても開いたまま", () => {
    const open = {
      annotationUID: "a3",
      metadata: { toolName: CONTOUR_TOOL_NAMES.polyline, referencedImageId: "wadouri:x" },
      data: {
        handles: { points: [[0, 0, 0], [1, 0, 0]] },
        contour: { polyline: [[0, 0, 0], [1, 0, 0]], closed: false },
        isOpenContour: true,
        spline: { type: "LINEAR" },
      },
    };
    const saved = toSavedRoi(open, ctx);
    expect(saved?.isOpenContour).toBe(true);
    const data = buildAnnotationData(saved!) as { contour?: { closed?: boolean }; isOpenContour?: boolean };
    expect(data.contour?.closed).toBe(false);
    expect(data.isOpenContour).toBe(true);
  });
});
