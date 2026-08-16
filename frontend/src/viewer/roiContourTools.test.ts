/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  canSplineFit,
  contourToolConfig,
  ensureSplineInstance,
  CONTOUR_TOOL_NAMES,
  isSplineFitted,
  setSplineFitOn,
  toggleSplineFit,
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

  it("登録時の設定: ポリゴン系は直線、フリーハンドは閉/開を分ける", () => {
    // **登録は 1 回きり**なので、ここで渡し損ねると後から直せない（実機で踏んだ）
    expect(contourToolConfig(CONTOUR_TOOL_NAMES.polygon)).toEqual({ spline: { type: "LINEAR" } });
    expect(contourToolConfig(CONTOUR_TOOL_NAMES.polyline)).toEqual({ spline: { type: "LINEAR" } });
    expect(contourToolConfig(CONTOUR_TOOL_NAMES.freehand)).toEqual({ allowOpenContours: false });
    expect(contourToolConfig(CONTOUR_TOOL_NAMES.freeLine)).toEqual({ allowOpenContours: true });
    expect(contourToolConfig("EllipticalROI")).toEqual({});
  });

  it("スプライン Fit の ON/OFF が補間方法に対応する", () => {
    expect(splineTypeFor(false)).toBe("LINEAR");
    expect(splineTypeFor(true)).toBe("CATMULLROM");
  });
});

/** ポリゴン系 ROI の作りかけ（スプライン情報つき）。 */
const polygonAnnotation = (type = "LINEAR", tool: string = CONTOUR_TOOL_NAMES.polygon) => ({
  metadata: { toolName: tool },
  data: { spline: { type, instance: { closed: true } }, handles: { points: [] } },
  invalidated: false,
});

