/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import vtkDataArray from "@kitware/vtk.js/Common/Core/DataArray";
import { prepareScalarsForRender, scalarsOf, type ScalarsLike } from "./scalarRange";

const arr = (values: Float32Array | Uint16Array) =>
  vtkDataArray.newInstance({ numberOfComponents: 1, values, dataType: values.constructor.name });
type Arr = ReturnType<typeof arr>;
/** dataChange の呼び出しを数える（vtk のメソッドは差し替えられないので包む）。 */
const counted = (s: Arr) => {
  const c = { calls: 0 };
  const scalars: ScalarsLike = {
    getData: () => s.getData() as Float32Array,
    getRanges: (x?: boolean) => s.getRanges(x ?? true),
    dataChange: () => { c.calls++; s.dataChange(); },
  };
  return { c, scalars };
};
const setData = (s: Arr, v: number[]) => { (s.getData() as Float32Array).set(v); s.modified(); }; // cornerstone が呼ぶのはここまで

describe("prepareScalarsForRender（値なし NaN を含む float の画像が真っ黒になる問題）", () => {
  it("【再現】修正なし: NaN だけで値域を覚えた配列に実値を入れても、値域は壊れたまま（最小 > 最大）", () => {
    const s = arr(new Float32Array(4).fill(NaN));
    expect(Array.from(s.getRange())).toEqual([Number.MAX_VALUE, -Number.MAX_VALUE]);
    setData(s, [NaN, 3.5, 8.9, NaN]);
    const r = s.getRange();
    expect(r[0] > r[1]).toBe(true);
  });

  it("修正後: NaN を有限の最小値に置き換え、値域を数え直す", () => {
    const s = arr(new Float32Array(4).fill(NaN));
    s.getRange();
    setData(s, [NaN, 3.5, 8.9, NaN]);
    expect(prepareScalarsForRender(s as unknown as ScalarsLike)).toBe(true);
    expect(Array.from(s.getData() as Float32Array)).toEqual([3.5, 3.5, Math.fround(8.9), 3.5]);
    const [lo, hi] = s.getRange();
    expect(lo).toBe(3.5);
    expect(hi).toBeCloseTo(8.9, 5);
  });

  it("全部 NaN のスライスは 0 で埋める", () => {
    const s = arr(new Float32Array(3).fill(NaN));
    expect(prepareScalarsForRender(s as unknown as ScalarsLike)).toBe(true);
    expect(Array.from(s.getData() as Float32Array)).toEqual([0, 0, 0]);
  });

  it("NaN が無く値域も正常な配列には触らない（dataChange を呼ばない）", () => {
    const s = arr(Float32Array.from([1, 5, 3, 2]));
    s.getRange();
    const { c, scalars } = counted(s);
    expect(prepareScalarsForRender(scalars)).toBe(false);
    expect(c.calls).toBe(0);
    expect(Array.from(s.getData() as Float32Array)).toEqual([1, 5, 3, 2]);
  });

  it("NaN は無いが、値域の記憶だけ壊れている配列は、記憶を捨てる", () => {
    const s = arr(new Float32Array(3).fill(NaN));
    s.getRange(); // 壊れた値域を覚える
    setData(s, [1, 2, 3]);
    expect(prepareScalarsForRender(s as unknown as ScalarsLike)).toBe(true);
    expect(Array.from(s.getRange())).toEqual([1, 3]);
  });

  it("整数の配列は NaN の検査をしない（触らない）", () => {
    const s = arr(Uint16Array.from([0, 65535, 3]));
    s.getRange();
    const { c, scalars } = counted(s);
    expect(prepareScalarsForRender(scalars)).toBe(false);
    expect(c.calls).toBe(0);
  });

  it("null・取り出せないビューポートは何もしない", () => {
    expect(prepareScalarsForRender(null)).toBe(false);
    expect(scalarsOf(null)).toBeNull();
    expect(scalarsOf({ getImageData: () => { throw new Error("x"); } })).toBeNull();
    const s = arr(Float32Array.from([1, 2]));
    expect(scalarsOf({ getImageData: () => ({ imageData: { getPointData: () => ({ getScalars: () => s }) } }) })).toBe(s);
  });
});
