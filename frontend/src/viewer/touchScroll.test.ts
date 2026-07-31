/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { advanceAnchor, sliceStepsFromDrag, SLICE_STEP_PX } from "./touchScroll";

describe("sliceStepsFromDrag", () => {
  it("下へなぞると正（次のスライス）＝ホイールと同じ向き", () => {
    expect(sliceStepsFromDrag(SLICE_STEP_PX)).toBe(1);
    expect(sliceStepsFromDrag(SLICE_STEP_PX * 3)).toBe(3);
  });

  it("上へなぞると負（前のスライス）", () => {
    expect(sliceStepsFromDrag(-SLICE_STEP_PX)).toBe(-1);
    expect(sliceStepsFromDrag(-SLICE_STEP_PX * 2)).toBe(-2);
  });

  it("しきい値未満は 0（指の微動でスライスが動かない）", () => {
    expect(sliceStepsFromDrag(0)).toBe(0);
    expect(sliceStepsFromDrag(SLICE_STEP_PX - 1)).toBe(0);
    expect(sliceStepsFromDrag(-(SLICE_STEP_PX - 1))).toBe(0);
  });

  it("🚨 負方向の端数は 0 に向かって丸める（floor だと上向きの揺れで -1 が出る）", () => {
    expect(sliceStepsFromDrag(-1)).toBe(0);
    expect(sliceStepsFromDrag(-(SLICE_STEP_PX + 1))).toBe(-1);
  });

  it("不正な入力では動かさない", () => {
    expect(sliceStepsFromDrag(NaN)).toBe(0);
    expect(sliceStepsFromDrag(Infinity)).toBe(0);
    expect(sliceStepsFromDrag(100, 0)).toBe(0);
    expect(sliceStepsFromDrag(100, -1)).toBe(0);
  });
});

describe("advanceAnchor", () => {
  it("送った分だけ起点を進める", () => {
    expect(advanceAnchor(100, 2)).toBe(100 + 2 * SLICE_STEP_PX);
    expect(advanceAnchor(100, -1)).toBe(100 - SLICE_STEP_PX);
  });

  it("端数を残すので、連続してなぞると一定間隔で送られる", () => {
    // 1px ずつ 3 スライスぶんなぞる。端数を捨てる実装だと途中で送りが止まる。
    let anchor = 0;
    let total = 0;
    for (let y = 1; y <= SLICE_STEP_PX * 3; y++) {
      const steps = sliceStepsFromDrag(y - anchor);
      if (steps === 0) continue;
      total += steps;
      anchor = advanceAnchor(anchor, steps);
    }
    expect(total).toBe(3);
  });
});
