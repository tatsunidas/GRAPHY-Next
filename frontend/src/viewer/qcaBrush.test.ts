/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  brushEdges,
  brushWeight,
  defaultBrushRadius,
  mergeEdgeEdits,
  type BrushInput,
} from "./qcaBrush";

/** 等間隔 0.1 単位で n 点、左 −2 / 右 +2 のまっすぐな血管。 */
function straight(n: number, step = 0.1): Omit<BrushInput, "centerIndex" | "side" | "targetOffset" | "radius"> {
  return {
    positions: Array.from({ length: n }, (_, i) => i * step),
    pathIndices: Array.from({ length: n }, (_, i) => i * 2),
    edgeOffsets: Array.from({ length: n }, () => ({ left: -2, right: 2 })),
  };
}

describe("brushWeight", () => {
  it("中心で 1、半径で 0", () => {
    expect(brushWeight(0, 1)).toBeCloseTo(1, 9);
    expect(brushWeight(1, 1)).toBe(0);
    expect(brushWeight(1.5, 1)).toBe(0);
  });

  it("左右対称で、単調に減る", () => {
    expect(brushWeight(0.3, 1)).toBeCloseTo(brushWeight(-0.3, 1), 9);
    expect(brushWeight(0.2, 1)).toBeGreaterThan(brushWeight(0.6, 1));
  });

  it("両端で傾きが 0（境目に段差が出ない）", () => {
    // 半径の直前でほぼ 0、中心の直前でほぼ 1。折れ線の重みだと段差が見える。
    expect(brushWeight(0.99, 1)).toBeLessThan(0.001);
    expect(brushWeight(0.01, 1)).toBeGreaterThan(0.999);
  });

  it("半径 0 は中心だけ", () => {
    expect(brushWeight(0, 0)).toBe(1);
    expect(brushWeight(0.1, 0)).toBe(0);
  });
});

describe("brushEdges", () => {
  it("掴んだ点は必ず目標値になる", () => {
    const r = brushEdges({ ...straight(21), centerIndex: 10, side: "right", targetOffset: 3, radius: 0.5 });
    const center = r.find((e) => e.pathIndex === 20)!;
    expect(center.offset).toBeCloseTo(3, 9);
  });

  it("🔴 移動量を配る（ポインタ位置を各点へ当てはめない）", () => {
    // もとの形が保たれること。左右で違うオフセットを持たせ、押した後も差が残るか見る。
    const base = straight(21);
    base.edgeOffsets = base.edgeOffsets.map((e, i) => ({ ...e, right: 2 + (i % 2 === 0 ? 0.5 : 0) }));
    const r = brushEdges({ ...base, centerIndex: 10, side: "right", targetOffset: 3, radius: 0.5 });
    const at = (i: number) => r.find((e) => e.pathIndex === i * 2)!.offset;
    // 中心（偶数=+0.5 を持つ）は目標へ。隣（奇数）は 0.5 少ないまま押されている。
    expect(at(10)).toBeCloseTo(3, 9);
    expect(at(9)).toBeLessThan(at(10));
    expect(at(11)).toBeLessThan(at(10));
    // 押した量は中心で 0.5（3 − 2.5）。隣は重みぶんだけ小さい。
    expect(at(9) - base.edgeOffsets[9].right).toBeLessThan(0.5);
    expect(at(9) - base.edgeOffsets[9].right).toBeGreaterThan(0);
  });

  it("半径の外は触らない（動かしていない点を手修正済みにしない）", () => {
    const r = brushEdges({ ...straight(101), centerIndex: 50, side: "right", targetOffset: 3, radius: 0.5 });
    // 弧長 0.1 刻みなので、半径 0.5 に入るのは中心 ±4 点＝9 点。
    expect(r.length).toBe(9);
    const idx = r.map((e) => e.pathIndex / 2);
    expect(Math.min(...idx)).toBe(46);
    expect(Math.max(...idx)).toBe(54);
  });

  it("左右対称に効く", () => {
    const r = brushEdges({ ...straight(21), centerIndex: 10, side: "left", targetOffset: -3, radius: 0.5 });
    const at = (i: number) => r.find((e) => e.pathIndex === i * 2)!.offset;
    expect(at(9)).toBeCloseTo(at(11), 9);
  });

  it("🔴 中心線をまたげない（径が負にならない）", () => {
    const r = brushEdges({ ...straight(21), centerIndex: 10, side: "right", targetOffset: -5, radius: 0.5 });
    for (const e of r) expect(e.offset).toBeGreaterThanOrEqual(0.25);
    const l = brushEdges({ ...straight(21), centerIndex: 10, side: "left", targetOffset: 5, radius: 0.5 });
    for (const e of l) expect(e.offset).toBeLessThanOrEqual(-0.25);
  });

  it("動かさなければ何も返さない", () => {
    expect(brushEdges({ ...straight(21), centerIndex: 10, side: "right", targetOffset: 2, radius: 0.5 })).toEqual([]);
  });

  it("範囲外の掴みは無視する", () => {
    expect(brushEdges({ ...straight(5), centerIndex: 9, side: "right", targetOffset: 3, radius: 1 })).toEqual([]);
    expect(brushEdges({ ...straight(5), centerIndex: -1, side: "right", targetOffset: 3, radius: 1 })).toEqual([]);
  });

  it("🔴 効く範囲は弧長で決まる（計測点の間隔ではない）", () => {
    // 点の密度は解析区間の長さで変わる。番号で数える実装だと、同じ半径でも
    // 短い区間では血管の広い範囲が動いてしまう。**距離で切れているか**を見る。
    for (const [n, step, center] of [[201, 0.05, 100], [51, 0.2, 25]] as const) {
      const base = straight(n, step);
      const r = brushEdges({ ...base, centerIndex: center, side: "right", targetOffset: 3, radius: 0.5 });
      const p0 = base.positions[center];
      const reach = Math.max(...r.map((e) => Math.abs(base.positions[e.pathIndex / 2] - p0)));
      // どの点も半径の外へは出ない。届く距離は「半径 − 最大 1 刻み」以上ある。
      expect(reach).toBeLessThan(0.5);
      expect(reach).toBeGreaterThanOrEqual(0.5 - step);
    }
  });
});

describe("mergeEdgeEdits", () => {
  it("既存の手修正へ重ねる（他の点・反対側は残す）", () => {
    const cur = { 4: { left: -1 }, 6: { right: 9 } };
    const next = mergeEdgeEdits(cur, [{ pathIndex: 4, side: "right", offset: 2 }]);
    expect(next[4]).toEqual({ left: -1, right: 2 });
    expect(next[6]).toEqual({ right: 9 });
  });

  it("後から当てたブラシが勝つ", () => {
    const a = mergeEdgeEdits({}, [{ pathIndex: 4, side: "right", offset: 2 }]);
    const b = mergeEdgeEdits(a, [{ pathIndex: 4, side: "right", offset: 5 }]);
    expect(b[4].right).toBe(5);
  });

  it("元のオブジェクトを壊さない", () => {
    const cur = { 4: { left: -1 } };
    mergeEdgeEdits(cur, [{ pathIndex: 4, side: "left", offset: -3 }]);
    expect(cur[4]).toEqual({ left: -1 });
  });
});

describe("defaultBrushRadius", () => {
  it("単位に応じて既定を変える", () => {
    expect(defaultBrushRadius("mm")).toBeGreaterThan(0);
    expect(defaultBrushRadius("px")).toBeGreaterThan(defaultBrushRadius("mm"));
  });
});
