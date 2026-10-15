/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { alignToStack, boolOn, scopeZFromForeground } from "./maskScope";

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