describe("スプライン Fit（選択中の ROI への操作）", () => {
  it("ポリゴン系にだけ適用できる", () => {
    expect(canSplineFit(polygonAnnotation())).toBe(true);
    expect(canSplineFit(polygonAnnotation("LINEAR", CONTOUR_TOOL_NAMES.polyline))).toBe(true);
    // フリーハンド・楕円などは対象外
    expect(canSplineFit(polygonAnnotation("LINEAR", CONTOUR_TOOL_NAMES.freehand))).toBe(false);
    expect(canSplineFit({ metadata: { toolName: "EllipticalROI" }, data: {} })).toBe(false);
    // spline 情報が無いものも対象外
    expect(canSplineFit({ metadata: { toolName: CONTOUR_TOOL_NAMES.polygon }, data: {} })).toBe(false);
  });

  it("補間インスタンスはツールに作らせる（型を書くだけでは形が変わらないため）", () => {
    const ann = polygonAnnotation();
    const calls: Array<[unknown, string]> = [];
    const fakeTool = {
      createSplineObjectFromType: (a: { data: { spline: unknown } }, type: string) => {
        calls.push([a, type]);
        a.data.spline = { type, instance: { closed: true }, resolution: 20 };
      },
    };
    expect(setSplineFitOn(ann, true, () => fakeTool)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toBe("CATMULLROM");
    expect(ann.data.spline.type).toBe("CATMULLROM");
    expect(ann.invalidated).toBe(true);
    expect(isSplineFitted(ann)).toBe(true);
  });

  it("ツールを引けないときも型だけ残し、**インスタンスは消さない**", () => {
    // 消すと再描画前のヒットテスト（isPointNearCurve）が undefined を触って落ちる（実機で踏んだ）
    const ann = polygonAnnotation();
    expect(setSplineFitOn(ann, true, () => null)).toBe(true);
    expect(ann.data.spline.type).toBe("CATMULLROM");
    expect(ann.data.spline.instance).toBeDefined();
  });

  it("既に同じ状態なら何もしない", () => {
    const ann = polygonAnnotation("CATMULLROM");
    expect(setSplineFitOn(ann, true)).toBe(false);
  });

  it("対象外の ROI には何もしない", () => {
    const ellipse = { metadata: { toolName: "EllipticalROI" }, data: {}, invalidated: false };
    expect(setSplineFitOn(ellipse, true)).toBe(false);
    expect(ellipse.invalidated).toBe(false);
  });

  it("複数選択: 全部が曲線なら解除、そうでなければ適用する", () => {
    const a = polygonAnnotation("CATMULLROM");
    const b = polygonAnnotation("CATMULLROM");
    expect(toggleSplineFit([a, b])).toEqual({ applied: 2, enabled: false });
    expect(a.data.spline.type).toBe("LINEAR");

    const c = polygonAnnotation("LINEAR");
    const d = polygonAnnotation("CATMULLROM");
    // 混在は曲線に揃える（d は既に曲線なので変更は 1 件）
    expect(toggleSplineFit([c, d])).toEqual({ applied: 1, enabled: true });
    expect(c.data.spline.type).toBe("CATMULLROM");
  });

  it("対象が 1 つも無ければ enabled=null（呼び出し側が理由を出せる）", () => {
    const ellipse = { metadata: { toolName: "EllipticalROI" }, data: {} };
    expect(toggleSplineFit([ellipse])).toEqual({ applied: 0, enabled: null });
    expect(toggleSplineFit([])).toEqual({ applied: 0, enabled: null });
  });
});

describe("復元時の補間インスタンス", () => {
  it("スプライン系なのにインスタンスが無ければツールに作らせる", () => {
    // 保存形から組み立てた直後の姿（type だけある）
    const ann = {
      metadata: { toolName: CONTOUR_TOOL_NAMES.polygon },
      data: { spline: { type: "CATMULLROM" }, handles: { points: [] } },
    };
    const tool = {
      createSplineObjectFromType: (a: { data: { spline: unknown } }, type: string) => {
        a.data.spline = { type, instance: { closed: true }, resolution: 20 };
      },
    };
    expect(ensureSplineInstance(ann, () => tool)).toBe(true);
    expect((ann.data.spline as { instance?: unknown }).instance).toBeDefined();
    expect(ann.data.spline.type).toBe("CATMULLROM");
  });

  it("spline 情報がまったく無い古い保存でも type を補って落とさない", () => {
    // splineType を保存していなかった時代の ROI（これが原因で描画時に落ちた）
    const ann = { metadata: { toolName: CONTOUR_TOOL_NAMES.polyline }, data: { handles: { points: [] } } };
    const tool = {
      createSplineObjectFromType: (a: { data: { spline?: unknown } }, type: string) => {
        a.data.spline = { type, instance: {} };
      },
    };
    expect(ensureSplineInstance(ann, () => tool)).toBe(true);
    expect((ann.data as { spline?: { type?: string } }).spline?.type).toBe("LINEAR");
  });

  it("ツールを引けなくても type だけは持たせる", () => {
    const ann = { metadata: { toolName: CONTOUR_TOOL_NAMES.polygon }, data: {} };
    expect(ensureSplineInstance(ann, () => null)).toBe(false);
    expect((ann.data as { spline?: { type?: string } }).spline?.type).toBe("LINEAR");
  });

  it("スプライン系でないツールには何もしない", () => {
    const ann = { metadata: { toolName: "EllipticalROI" }, data: {} };
    expect(ensureSplineInstance(ann, () => null)).toBe(false);
    expect((ann.data as { spline?: unknown }).spline).toBeUndefined();
  });

  it("contour が無ければ入れ物を作る（描画ループで落ちるのを防ぐ）", () => {
    const ann = {
      metadata: { toolName: CONTOUR_TOOL_NAMES.polygon },
      data: { spline: { type: "LINEAR" }, handles: { points: [] } },
    };
    ensureSplineInstance(ann, () => ({ createSplineObjectFromType: (a: any, type: string) => { a.data.spline = { type, instance: {} }; } }));
    expect((ann.data as { contour?: { closed?: boolean } }).contour).toEqual({ polyline: [], closed: true });
  });

  it("開いた線として復元するときは contour.closed=false", () => {
    const ann = {
      metadata: { toolName: CONTOUR_TOOL_NAMES.polyline },
      data: { spline: { type: "LINEAR" }, isOpenContour: true, handles: { points: [] } },
    };
    ensureSplineInstance(ann, () => null);
    expect((ann.data as { contour?: { closed?: boolean } }).contour?.closed).toBe(false);
  });

  it("既にインスタンスがあれば作り直さない", () => {
    const ann = {
      metadata: { toolName: CONTOUR_TOOL_NAMES.polygon },
      data: { spline: { type: "LINEAR", instance: { tag: "old" } } },
    };
    let called = 0;
    expect(ensureSplineInstance(ann, () => ({ createSplineObjectFromType: () => { called++; } }))).toBe(true);
    expect(called).toBe(0);
    expect((ann.data.spline.instance as { tag: string }).tag).toBe("old");
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

  it("polyline が無い輪郭系 ROI でも contour の入れ物を作る", () => {
    const noPolyline = {
      annotationUID: "a4",
      metadata: { toolName: CONTOUR_TOOL_NAMES.polygon, referencedImageId: "wadouri:x" },
      data: { handles: { points: [[0, 0, 0], [1, 0, 0], [1, 1, 0]] }, spline: { type: "LINEAR" } },
    };
    const saved = toSavedRoi(noPolyline, ctx);
    const data = buildAnnotationData(saved!) as { contour?: { closed?: boolean; polyline?: number[][] } };
    expect(data.contour).toEqual({ polyline: [], closed: true });
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
