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
  type BrushInput, detectEdgeOutliers, localMedian, smoothEdges, robustLocalLine } from "./qcaBrush";

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

/* ------------------------------------------------------------------ */
/* 「ならす」ブラシ（2026-08-28）                                        */
/* ------------------------------------------------------------------ */

describe("localMedian", () => {
  it("弧長の窓で中央値を取る（外れ点に引っ張られない）", () => {
    const pos = [0, 1, 2, 3, 4];
    const val = [2, 2, 9, 2, 2]; // 真ん中だけ飛んでいる
    expect(localMedian(pos, val, 2, 2)).toBe(2);
  });

  it("窓が届かない点はその点自身の値（動かさない）", () => {
    expect(localMedian([0, 10], [1, 5], 0, 0.5)).toBe(1);
  });
});

describe("detectEdgeOutliers", () => {
  it("飛んでいる点だけを挙げる", () => {
    const pos = Array.from({ length: 21 }, (_, i) => i);
    const val = pos.map(() => 2);
    val[10] = 6;
    expect(detectEdgeOutliers(pos, val, 5)).toEqual([10]);
  });

  it("🔴 散らばりが 0 の平坦な区間を「全部外れ」にしない", () => {
    const pos = Array.from({ length: 21 }, (_, i) => i);
    const val = pos.map(() => 2);
    expect(detectEdgeOutliers(pos, val, 5)).toEqual([]);
  });

  it("窓に 5 点未満しか入らなければ判定しない（言えないことを言わない）", () => {
    expect(detectEdgeOutliers([0, 1, 2], [2, 9, 2], 1.5)).toEqual([]);
  });

  it("🔴 外れが大きくても検出できる（標準偏差だと外れ自身が閾値を膨らませる）", () => {
    const pos = Array.from({ length: 21 }, (_, i) => i);
    const val = pos.map(() => 2);
    val[10] = 500;
    expect(detectEdgeOutliers(pos, val, 5)).toContain(10);
  });
});

