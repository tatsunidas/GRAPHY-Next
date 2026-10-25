/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { carryOver, entryToSavedRoi, retargetEntries, retargetEntry, type ImageGrid, type RoiClipboardEntry } from "./roiClipboard";
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

const grid = (cols: number, rows: number, sp: number): ImageGrid => ({ cols, rows, colSpacing: sp, rowSpacing: sp });
const mm = (e: RoiClipboardEntry, sp: number) => (e.pointsPx[1][0] - e.pointsPx[0][0]) * sp;

describe("retargetEntry（別の画像へ貼るとき実寸を保つ）", () => {
  const src = grid(512, 512, 0.7);
  const e = entry({ source: src });

  it("同じ寸法・同じ間隔（同じシリーズ）は恒等", () => {
    expect(retargetEntry(e, grid(512, 512, 0.7))).toBe(e);
  });

  it("画素間隔が違う画像へ貼っても幅(mm)が保たれる", () => {
    const out = retargetEntry(e, grid(256, 256, 1.4))!;
    expect(mm(out, 1.4)).toBeCloseTo(mm(e, 0.7), 9);
    // 旧方式（画素のまま）なら 2 倍になる＝この検査が落ちる負例
    expect(mm(e, 1.4)).not.toBeCloseTo(mm(e, 0.7), 3);
  });

  it("重心は画像内の同じ相対位置に置く", () => {
    const out = retargetEntry(e, grid(256, 256, 1.4))!;
    const cx = out.pointsPx.reduce((a, p) => a + p[0], 0) / 4;
    expect(cx / 256).toBeCloseTo(15 / 512, 9);
  });

  it("画像の外へ出るなら null", () => {
    const edge = entry({ source: src, pointsPx: [[500, 500], [510, 500], [510, 510], [500, 510]] });
    expect(retargetEntry(edge, grid(64, 64, 0.1))).toBeNull();
  });

  it("間隔か寸法が不明なら画素のまま", () => {
    const unknown: ImageGrid = { cols: 512, rows: 512, colSpacing: null, rowSpacing: null };
    expect(retargetEntry(e, unknown)).toBe(e);
    expect(retargetEntry({ ...e, source: unknown }, grid(256, 256, 1.4))).toEqual({ ...e, source: unknown });
  });
});

describe("carryOver（別の患者へは説明と custom を持ち越さない）", () => {
  const e = entry({ label: "L", description: "所見", custom: { a: "1" }, sourcePatientKey: "P1" });
  it("別の患者: ラベルだけ残す", () => {
    const o = carryOver(e, "P2");
    expect(o.label).toBe("L");
    expect(o.description).toBeUndefined();
    expect(o.custom).toBeUndefined();
  });
  it("同じ患者: すべて引き継ぐ", () => {
    expect(carryOver(e, "P1")).toBe(e);
  });
});

describe("retargetEntries（複数をまとめて別の画像へ写す）", () => {
  const src = grid(512, 512, 0.7);
  const a = entry({ source: src, pointsPx: [[100, 100], [110, 100], [110, 110], [100, 110]] });
  const b = entry({ source: src, pointsPx: [[300, 100], [310, 100], [310, 110], [300, 110]] });

  it("同じ寸法・間隔なら恒等", () => {
    const out = retargetEntries([a, b], grid(512, 512, 0.7))!;
    expect(out).toEqual([a, b]);
  });

  it("全体で 1 つの重心・拡大率: ROI 同士の間隔（mm）が保たれる", () => {
    const out = retargetEntries([a, b], grid(256, 256, 1.4))!;
    const dx = out[1].pointsPx[0][0] - out[0].pointsPx[0][0];
    expect(dx * 1.4).toBeCloseTo(200 * 0.7, 9);
    // 形（大きさ mm）も保たれる
    expect((out[0].pointsPx[1][0] - out[0].pointsPx[0][0]) * 1.4).toBeCloseTo(10 * 0.7, 9);
  });

  it("1 件でも画像の外へ出るなら全体を捨てる", () => {
    const wide = entry({ source: src, pointsPx: [[10, 10], [20, 10], [20, 20], [10, 20]] });
    const far = entry({ source: src, pointsPx: [[500, 500], [510, 500], [510, 510], [500, 510]] });
    expect(retargetEntries([wide, far], grid(64, 64, 0.1))).toBeNull();
  });

  it("空は空、間隔不明は画素のまま", () => {
    expect(retargetEntries([], grid(64, 64, 0.1))).toEqual([]);
    const unknown: ImageGrid = { cols: 512, rows: 512, colSpacing: null, rowSpacing: null };
    expect(retargetEntries([a, b], unknown)).toEqual([a, b]);
  });
});
