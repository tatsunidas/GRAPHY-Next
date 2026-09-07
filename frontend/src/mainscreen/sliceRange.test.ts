/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { formatSliceRange, parseSliceRange } from "./sliceRange";

describe("スライス範囲のパース", () => {
  it("単独と範囲を混ぜて読める", () => {
    expect(parseSliceRange("1-5, 8, 10").indices).toEqual([0, 1, 2, 3, 4, 7, 9]);
  });

  it("🔴 入力は 1 origin、返すのは 0 origin", () => {
    // 利用者が見ているスライス番号は 1 始まりだが、DICOM のフレーム index と
    // backend の frames は 0 始まり。ここを取り違えると 1 枚ずれたスライスを塗る。
    expect(parseSliceRange("1").indices).toEqual([0]);
    expect(parseSliceRange("3").indices).toEqual([2]);
  });

  it("重複は畳み、昇順で返す", () => {
    expect(parseSliceRange("5, 1, 3, 5, 1").indices).toEqual([0, 2, 4]);
  });

  it("空白の揺れを許す", () => {
    expect(parseSliceRange("  1 - 3 ,  7  ").indices).toEqual([0, 1, 2, 6]);
  });

  it("逆順の範囲も受ける（打ち間違いで黙って 0 件にしない）", () => {
    expect(parseSliceRange("5-3").indices).toEqual([2, 3, 4]);
  });

  it("読めなかった断片を返す", () => {
    const r = parseSliceRange("1, abc, 3-x, 5");
    expect(r.indices).toEqual([0, 4]);
    expect(r.invalid).toEqual(["abc", "3-x"]);
  });

  it("0 と負数は不正（1 origin なので）", () => {
    const r = parseSliceRange("0, -1, 2");
    expect(r.indices).toEqual([1]);
    expect(r.invalid).toContain("0");
  });

  it("上限を超える指定は捨てる", () => {
    expect(parseSliceRange("1-10", 4).indices).toEqual([0, 1, 2, 3]);
    expect(parseSliceRange("99", 4).invalid).toEqual(["99"]);
  });

  it("空文字は空", () => {
    expect(parseSliceRange("").indices).toEqual([]);
    expect(parseSliceRange("   ").indices).toEqual([]);
  });
});

describe("スライス範囲の表示", () => {
  it("連続は範囲に畳む", () => {
    expect(formatSliceRange([0, 1, 2, 3, 4, 7, 9])).toBe("1-5, 8, 10");
  });

  it("1 つだけなら単独で出す", () => {
    expect(formatSliceRange([2])).toBe("3");
  });

  it("空なら空文字", () => {
    expect(formatSliceRange([])).toBe("");
  });

  it("パースと往復できる", () => {
    const s = "1-5, 8, 10";
    expect(formatSliceRange(parseSliceRange(s).indices)).toBe(s);
  });
});
