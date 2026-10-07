/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { LengthTool, RectangleROITool } from "@cornerstonejs/tools";
import { groupMembers, interiorHit, installInteriorGrab, isInsideClosedRoi, pointInPolygon, shiftAnnotation } from "./roiInteriorGrab";
import { CONTOUR_TOOL_NAMES, FreehandRoiTool } from "./roiContourTools";

// world の x,y をそのまま canvas とみなす（z は捨てる）。
const id = (w: number[]) => [w[0], w[1]];

const rect = (x0: number, y0: number, x1: number, y1: number) => ({
  metadata: { toolName: "RectangleROI" },
  // 0↔3・1↔2 が対角（上流の並び）。
  data: { handles: { points: [[x0, y0, 0], [x1, y0, 0], [x0, y1, 0], [x1, y1, 0]] } },
});

/** 中心 (cx,cy)・半径 a（長軸方向 θ）, b の楕円。並びは [bottom, top, left, right]。 */
const ellipse = (cx: number, cy: number, a: number, b: number, theta: number) => {
  const ux = Math.cos(theta), uy = Math.sin(theta);
  const vx = -uy, vy = ux;
  return {
    metadata: { toolName: "EllipticalROI" },
    data: {
      handles: {
        points: [
          [cx + vx * b, cy + vy * b, 0],
          [cx - vx * b, cy - vy * b, 0],
          [cx - ux * a, cy - uy * a, 0],
          [cx + ux * a, cy + uy * a, 0],
        ],
      },
    },
  };
};

// 凹んだ多角形（U 字）。(5,8) は凹みの中＝外側。
const U = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [7, 10, 0], [7, 3, 0], [3, 3, 0], [3, 10, 0], [0, 10, 0]];
const contour = (closed: boolean) => ({
  metadata: { toolName: CONTOUR_TOOL_NAMES.freehand },
  data: { contour: { closed, polyline: U } },
});

describe("閉じた ROI の内外判定", () => {
  it("矩形: 内側は真・外側は偽（始点と終点が逆向きでも同じ）", () => {
    for (const r of [rect(0, 0, 10, 20), rect(10, 20, 0, 0)]) {
      expect(isInsideClosedRoi(r, id, [5, 10])).toBe(true);
      expect(isInsideClosedRoi(r, id, [11, 10])).toBe(false);
      expect(isInsideClosedRoi(r, id, [5, -1])).toBe(false);
    }
  });

  it("楕円（30° 回転）: 長軸上の内側は真、短軸方向の外側は偽", () => {
    const th = Math.PI / 6;
    const e = ellipse(50, 50, 20, 5, th);
    expect(isInsideClosedRoi(e, id, [50 + 18 * Math.cos(th), 50 + 18 * Math.sin(th)])).toBe(true);
    // 回転を無視して軸平行で判定すると内側に入る点（x 方向に 18）——回転を扱えていれば外側。
    expect(isInsideClosedRoi(e, id, [68, 50])).toBe(false);
    expect(isInsideClosedRoi(e, id, [50 - 6 * Math.sin(th), 50 + 6 * Math.cos(th)])).toBe(false);
  });

  it("凹んだ多角形: 腕の中は真、凹みの中は偽", () => {
    expect(isInsideClosedRoi(contour(true), id, [1.5, 8])).toBe(true);
    expect(isInsideClosedRoi(contour(true), id, [5, 1.5])).toBe(true);
    expect(isInsideClosedRoi(contour(true), id, [5, 8])).toBe(false);
  });

  it("開いた輪郭・面を持たない注釈は常に偽", () => {
    expect(isInsideClosedRoi(contour(false), id, [1.5, 8])).toBe(false);
    expect(isInsideClosedRoi({ metadata: { toolName: "Length" }, data: { handles: { points: [[0, 0, 0], [10, 10, 0]] } } }, id, [5, 5])).toBe(false);
  });

  it("pointInPolygon の基本", () => {
    expect(pointInPolygon([[0, 0], [4, 0], [4, 4], [0, 4]], [2, 2])).toBe(true);
    expect(pointInPolygon([[0, 0], [4, 0], [4, 4], [0, 4]], [5, 2])).toBe(false);
  });
});

describe("内側を掴む条件", () => {
  const r = rect(0, 0, 10, 10);
  it("選択中かつ計測ツールが有効なときだけ内側を掴む", () => {
    expect(interiorHit(r, id, [5, 5], true, true)).toBe(true);
    expect(interiorHit(r, id, [5, 5], false, true)).toBe(false); // 未選択 → 内側に新しく描ける
    expect(interiorHit(r, id, [5, 5], true, false)).toBe(false); // W/L・Pan 中
    expect(interiorHit(r, id, [15, 5], true, true)).toBe(false); // 外側
  });
  it("ロック中・非表示の ROI は掴まない", () => {
    expect(interiorHit({ ...r, isLocked: true }, id, [5, 5], true, true)).toBe(false);
    expect(interiorHit({ ...r, isVisible: false }, id, [5, 5], true, true)).toBe(false);
  });
});