describe("smoothEdges", () => {
  const pos = Array.from({ length: 21 }, (_, i) => i);
  const make = (values: number[]) => values.map((v) => ({ left: -v, right: v }));

  it("🚨 外れ点は大きく動き、合っている点はほとんど動かない（押すブラシとの違い）", () => {
    const val = pos.map(() => 2);
    val[10] = 6;
    const out = smoothEdges({
      positions: pos,
      pathIndices: pos,
      edgeOffsets: make(val),
      centerIndex: 10,
      side: "right",
      radius: 5,
    });
    const byIndex = new Map(out.map((o) => [o.pathIndex, o.offset]));
    // 外れ点は中央値 2 へ大きく寄る
    expect(byIndex.get(10)!).toBeLessThan(4);
    // 隣の合っている点は動かない（結果に含まれない or 変化がごく小さい）
    for (const i of [8, 9, 11, 12]) {
      const v = byIndex.get(i);
      if (v !== undefined) expect(Math.abs(v - 2)).toBeLessThan(0.05);
    }
  });

  it("半径の外は触らない（動かしていない点を手修正済みにしない）", () => {
    const val = pos.map(() => 2);
    val[10] = 6;
    const out = smoothEdges({
      positions: pos,
      pathIndices: pos,
      edgeOffsets: make(val),
      centerIndex: 10,
      side: "right",
      radius: 3,
    });
    expect(out.every((o) => Math.abs(o.pathIndex - 10) < 3)).toBe(true);
  });

  it("値が既に揃っていれば何も返さない（なぞっただけで手修正済みにならない）", () => {
    const out = smoothEdges({
      positions: pos,
      pathIndices: pos,
      edgeOffsets: make(pos.map(() => 2)),
      centerIndex: 10,
      side: "right",
      radius: 5,
    });
    expect(out).toEqual([]);
  });

  it("中心線をまたがない", () => {
    const val = pos.map(() => 0.3);
    val[10] = 0.3;
    const out = smoothEdges({
      positions: pos,
      pathIndices: pos,
      edgeOffsets: pos.map((_, i) => ({ left: -0.3, right: i === 10 ? 0.3 : 0.3 })),
      centerIndex: 10,
      side: "right",
      radius: 5,
      strength: 1,
    });
    expect(out.every((o) => o.offset >= 0.25)).toBe(true);
  });

  it("なで続けると平坦化する（＝狭窄も均せてしまう。文言で警告している）", () => {
    let offsets = make([2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    for (let k = 0; k < 12; k++) {
      const out = smoothEdges({
        positions: pos,
        pathIndices: pos,
        edgeOffsets: offsets,
        centerIndex: 5,
        side: "right",
        radius: 5,
      });
      const byIndex = new Map(out.map((o) => [o.pathIndex, o.offset]));
      offsets = offsets.map((o, i) => (byIndex.has(i) ? { ...o, right: byIndex.get(i)! } : o));
    }
    // 谷（1）が中央値（2）へ吸われる。
    expect(offsets[5].right).toBeGreaterThan(1.8);
  });

  it("strength=0 なら何もしない", () => {
    const val = pos.map(() => 2);
    val[10] = 6;
    expect(
      smoothEdges({
        positions: pos,
        pathIndices: pos,
        edgeOffsets: make(val),
        centerIndex: 10,
        side: "right",
        radius: 5,
        strength: 0,
      }),
    ).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 外れ点が「塊」のとき（2026-08-28・実機で言われた）                     */
/* ------------------------------------------------------------------ */

describe("robustLocalLine", () => {
  const pos = Array.from({ length: 41 }, (_, i) => i);

  it("傾きのある並びに直線を当てる（中央値と違ってテーパーを潰さない）", () => {
    const val = pos.map((x) => 2 + 0.05 * x);
    expect(robustLocalLine(pos, val, 20, 12)).toBeCloseTo(2 + 0.05 * 20, 6);
  });

  it("🚨 隣り合う外れの塊があっても引っ張られない（除外を渡す）", () => {
    const val = pos.map(() => 2);
    for (let i = 18; i <= 23; i++) val[i] = 7; // 6 点まとめて外れ
    const excluded = new Set([18, 19, 20, 21, 22, 23]);
    expect(robustLocalLine(pos, val, 20, 12, excluded)).toBeCloseTo(2, 6);
  });

  it("窓の点が全部外れ扱いでも当てはめを諦めない（除外をやめて集め直す）", () => {
    const val = pos.map(() => 2);
    const excluded = new Set(pos);
    expect(Number.isFinite(robustLocalLine(pos, val, 20, 5, excluded))).toBe(true);
  });

  it("標本が足りなければ直線ではなく中央値へ落ちる（傾きが暴れない）", () => {
    expect(robustLocalLine([0, 1, 2], [2, 9, 2], 1, 1.5)).toBe(2);
  });
});

describe("smoothEdges — 外れ点が塊のとき", () => {
  const pos = Array.from({ length: 61 }, (_, i) => i);
  const make = (values: number[]) => values.map((v) => ({ left: -v, right: v }));

  it("🔴 隣り合う 6 点がまとめて外れていても、なでれば戻る（従来は動かなかった）", () => {
    // ブラシ半径 5 と同じ幅の窓だと、この塊は窓内の多数派になり中央値が外れ値になる。
    const val = pos.map(() => 2);
    for (let i = 28; i <= 33; i++) val[i] = 7;
    const out = smoothEdges({
      positions: pos,
      pathIndices: pos,
      edgeOffsets: make(val),
      centerIndex: 30,
      side: "right",
      radius: 5,
    });
    const byIndex = new Map(out.map((o) => [o.pathIndex, o.offset]));
    const moved = byIndex.get(30);
    expect(moved).toBeDefined();
    // 7 → 2 の向きへはっきり動く（1 回のなでで strength ぶん）。
    expect(moved!).toBeLessThan(5.5);
  });

  it("なでるほど塊が正しい値へ寄る（数回で実用になる）", () => {
    let offsets = make(pos.map((_, i) => (i >= 28 && i <= 33 ? 7 : 2)));
    for (let k = 0; k < 6; k++) {
      const out = smoothEdges({
        positions: pos,
        pathIndices: pos,
        edgeOffsets: offsets,
        centerIndex: 30,
        side: "right",
        radius: 5,
      });
      const byIndex = new Map(out.map((o) => [o.pathIndex, o.offset]));
      offsets = offsets.map((o, i) => (byIndex.has(i) ? { ...o, right: byIndex.get(i)! } : o));
    }
    expect(offsets[30].right).toBeLessThan(2.6);
  });

  it("🔴 テーパー（先細り）のある区間をならしても、傾きは残る", () => {
    // 近位 3.0mm → 遠位 1.8mm へ素直に細くなる並びに、1 点だけ飛びを入れる。
    const val = pos.map((x) => 3.0 - 0.02 * x);
    val[30] = 6;
    const out = smoothEdges({
      positions: pos,
      pathIndices: pos,
      edgeOffsets: make(val),
      centerIndex: 30,
      side: "right",
      radius: 6,
    });
    const byIndex = new Map(out.map((o) => [o.pathIndex, o.offset]));
    // 飛びは戻る
    expect(byIndex.get(30)!).toBeLessThan(5);
    // 近位側と遠位側は元の傾きのまま（定数へ均されていない）
    const near = byIndex.get(25) ?? val[25];
    const far = byIndex.get(35) ?? val[35];
    expect(near - far).toBeGreaterThan(0.15);
  });
});
