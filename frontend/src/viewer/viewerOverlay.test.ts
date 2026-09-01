/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ⚠️ vitest は `environment: "node"` なので DOM は無い。`closest` の**呼ばれ方**（どの選択子で
 * 探すか・戻り値をどう解釈するか）を偽物で固定する。入れ子そのものはブラウザの保証。
 */
import { describe, expect, it, vi } from "vitest";
import { isInsideViewerOverlay, VIEWER_OVERLAY_ATTR, viewerOverlayProps } from "./viewerOverlay";

/** `closest` を持つ偽の要素。`hit` が true なら器の中にいることにする。 */
function fakeElement(hit: boolean) {
  return { closest: vi.fn((_s: string) => (hit ? { tagName: "DIV" } : null)) };
}

describe("isInsideViewerOverlay", () => {
  it("器の中から来たイベントは true（ビューアは横取りしない）", () => {
    expect(isInsideViewerOverlay(fakeElement(true) as unknown as EventTarget)).toBe(true);
  });

  it("器の外（画像の上）は false（ここのホイールはフレーム送りでよい）", () => {
    expect(isInsideViewerOverlay(fakeElement(false) as unknown as EventTarget)).toBe(false);
  });

  it("探すのは器の目印だけ", () => {
    const el = fakeElement(true);
    isInsideViewerOverlay(el as unknown as EventTarget);
    expect(el.closest).toHaveBeenCalledWith(`[${VIEWER_OVERLAY_ATTR}]`);
  });

  it("`closest` を持たないものは false（落とさない）", () => {
    // 🚨 `instanceof Element` で書くと**別ウィンドウの要素が false になる**ので、
    //    持っているかどうかで見ている。その代わり非要素が来ても壊れないことを固定する。
    expect(isInsideViewerOverlay(null)).toBe(false);
    expect(isInsideViewerOverlay({} as EventTarget)).toBe(false);
    expect(isInsideViewerOverlay({ closest: "not a function" } as unknown as EventTarget)).toBe(
      false,
    );
  });

  it("目印は props を展開して付ける（属性名を直書きさせない）", () => {
    expect(viewerOverlayProps).toEqual({ [VIEWER_OVERLAY_ATTR]: "" });
  });
});