describe("上流ツールへの差し込み（上流を上げたらここで刺さるか確かめる）", () => {
  const opts = { isMeasureToolActive: () => true };
  it("矩形は isPointNearTool・toolSelectedCallback・handleSelectedCallback を包む（まとめて移動・選択の保持）", () => {
    const tool = new RectangleROITool() as unknown as Record<string, unknown>;
    const near = tool.isPointNearTool;
    const selected = tool.toolSelectedCallback;
    const handle = tool.handleSelectedCallback;
    expect(typeof near).toBe("function");
    installInteriorGrab(tool, opts);
    expect(tool.isPointNearTool).not.toBe(near);
    expect(tool.toolSelectedCallback).not.toBe(selected);
    expect(tool.handleSelectedCallback).not.toBe(handle);
  });
  it("Length（面を持たない計測）にもかかる（選択していればまとめて動く）", () => {
    const tool = new LengthTool() as unknown as Record<string, unknown>;
    const selected = tool.toolSelectedCallback;
    expect(typeof selected).toBe("function");
    installInteriorGrab(tool, opts);
    expect(tool.toolSelectedCallback).not.toBe(selected);
  });
  it("フリーハンドは toolSelectedCallback も包む（線を掴むと描き直し編集になるため）", () => {
    const tool = new FreehandRoiTool() as unknown as Record<string, unknown>;
    const selected = tool.toolSelectedCallback;
    expect(typeof tool.activateClosedContourEdit).toBe("function");
    installInteriorGrab(tool, opts);
    expect(tool.toolSelectedCallback).not.toBe(selected);
  });
  it("二重にかけない", () => {
    const tool = new RectangleROITool() as unknown as Record<string, unknown>;
    installInteriorGrab(tool, opts);
    const once = tool.isPointNearTool;
    installInteriorGrab(tool, opts);
    expect(tool.isPointNearTool).toBe(once);
  });
  it("元の判定（線の近く）が真なら選択に関係なく真のまま", () => {
    const tool = { isPointNearTool: () => true } as Record<string, unknown>;
    installInteriorGrab(tool, { isMeasureToolActive: () => false });
    expect((tool.isPointNearTool as (...a: unknown[]) => boolean)({}, rect(0, 0, 1, 1), [0, 0], 6)).toBe(true);
  });
});

describe("まとめて動かす注釈の選び方", () => {
  const ann = (uid: string, img: string, extra: Record<string, unknown> = {}) => ({
    annotationUID: uid,
    metadata: { referencedImageId: img },
    ...extra,
  });
  const all = [
    ann("a", "img10"),
    ann("b", "img10"),
    ann("c", "img10"), // 未選択
    ann("d", "img11"), // 別スライス
    ann("e", "img10", { isLocked: true }),
    ann("f", "img10", { isVisible: false }),
  ];
  it("選択中・表示中のスライス・ロックも非表示もないものだけ", () => {
    expect(groupMembers(["a", "b", "d", "e", "f"], all, "img10").map((a) => a.annotationUID)).toEqual(["a", "b"]);
  });
  it("別スライスを表示していれば、そちらの選択だけ", () => {
    expect(groupMembers(["a", "b", "d"], all, "img11").map((a) => a.annotationUID)).toEqual(["d"]);
  });
  it("表示中の画像が分からなければ何も動かさない", () => {
    expect(groupMembers(["a", "b"], all, undefined)).toEqual([]);
  });
});

describe("注釈の平行移動", () => {
  it("handles.points と輪郭、利用者が動かした文字ボックスを同じ量だけ動かす", () => {
    const a = {
      data: {
        handles: { points: [[0, 0, 0], [1, 1, 1]], textBox: { hasMoved: true, worldPosition: [5, 5, 5] } },
        contour: { polyline: [[2, 2, 2]] },
      },
    } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    shiftAnnotation(a, [1, -2, 0.5]);
    expect(a.data.handles.points).toEqual([[1, -2, 0.5], [2, -1, 1.5]]);
    expect(a.data.contour.polyline).toEqual([[3, 0, 2.5]]);
    expect(a.data.handles.textBox.worldPosition).toEqual([6, 3, 5.5]);
    expect(a.invalidated).toBe(true);
  });
  it("利用者が動かしていない文字ボックスは動かさない（上流が ROI に合わせて置き直す）", () => {
    const a = { data: { handles: { points: [[0, 0, 0]], textBox: { hasMoved: false, worldPosition: [5, 5, 5] } } } } as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    shiftAnnotation(a, [1, 1, 1]);
    expect(a.data.handles.textBox.worldPosition).toEqual([5, 5, 5]);
  });
});
