/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  FREELINE_WAYPOINT_SPACING_PX,
  MIN_SAMPLE_POINTS,
  canCalibrateWith,
  minSegmentPx,
  pathLengthPx,
  segmentKindOf,
  segmentTooShort,
  suspiciousQcaReasons,
  toQcaKnots,
} from "./qcaInput";
import { CONTOUR_TOOL_NAMES } from "./roiContourTools";

describe("segmentKindOf — 解析区間に使える線", () => {
  it("長さ・ポリゴンライン・フリーラインを受ける", () => {
    expect(segmentKindOf("Length")).toBe("line");
    expect(segmentKindOf(CONTOUR_TOOL_NAMES.polyline)).toBe("polyline");
    expect(segmentKindOf(CONTOUR_TOOL_NAMES.freeLine)).toBe("freeline");
  });

  it("🔴 閉じた輪郭は受けない（中心線は閉じない）", () => {
    expect(segmentKindOf(CONTOUR_TOOL_NAMES.polygon)).toBeNull();
    expect(segmentKindOf(CONTOUR_TOOL_NAMES.freehand)).toBeNull();
  });

  it("面 ROI・角度・未知のツールも受けない", () => {
    for (const t of ["RectangleROI", "EllipticalROI", "Angle", "Bidirectional", "Probe", "", undefined]) {
      expect(segmentKindOf(t), String(t)).toBeNull();
    }
  });
});

describe("canCalibrateWith — 校正は直線に限る", () => {
  it("🔴 曲線では校正させない（経路長は既知の長さと意味が違う）", () => {
    // フリーラインで校正すると、手ぶれのぶんだけ経路長が伸び、mm/px が小さく出る。
    // その校正はその後のすべての計測を小さくするので、ここは縛る。
    expect(canCalibrateWith("line")).toBe(true);
    expect(canCalibrateWith("polyline")).toBe(false);
    expect(canCalibrateWith("freeline")).toBe(false);
    expect(canCalibrateWith(null)).toBe(false);
  });
});

describe("pathLengthPx", () => {
  it("直線は 2 点間距離と一致する", () => {
    expect(pathLengthPx([[0, 0], [3, 4]])).toBeCloseTo(5, 9);
  });

  it("折れ線は辺の合計（直線距離ではない）", () => {
    // 直線距離は 5 だが、経路長は 7。校正でこれを取り違えると mm/px がずれる。
    expect(pathLengthPx([[0, 0], [3, 0], [3, 4]])).toBeCloseTo(7, 9);
  });

  it("点が足りなければ 0", () => {
    expect(pathLengthPx([])).toBe(0);
    expect(pathLengthPx([[1, 1]])).toBe(0);
  });
});

