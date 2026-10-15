/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { partitionByLock } from "./roiLock";

describe("partitionByLock", () => {
  it("ロック中は残し、それ以外を消す候補にする（順序は保つ）", () => {
    const locked = new Set(["b", "d"]);
    expect(partitionByLock(["a", "b", "c", "d"], (u) => locked.has(u))).toEqual({
      removable: ["a", "c"],
      kept: ["b", "d"],
    });
  });

  it("空なら両方空", () => {
    expect(partitionByLock([], () => true)).toEqual({ removable: [], kept: [] });
  });
});
