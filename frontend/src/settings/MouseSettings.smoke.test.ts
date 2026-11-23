// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 設定画面の「マウスボタン」を実際に開く DOM の煙テスト: 既定のまま表示 → 右を W/L に変える → 保存と実行中の割り当てに届く。
// settingsApi は偽物。fetchSettings の形は実際の API（キー→文字列の Record）に合わせる。
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saved: Record<string, string>[] = [];
vi.mock("./settingsApi", () => ({
  fetchSettings: vi.fn(() => Promise.resolve({} as Record<string, string>)),
  saveSettings: vi.fn((u: Record<string, string>) => {
    saved.push(u);
    return Promise.resolve(u);
  }),
}));

import { I18nProvider } from "../i18n/i18n";
import { getMouseBindings, setMouseBindings, DEFAULT_MOUSE_BINDINGS } from "../viewer/mouseBindings";
import { SettingsDialog } from "./SettingsDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLSelectElement>(`[data-testid="${id}"]`);
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  saved.length = 0;
  setMouseBindings({ ...DEFAULT_MOUSE_BINDINGS });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("設定 > マウスボタン", () => {
  it("既定のまま開くと 中=パン・右=ズーム。右を W/L に変えると保存され、実行中の割り当てが変わる", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(SettingsDialog, { open: true, onClose: () => {}, initialCategoryId: "viewer" })));
    });
    await flush();
    expect(q("settings-field-mouse.middle")!.value).toBe("pan");
    expect(q("settings-field-mouse.right")!.value).toBe("zoom");
    expect(q("settings-field-mouse.back")!.value).toBe("none");
    expect(q("settings-field-mouse.forward")!.value).toBe("none");
    expect(saved).toHaveLength(0); // 開いただけでは何も保存しない

    const sel = q("settings-field-mouse.right")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(sel, "windowLevel");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(saved).toEqual([{ "mouse.middle": "pan", "mouse.right": "windowLevel", "mouse.back": "none", "mouse.forward": "none" }]);
    expect(getMouseBindings()).toEqual({ middle: "pan", right: "windowLevel", back: "none", forward: "none" });
    expect(q("settings-field-mouse.right")!.value).toBe("windowLevel");

    // 戻るボタンを割り当てる
    const back = q("settings-field-mouse.back")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(back, "pan");
      back.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(getMouseBindings().back).toBe("pan");
    expect(saved[saved.length - 1]["mouse.back"]).toBe("pan");
    expect(q("settings-field-mouse.back")!.value).toBe("pan");

    // 進むボタンに操作（クリック）を割り当てる
    const fwd = q("settings-field-mouse.forward")!;
    expect(Array.from(fwd.options).map((o) => o.value)).toContain("cmd:reset");
    expect(Array.from(q("settings-field-mouse.right")!.options).map((o) => o.value)).not.toContain("cmd:reset"); // 右はドラッグなので操作は出ない
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(fwd, "cmd:reset");
      fwd.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flush();
    expect(getMouseBindings().forward).toBe("cmd:reset");
    expect(saved[saved.length - 1]["mouse.forward"]).toBe("cmd:reset");
  });
});
