/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { alignToStack, boolOn, combineLabelSlices, scopeZFromForeground, withTemp } from "./maskScope";
import { isSegmentForeground } from "./maskStatsCore";

describe("scopeZFromForeground", () => {
  it("前景が無ければ null（メタを変えない）", () => {
    expect(scopeZFromForeground([])).toBeNull();
  });
  it("1 スライスだけならその番号（同じ番号が重なっても 1 枚）", () => {
    expect(scopeZFromForeground([7])).toBe(7);
    expect(scopeZFromForeground([7, 7])).toBe(7);
  });
  it("2 スライス以上なら all", () => {
    expect(scopeZFromForeground([3, 4])).toBe("all");
  });
});

describe("alignToStack", () => {
  const stack = ["a", "b", "c", "d", "e"];
  it("シリーズ全体の大きさのマスクはそのまま当たる", () => {
    expect([...(alignToStack(stack, stack) as Int32Array)]).toEqual([0, 1, 2, 3, 4]);
  });
  it("1 枚だけのマスクは、その 1 枚の位置にだけ当たる", () => {
    expect([...(alignToStack(stack, ["d"]) as Int32Array)]).toEqual([-1, -1, -1, 0, -1]);
  });
  it("スタックに無いスライスを含むマスクは当てはめられない", () => {
    expect(alignToStack(stack, ["x"])).toBeNull();
  });
});

describe("1 枚だけのマスク 3 つを OR すると、元の 3 スライスに戻る", () => {
  // ⬚ で分けた形を、演算と同じ手順（当てはめ → スライスごとに boolOn）で合成する。
  const W = 3;
  const stack = ["s0", "s1", "s2", "s3"];
  const original: number[][] = [
    [0, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [1, 0, 1],
  ];
  const split = [1, 2, 3].map((z) => ({ sourceIds: [stack[z]], slices: [original[z]] }));
  const combine = (op: "or" | "and" | "xor", masks: { sourceIds: string[]; slices: number[][] }[]) => {
    const aligned = masks.map((m) => alignToStack(stack, m.sourceIds) as Int32Array);
    return stack.map((_, s) => {
      const out = new Array(W).fill(0);
      for (let i = 0; i < W; i++) {
        let cnt = 0;
        masks.forEach((m, k) => {
          const j = aligned[k][s];
          if (j >= 0 && m.slices[j][i] > 0) cnt++;
        });
        out[i] = boolOn(op, cnt, masks.length) ? 1 : 0;
      }
      return out;
    });
  };
  it("OR で元どおり", () => {
    expect(combine("or", split)).toEqual(original);
  });
  it("AND は、どのスライスにも全部がそろう画素が無いので空", () => {
    expect(combine("and", split).flat().every((v) => v === 0)).toBe(true);
  });
  it("XOR は重なりが無いので OR と同じ", () => {
    expect(combine("xor", split)).toEqual(original);
  });
});

describe("isSegmentForeground / combineLabelSlices", () => {
  it("前景: segment 指定ならその値だけ、無ければ 0 より大きいすべて", () => {
    expect(isSegmentForeground(2, 2)).toBe(true);
    expect(isSegmentForeground(1, 2)).toBe(false);
    expect(isSegmentForeground(0, 2)).toBe(false);
    expect(isSegmentForeground(3)).toBe(true);
    expect(isSegmentForeground(0)).toBe(false);
  });

  it("segment 指定の入力は、同じマスクの別 segment を前景に数えない", () => {
    const a = { labels: [1, 2, 2, 0], segIndex: 2 };
    const b = { labels: [2, 2, 1, 1] }; // マスク全体（非ゼロ）
    expect(Array.from(combineLabelSlices("and", [a, b], 4))).toEqual([0, 1, 1, 0]);
    expect(Array.from(combineLabelSlices("or", [a, b], 4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(combineLabelSlices("xor", [a, b], 4))).toEqual([1, 0, 0, 1]);
  });

  it("labels が null（そのスライスは背景）や短い配列は背景として数える", () => {
    expect(Array.from(combineLabelSlices("or", [{ labels: null }, { labels: [1, 1] }], 3))).toEqual([1, 1, 0]);
    expect(Array.from(combineLabelSlices("and", [{ labels: null }, { labels: [1, 1, 1] }], 3))).toEqual([0, 0, 0]);
  });
});

describe("withTemp", () => {
  it("成功でも失敗でも一時のものを片付ける。作れなければ fn を呼ばず null", async () => {
    const disposed: string[] = [];
    const dispose = (id: string) => disposed.push(id);
    expect(await withTemp(async () => "t1", dispose, (id) => `done:${id}`)).toBe("done:t1");
    await expect(withTemp(async () => "t2", dispose, () => { throw new Error("x"); })).rejects.toThrow("x");
    let called = false;
    expect(await withTemp(async () => null, dispose, () => { called = true; })).toBeNull();
    expect(called).toBe(false);
    expect(disposed).toEqual(["t1", "t2"]);
  });
});
