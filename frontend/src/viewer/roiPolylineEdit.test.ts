/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";

import {
  CONTOUR_TOOL_NAMES,
  canEditPoints,
  closestOnPolyline,
  insertPointAt,
  isOpenPolyline,
  joinPolylines,
  mergeOpenPolylines,
  minControlPoints,
  nearestPointIndex,
  removePointAt,
} from "./roiContourTools";

const line = (pts: number[][], tool: string = CONTOUR_TOOL_NAMES.polyline, image = "img1", closed = false) => ({
  annotationUID: `uid-${Math.random()}`,
  metadata: { toolName: tool, referencedImageId: image },
  data: { handles: { points: pts }, contour: { closed } },
});

describe("closestOnPolyline / insertPointAt", () => {
  const pts = [[0, 0], [10, 0], [10, 10]];

  it("最も近い辺と位置を返す", () => {
    const r = closestOnPolyline(pts, [5, 2], false)!;
    expect(r.segIndex).toBe(0);
    expect(r.t).toBeCloseTo(0.5);
    expect(r.distance).toBeCloseTo(2);
  });

  it("開いた線は終点→始点の辺を数えない／閉じた線は数える", () => {
    const p = [2, 5]; // 終点(10,10)→始点(0,0) の対角線に近い
    expect(closestOnPolyline(pts, p, false)!.segIndex).not.toBe(2);
    expect(closestOnPolyline(pts, p, true)!.segIndex).toBe(2);
  });

  it("点が 1 つ以下なら null", () => {
    expect(closestOnPolyline([[0, 0]], [1, 1], false)).toBeNull();
  });

  it("挿入は辺の途中へ。元の配列は変えない", () => {
    const out = insertPointAt(pts, 0, 0.5);
    expect(out).toEqual([[0, 0], [5, 0], [10, 0], [10, 10]]);
    expect(pts).toHaveLength(3);
  });

  it("閉じた線の最終辺には末尾へ入る", () => {
    const out = insertPointAt(pts, 2, 0.5);
    expect(out).toEqual([[0, 0], [10, 0], [10, 10], [5, 5]]);
  });

  it("3 次元（world）でも補間できる", () => {
    expect(insertPointAt([[0, 0, 0], [2, 4, 6]], 0, 0.5)[1]).toEqual([1, 2, 3]);
  });
});

describe("removePointAt / nearestPointIndex", () => {
  it("最小点数（ポリゴン 3、ポリゴンライン 2）を下回るときは null", () => {
    expect(minControlPoints(true)).toBe(3);
    expect(minControlPoints(false)).toBe(2);
    expect(removePointAt([[0, 0], [1, 0], [1, 1]], 0, true)).toBeNull();
    expect(removePointAt([[0, 0], [1, 0]], 0, false)).toBeNull();
    expect(removePointAt([[0, 0], [1, 0], [1, 1]], 1, false)).toEqual([[0, 0], [1, 1]]);
  });

  it("範囲外の番号は null", () => {
    expect(removePointAt([[0, 0], [1, 0], [1, 1]], 5, false)).toBeNull();
  });

  it("近い点だけを拾う", () => {
    const pts = [[0, 0], [50, 0]];
    expect(nearestPointIndex(pts, [3, 4], 10)).toBe(0);
    expect(nearestPointIndex(pts, [25, 0], 10)).toBe(-1);
  });
});

describe("mergeOpenPolylines", () => {
  it("a の終点と b の始点が最も近いとき、そのまま連結", () => {
    expect(mergeOpenPolylines([[0, 0], [1, 0]], [[2, 0], [3, 0]])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it("b を逆向きに引いていても向きをそろえる", () => {
    expect(mergeOpenPolylines([[0, 0], [1, 0]], [[3, 0], [2, 0]])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it("a を逆向きに引いていても向きをそろえる", () => {
    expect(mergeOpenPolylines([[1, 0], [0, 0]], [[2, 0], [3, 0]])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it("両方逆向きでもそろえる", () => {
    expect(mergeOpenPolylines([[1, 0], [0, 0]], [[3, 0], [2, 0]])).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it("接する点が同じ位置なら 1 点にまとめる", () => {
    expect(mergeOpenPolylines([[0, 0], [1, 0]], [[1, 0], [2, 0]])).toEqual([[0, 0], [1, 0], [2, 0]]);
  });

  it("入力を書き換えない", () => {
    const a = [[0, 0], [1, 0]];
    const b = [[3, 0], [2, 0]];
    mergeOpenPolylines(a, b);
    expect(a).toEqual([[0, 0], [1, 0]]);
    expect(b).toEqual([[3, 0], [2, 0]]);
  });
});

describe("対象の判定", () => {
  it("ポリゴン系だけが点の編集対象。フリーハンド・フリーラインは対象外", () => {
    expect(canEditPoints(line([[0, 0], [1, 1]], CONTOUR_TOOL_NAMES.polyline))).toBe(true);
    expect(canEditPoints(line([[0, 0], [1, 1], [2, 0]], CONTOUR_TOOL_NAMES.polygon, "img1", true))).toBe(true);
    expect(canEditPoints(line([[0, 0], [1, 1]], CONTOUR_TOOL_NAMES.freeLine))).toBe(false);
    expect(canEditPoints(line([[0, 0], [1, 1]], CONTOUR_TOOL_NAMES.freehand))).toBe(false);
  });

  it("続きを描く・つなぐの対象は開いたポリゴンラインだけ", () => {
    expect(isOpenPolyline(line([[0, 0], [1, 1]]))).toBe(true);
    expect(isOpenPolyline(line([[0, 0], [1, 1]], CONTOUR_TOOL_NAMES.polygon, "img1", true))).toBe(false);
    expect(isOpenPolyline(line([[0, 0], [1, 1]], CONTOUR_TOOL_NAMES.freeLine))).toBe(false);
  });
});

describe("joinPolylines", () => {
  it("2 本を 1 本にし、2 本目は消す（renderAnnotations は実環境が無くても落ちない）", () => {
    const a = line([[0, 0], [1, 0]]);
    const b = line([[3, 0], [2, 0]]);
    expect(joinPolylines([a, b])).toBe("ok");
    expect(a.data.handles.points).toEqual([[0, 0], [1, 0], [2, 0], [3, 0]]);
  });

  it("2 本でなければ count、種類が違えば kind、画像が違えば image", () => {
    expect(joinPolylines([line([[0, 0], [1, 0]])])).toBe("count");
    expect(joinPolylines([line([[0, 0], [1, 0]]), line([[2, 0], [3, 0]], CONTOUR_TOOL_NAMES.freeLine)])).toBe("kind");
    expect(joinPolylines([line([[0, 0], [1, 0]], CONTOUR_TOOL_NAMES.polyline, "a"), line([[2, 0], [3, 0]], CONTOUR_TOOL_NAMES.polyline, "b")])).toBe("image");
  });

  it("断ったときは元の線を変えない", () => {
    const a = line([[0, 0], [1, 0]], CONTOUR_TOOL_NAMES.polyline, "a");
    const b = line([[2, 0], [3, 0]], CONTOUR_TOOL_NAMES.polyline, "b");
    joinPolylines([a, b]);
    expect(a.data.handles.points).toEqual([[0, 0], [1, 0]]);
  });
});
