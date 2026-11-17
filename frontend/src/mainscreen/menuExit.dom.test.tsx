// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// File ＞ 終了の DOM の煙テスト: メイン画面の MenuBar を既定のまま開き、「終了」を押すと desktop の requestQuit が呼ばれる。
// web（desktop ブリッジ無し）では項目が出ない。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { MenuBar } from "./MenuBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};

async function mount() {
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(MenuBar, {
          isStandalone: true,
          canImport: true,
          isDemo: false,
          selectedStudyUid: null,
          onImport: () => {},
          onOpenTool: () => {},
          onOpenViewer: () => {},
          onOpenSettings: () => {},
          onOpenDb: () => {},
          onOpenHelp: () => {},
        }),
      ),
    );
  });
}

beforeEach(() => {
  localStorage.setItem("graphy.locale", "ja");
  vi.stubGlobal("fetch", async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete (window as unknown as { graphyDesktop?: unknown }).graphyDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("File ＞ 終了（メイン画面）", () => {
  it("既定のまま開く: File の末尾に「終了」があり、押すと requestQuit が 1 回呼ばれる", async () => {
    const requestQuit = vi.fn(async () => ({ ok: true }));
    (window as unknown as { graphyDesktop: unknown }).graphyDesktop = { requestQuit };
    await mount();
    await click(q("mainscreen-menu-file")!);
    const items = Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="mainscreen-menu-file"] ~ div button'));
    expect(items.at(-1)!.textContent).toBe("終了"); // File の最後の項目
    await click(q("menu-item-exit")!);
    expect(requestQuit).toHaveBeenCalledTimes(1);
  });

  it("web（desktop ブリッジ無し）では「終了」が出ない", async () => {
    await mount();
    await click(q("mainscreen-menu-file")!);
    expect(q("menu-item-exit")).toBeNull();
    expect(q("menu-item-send")).not.toBeNull(); // File メニュー自体は開いている（検査が空振りしていない）
  });

  it("requestQuit が無い古い preload でも、押して落ちない", async () => {
    (window as unknown as { graphyDesktop: unknown }).graphyDesktop = {};
    await mount();
    await click(q("mainscreen-menu-file")!);
    await expect(click(q("menu-item-exit")!)).resolves.toBeUndefined();
  });
});
