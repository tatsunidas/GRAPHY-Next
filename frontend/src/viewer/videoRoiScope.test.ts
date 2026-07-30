/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import {
  GLOBAL_SCOPE,
  applyScopeToReference,
  assignScope,
  frameScope,
  isVisibleOnFrame,
  pruneScopes,
  sameScope,
  scopeCounts,
  scopeOf,
  toggleScope,
  visibleUids,
  type RoiScopeMap,
} from "./videoRoiScope";

describe("scopeOf / frameScope", () => {
  it("未登録の uid はグローバル扱い", () => {
    expect(scopeOf({}, "a")).toEqual({ kind: "global" });
  });

  it("frameScope は 1-based に丸める", () => {
    expect(frameScope(3)).toEqual({ kind: "frame", frame: 3 });
    expect(frameScope(3.4)).toEqual({ kind: "frame", frame: 3 });
    expect(frameScope(0)).toEqual({ kind: "frame", frame: 1 });
    expect(frameScope(-5)).toEqual({ kind: "frame", frame: 1 });
  });
});

describe("isVisibleOnFrame", () => {
  it("グローバルは全フレームで表示", () => {
    expect(isVisibleOnFrame(GLOBAL_SCOPE, 1)).toBe(true);
    expect(isVisibleOnFrame(GLOBAL_SCOPE, 999)).toBe(true);
  });

  it("フレーム指定は紐づいたフレームでのみ表示", () => {
    expect(isVisibleOnFrame(frameScope(5), 5)).toBe(true);
    expect(isVisibleOnFrame(frameScope(5), 4)).toBe(false);
    expect(isVisibleOnFrame(frameScope(5), 6)).toBe(false);
  });
});

describe("sameScope", () => {
  it("種別とフレーム番号で比較する", () => {
    expect(sameScope(GLOBAL_SCOPE, { kind: "global" })).toBe(true);
    expect(sameScope(frameScope(2), frameScope(2))).toBe(true);
    expect(sameScope(frameScope(2), frameScope(3))).toBe(false);
    expect(sameScope(GLOBAL_SCOPE, frameScope(2))).toBe(false);
  });
});

describe("assignScope", () => {
  it("フレーム指定を割り当てる", () => {
    expect(assignScope({}, "a", frameScope(7))).toEqual({ a: { kind: "frame", frame: 7 } });
  });

  it("グローバルはキーを持たない表現に正規化する", () => {
    const m: RoiScopeMap = { a: frameScope(7) };
    expect(assignScope(m, "a", GLOBAL_SCOPE)).toEqual({});
  });

  it("無変化なら同一参照を返す（React 再描画の連鎖防止）", () => {
    const empty: RoiScopeMap = {};
    // 未登録 uid にグローバルを割り当て＝既定と同じなので変化なし。
    expect(assignScope(empty, "a", GLOBAL_SCOPE)).toBe(empty);
    const m: RoiScopeMap = { a: frameScope(7) };
    expect(assignScope(m, "a", frameScope(7))).toBe(m);
  });

  it("他の uid のエントリは壊さない", () => {
    const m: RoiScopeMap = { a: frameScope(1), b: frameScope(2) };
    expect(assignScope(m, "a", GLOBAL_SCOPE)).toEqual({ b: { kind: "frame", frame: 2 } });
  });
});

describe("toggleScope", () => {
  it("グローバル → 現在フレームに固定", () => {
    expect(toggleScope({}, "a", 12)).toEqual({ a: { kind: "frame", frame: 12 } });
  });

  it("フレーム指定 → グローバル", () => {
    expect(toggleScope({ a: frameScope(12) }, "a", 12)).toEqual({});
  });

  it("別フレームに紐づいていても、まずグローバルへ戻す", () => {
    // 「見えていない ROI が現在フレームへ勝手に移動する」挙動を避ける。
    expect(toggleScope({ a: frameScope(3) }, "a", 12)).toEqual({});
  });
});

describe("pruneScopes", () => {
  it("消えた ROI のエントリを落とす", () => {
    const m: RoiScopeMap = { a: frameScope(1), b: frameScope(2) };
    expect(pruneScopes(m, ["b"])).toEqual({ b: { kind: "frame", frame: 2 } });
  });

  it("全て生存していれば同一参照", () => {
    const m: RoiScopeMap = { a: frameScope(1) };
    expect(pruneScopes(m, ["a", "b"])).toBe(m);
    const empty: RoiScopeMap = {};
    expect(pruneScopes(empty, [])).toBe(empty);
  });
});

describe("visibleUids", () => {
  const map: RoiScopeMap = { b: frameScope(3), c: frameScope(5) };

  it("グローバルと当該フレームのものだけ、順序を保って返す", () => {
    expect(visibleUids(map, ["a", "b", "c"], 3)).toEqual(["a", "b"]);
    expect(visibleUids(map, ["a", "b", "c"], 5)).toEqual(["a", "c"]);
    expect(visibleUids(map, ["a", "b", "c"], 9)).toEqual(["a"]);
  });
});

describe("scopeCounts", () => {
  it("グローバル / このフレーム / 他フレーム を数える", () => {
    const map: RoiScopeMap = { b: frameScope(3), c: frameScope(5), d: frameScope(3) };
    expect(scopeCounts(map, ["a", "b", "c", "d"], 3)).toEqual({
      global: 1,
      thisFrame: 2,
      otherFrame: 1,
    });
  });

  it("空なら全て 0", () => {
    expect(scopeCounts({}, [], 1)).toEqual({ global: 0, thisFrame: 0, otherFrame: 0 });
  });
});

describe("applyScopeToReference", () => {
  // ここが表示フィルタの実体。VideoViewport.isReferenceViewable() は sliceIndex があればそのフレームのみ、
  // 無ければ全フレームで可視と判定する（＝グローバルは sliceIndex を消す必要がある）。
  it("グローバルは sliceIndex と範囲参照を落とす（全フレームで可視になる）", () => {
    const ref = { sliceIndex: 4, multiSliceReference: { sliceIndex: 9 } };
    expect(applyScopeToReference(ref, GLOBAL_SCOPE)).toBe(true);
    expect("sliceIndex" in ref).toBe(false);
    expect("multiSliceReference" in ref).toBe(false);
  });

  it("フレーム指定は 1-based frame を 0-based sliceIndex に落とす", () => {
    const ref: { sliceIndex?: number } = {};
    expect(applyScopeToReference(ref, frameScope(5))).toBe(true);
    expect(ref.sliceIndex).toBe(4);
  });

  it("フレーム 1 以下は sliceIndex 0 に丸める", () => {
    const ref: { sliceIndex?: number } = { sliceIndex: 7 };
    applyScopeToReference(ref, frameScope(1));
    expect(ref.sliceIndex).toBe(0);
  });

  it("既に一致していれば変更なしを返す（無駄な再描画を避ける）", () => {
    expect(applyScopeToReference({ sliceIndex: 4 }, frameScope(5))).toBe(false);
    expect(applyScopeToReference({}, GLOBAL_SCOPE)).toBe(false);
  });
});