describe("toQcaKnots — 頂点を始点・中間点・終点へ", () => {
  it("直線は中間点なし", () => {
    expect(toQcaKnots([[0, 0], [10, 0]], "line")).toEqual({ start: [0, 0], end: [10, 0], waypoints: [] });
  });

  it("ポリゴンラインは利用者が置いた点を 1 つも落とさない", () => {
    const pts: [number, number][] = [[0, 0], [5, 1], [10, 0], [15, 2]];
    expect(toQcaKnots(pts, "polyline")).toEqual({
      start: [0, 0],
      end: [15, 2],
      waypoints: [[5, 1], [10, 0]],
    });
  });

  it("🔴 フリーラインは弧長で間引く（全頂点を渡すと手ぶれが径に乗る）", () => {
    // 1px 刻みで 100 点。既定 12px 間隔なら中間点は 8 個程度に落ちる。
    const pts: [number, number][] = Array.from({ length: 100 }, (_, i) => [i, 0]);
    const k = toQcaKnots(pts, "freeline")!;
    expect(k.start).toEqual([0, 0]);
    expect(k.end).toEqual([99, 0]);
    expect(k.waypoints.length).toBeLessThan(10);
    expect(k.waypoints.length).toBeGreaterThan(5);
    // 間引いた点は元の頂点そのもの（内挿して新しい点を作らない）。
    for (const w of k.waypoints) expect(pts).toContainEqual(w);
  });

  it("間引きは頂点数ではなく距離で切る（描く速さで頂点密度が変わるため）", () => {
    // 同じ長さ 96px を、粗い頂点（8px 刻み）と細かい頂点（1px 刻み）で描いた場合。
    const coarse: [number, number][] = Array.from({ length: 13 }, (_, i) => [i * 8, 0]);
    const fine: [number, number][] = Array.from({ length: 97 }, (_, i) => [i, 0]);
    const a = toQcaKnots(coarse, "freeline")!.waypoints.length;
    const b = toQcaKnots(fine, "freeline")!.waypoints.length;
    expect(Math.abs(a - b)).toBeLessThanOrEqual(2);
  });

  it("間引きを 0 にすると全頂点が中間点になる", () => {
    const pts: [number, number][] = [[0, 0], [1, 0], [2, 0], [3, 0]];
    expect(toQcaKnots(pts, "freeline", 0)!.waypoints).toEqual([[1, 0], [2, 0]]);
  });

  it("2 点しかなければ種別によらず中間点なし", () => {
    expect(toQcaKnots([[0, 0], [9, 9]], "freeline")!.waypoints).toEqual([]);
  });

  it("点が足りなければ null", () => {
    expect(toQcaKnots([[0, 0]], "line")).toBeNull();
    expect(toQcaKnots([], "polyline")).toBeNull();
  });

  it("既定の間引き幅は定数で持つ", () => {
    expect(FREELINE_WAYPOINT_SPACING_PX).toBeGreaterThan(0);
  });
});

describe("segmentTooShort — 短すぎる区間で解析させない", () => {
  it("🚨 実機で無意味な結果が出た 9.2px は弾く", () => {
    // カテーテル校正用（6Fr = 2.0mm）の線がそのまま解析区間に使われ、
    // 10 点しか測れずに MLD > RVD の結果が出た。
    expect(segmentTooShort(9.2)).toBe(true);
  });

  it("プロファイル半径の 3 倍を下限にする", () => {
    expect(minSegmentPx(20)).toBe(60);
    expect(segmentTooShort(59.9, 20)).toBe(true);
    expect(segmentTooShort(60, 20)).toBe(false);
    // 半径を変えれば下限も動く（設定を変えたときに置いていかれない）。
    expect(minSegmentPx(10)).toBe(30);
    expect(segmentTooShort(40, 10)).toBe(false);
  });

  it("0 や NaN も短いと判定する", () => {
    expect(segmentTooShort(0)).toBe(true);
    expect(segmentTooShort(Number.NaN)).toBe(true);
  });
});

describe("suspiciousQcaReasons — もっともらしく間違った結果を拾う", () => {
  const ok = { mld: 1.2, rvd: 3.0, lesionLength: 8.4, diameters: new Array(120).fill(2) };

  it("まともな結果には何も出さない", () => {
    expect(suspiciousQcaReasons(ok)).toEqual([]);
  });

  it("🚨 実機の組み合わせ（MLD>RVD・10点・病変長0）を全部拾う", () => {
    const bad = { mld: 5.02, rvd: 4.9, lesionLength: 0, diameters: new Array(10).fill(5) };
    expect(suspiciousQcaReasons(bad).sort()).toEqual(
      ["mldNotBelowRvd", "noLesion", "tooFewSamples"].sort(),
    );
  });

  it("単独でも拾う（組み合わせでなくても異常は異常）", () => {
    expect(suspiciousQcaReasons({ ...ok, mld: 3.0 })).toEqual(["mldNotBelowRvd"]);
    expect(suspiciousQcaReasons({ ...ok, diameters: new Array(MIN_SAMPLE_POINTS - 1).fill(2) })).toEqual([
      "tooFewSamples",
    ]);
    expect(suspiciousQcaReasons({ ...ok, lesionLength: 0 })).toEqual(["noLesion"]);
  });
});
