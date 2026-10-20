/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { selectInRange } from "./thresholdLogic";
import { makeValueReader } from "./wandFlood";

const px = [-1000, -100, 40, 50, 60, 70, 71, 200];
const read = (i: number) => px[i];

describe("selectInRange", () => {
  it("両端を含んで範囲内だけを昇順で選ぶ", () => {
    expect(selectInRange(read, px.length, 40, 70)).toEqual([2, 3, 4, 5]);
  });
  it("範囲外（空気・脂肪・高値）は選ばない", () => {
    const got = selectInRange(read, px.length, 40, 70);
    for (const i of [0, 1, 6, 7]) expect(got).not.toContain(i);
  });
  it("下限 > 上限は何も選ばない（全域を塗らない）", () => {
    expect(selectInRange(read, px.length, 70, 40)).toEqual([]);
  });
  it("NaN の境界は何も選ばない", () => {
    expect(selectInRange(read, px.length, NaN, 70)).toEqual([]);
    expect(selectInRange(read, px.length, 40, NaN)).toEqual([]);
  });
  it("下限 = 上限は、その値だけを選ぶ", () => {
    expect(selectInRange(read, px.length, 60, 60)).toEqual([4]);
  });
  it("校正値で判定する（保存値 slope 2・intercept -1024 で 50 HU は保存値 537）", () => {
    const stored = [462, 537, 542]; // -100 / 50 / 60 HU
    const cal = makeValueReader(stored, 1, 2, -1024);
    expect(selectInRange(cal, stored.length, 40, 70)).toEqual([1, 2]);
    // 保存値のまま読むと 40〜70 には誰も入らない（校正を掛け忘れた場合の対照）
    expect(selectInRange((i) => stored[i], stored.length, 40, 70)).toEqual([]);
  });
});
