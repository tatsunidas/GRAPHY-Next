/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { entryToSavedRoi, type RoiClipboardEntry } from "./roiClipboard";
import { buildAnnotationData } from "./roiPersistence";
import type { PointPx } from "./roiRead";

const SQUARE: PointPx[] = [
  [10, 10],
  [20, 10],
  [20, 20],
  [10, 20],
];

/** 貼り付け先スライスの平面。z = 50 mm にある軸平行なアキシャル 1 枚。 */
const toWorld = (p: PointPx) => [p[0] * 0.5 - 100, p[1] * 0.5 - 100, 50];

const entry = (over: Partial<RoiClipboardEntry> = {}): RoiClipboardEntry => ({
  tool: "RectangleROI",
  pointsPx: SQUARE,
  polylinePx: [],
  ...over,
});

const target = { roiUid: "new-uid", sopInstanceUid: "1.2.3.4", frame: null as number | null };

describe("entryToSavedRoi", () => {
  it("画素座標を貼り付け先の world へ載せ替える（面内の位置は同じ）", () => {
    const saved = entryToSavedRoi(entry(), target, toWorld);
    expect(saved).not.toBeNull();
    expect(saved!.roiUid).toBe("new-uid");
    expect(saved!.tool).toBe("RectangleROI");
    expect(saved!.sopInstanceUid).toBe("1.2.3.4");
    // すべての頂点が貼り付け先スライスの平面（z=50）に乗る。
    expect(saved!.points).toEqual([
      [-95, -95, 50],
      [-90, -95, 50],
      [-90, -90, 50],
      [-95, -90, 50],
    ]);
  });

  it("輪郭系は polyline も載せ替え、開いたままにする", () => {
    const saved = entryToSavedRoi(
      entry({ tool: "GraphyPolylineROI", pointsPx: SQUARE.slice(0, 2), polylinePx: SQUARE, isOpenContour: true }),
      target,
      toWorld,
    );
    expect(saved!.polyline).toHaveLength(4);
    expect(saved!.isOpenContour).toBe(true);
    // 組み立てた annotation.data でも開いたまま（閉じると面積が出てしまう）。
    const data = buildAnnotationData(saved!) as { contour: { closed: boolean } };
    expect(data.contour.closed).toBe(false);
  });

  it("🔴 splineType を落とさない（落とすと曲線が直線に戻る）", () => {
    const saved = entryToSavedRoi(entry({ tool: "GraphyPolygonROI", splineType: "CATMULLROM" }), target, toWorld);
    expect(saved!.splineType).toBe("CATMULLROM");
    expect((buildAnnotationData(saved!) as { spline?: { type: string } }).spline?.type).toBe("CATMULLROM");
  });

  it("マルチフレームはフレーム番号を持たせる（XA で 1 フレーム目に飛ばないため）", () => {
    const saved = entryToSavedRoi(entry(), { ...target, frame: 7 }, toWorld);
    expect(saved!.frame).toBe(7);
    // 単一フレームでは持たせない（古い保存と同じ経路で戻す）。
    expect(entryToSavedRoi(entry(), target, toWorld)!.frame).toBeUndefined();
  });

  it("🔴 貼り付け先スライスの local scope になる（global を引き継がない）", () => {
    const scope = { studyUid: "st", seriesUid: "se", z: 12, c: 0, t: 0 };
    const saved = entryToSavedRoi(entry(), { ...target, scope }, toWorld);
    expect(saved!.scope).toEqual(scope);
    expect(saved!.origin).toEqual(scope);
    expect(saved!.studyUid).toBe("st");
    expect(saved!.seriesUid).toBe("se");
  });

  it("ラベルは呼び出し側が決める（「(コピー)」の付与は表示側の都合）", () => {
    const saved = entryToSavedRoi(entry({ label: "腫瘍" }), target, toWorld, "腫瘍 (コピー)");
    expect(saved!.label).toBe("腫瘍 (コピー)");
  });

  it("1 点でも world へ落とせなければ全体を捨てる（形が変わった複製を作らない）", () => {
    const partial = (p: PointPx) => (p[0] === 20 ? null : toWorld(p));
    expect(entryToSavedRoi(entry(), target, partial)).toBeNull();
  });

  it("頂点が 1 つも無ければ null", () => {
    expect(entryToSavedRoi(entry({ pointsPx: [], polylinePx: [] }), target, toWorld)).toBeNull();
  });
});
