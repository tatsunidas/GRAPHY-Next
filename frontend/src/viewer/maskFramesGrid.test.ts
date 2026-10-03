/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** H65: プラグインの格子（loadVolume）→ 表示中スタックの z の照合。 */
import { describe, expect, it } from "vitest";
import { mapGridToStack } from "./maskFrames";

type V3 = [number, number, number];
const stack: V3[] = [0, 1, 2, 3].map((k) => [10, 20, 100 + 5 * k] as V3);

describe("mapGridToStack", () => {
  it("maps the same order and the reversed order by IPP", () => {
    expect(mapGridToStack({ dims: [2, 2, 4], ipp: [10, 20, 100], sliceStep: [0, 0, 5] }, stack)).toEqual([0, 1, 2, 3]);
    expect(mapGridToStack({ dims: [2, 2, 4], ipp: [10, 20, 115], sliceStep: [0, 0, -5] }, stack)).toEqual([3, 2, 1, 0]);
  });

  it("refuses a grid that is off by more than 0.5 mm, too long, or maps two slices to one", () => {
    expect(mapGridToStack({ dims: [2, 2, 4], ipp: [10, 20, 101], sliceStep: [0, 0, 5] }, stack)).toBeNull();
    expect(mapGridToStack({ dims: [2, 2, 5], ipp: [10, 20, 100], sliceStep: [0, 0, 5] }, stack)).toBeNull();
    expect(mapGridToStack({ dims: [2, 2, 2], ipp: [10, 20, 100], sliceStep: [0, 0, 0.1] }, stack)).toBeNull();
  });

  it("skips stack slices without a position", () => {
    expect(mapGridToStack({ dims: [2, 2, 1], ipp: [10, 20, 105], sliceStep: [0, 0, 5] }, [undefined, stack[1]])).toEqual([1]);
  });
});
