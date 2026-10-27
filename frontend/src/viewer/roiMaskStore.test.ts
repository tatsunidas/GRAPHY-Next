/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addMaskSegment,
  deleteRoiMaskMeta,
  setRoiMaskMeta,
  subscribeRoiMaskChanged,
  subscribeRoiMaskStore,
} from "./roiMaskStore";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  deleteRoiMaskMeta("a");
  deleteRoiMaskMeta("m");
});

describe("subscribeRoiMaskChanged（どの項目が変わったかを伝える購読）", () => {
  it("メタの更新・削除・セグメント追加で、項目 ID つきで呼ばれる", () => {
    const changed = vi.fn();
    cleanups.push(subscribeRoiMaskChanged(changed));
    setRoiMaskMeta("a", { label: "x" });
    addMaskSegment("m", 2);
    deleteRoiMaskMeta("a");
    expect(changed.mock.calls.map((c) => c[0])).toEqual(["a", "m", "a"]);
  });

  it("既存の購読は従来どおり引数なしで呼ばれる（項目 ID を渡さない）", () => {
    const legacy = vi.fn();
    cleanups.push(subscribeRoiMaskStore(legacy));
    setRoiMaskMeta("a", { label: "x" });
    expect(legacy).toHaveBeenCalledTimes(1);
    expect(legacy.mock.calls[0]).toEqual([]);
  });

  it("存在しない項目の削除では、どちらの購読も呼ばれない（負例）", () => {
    const changed = vi.fn();
    const legacy = vi.fn();
    cleanups.push(subscribeRoiMaskChanged(changed), subscribeRoiMaskStore(legacy));
    deleteRoiMaskMeta("no-such-item");
    expect(changed).not.toHaveBeenCalled();
    expect(legacy).not.toHaveBeenCalled();
  });

  it("解除後は呼ばれない", () => {
    const changed = vi.fn();
    const off = subscribeRoiMaskChanged(changed);
    off();
    setRoiMaskMeta("a", { label: "x" });
    expect(changed).not.toHaveBeenCalled();
  });

  it("購読者が投げても、他の購読者と更新は続く", () => {
    const ok = vi.fn();
    cleanups.push(subscribeRoiMaskChanged(() => { throw new Error("boom"); }), subscribeRoiMaskChanged(ok));
    expect(() => setRoiMaskMeta("a", { label: "x" })).not.toThrow();
    expect(ok).toHaveBeenCalledWith("a");
  });
});
