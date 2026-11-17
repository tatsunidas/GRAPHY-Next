// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Window メニューの DOM の煙テスト: メイン画面の MenuBar を既定のまま開き、Window の 4 項目が出て、
// 押すと desktop の windowControl に action が渡り、窓の状態に応じて項目の有効・無効が変わる。
// web（desktop ブリッジ無し）ではメニュー自体が出ない。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { MenuBar } from "../mainscreen/MenuBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
  });
};

/** 窓の状態遷移だけを真似る desktop ブリッジ（main の windowControl.apply と同じ結果を返す）。 */
function installFakeDesktop() {
  const s = { maximized: false, fullscreen: false, minimized: false };
  const calls: string[] = [];
  (window as unknown as { graphyDesktop: unknown }).graphyDesktop = {
    windowState: async () => ({ ok: true, ...s }),
    windowControl: async (action: string) => {
      calls.push(action);
      if (action === "fullscreen") s.fullscreen = !s.fullscreen;
      if (action === "maximize") { s.fullscreen = false; s.maximized = true; }
      if (action === "minimize") s.minimized = true;
      if (action === "restore") { s.fullscreen = false; s.maximized = false; s.minimized = false; }
      return { ok: true, ...s };
    },
  };
  return calls;
}

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
  // MenuBar が起動時にプラグイン一覧を取りに行く。ここでは空で返す（jsdom には相対 URL の基準が無い）
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

describe("Window メニュー（メイン画面）", () => {
  it("既定のまま開く: 4 項目が出て、通常の大きさでは「元に戻す」だけ無効", async () => {
    installFakeDesktop();
    await mount();
    await click(q("mainscreen-menu-window")!);
    expect(q("menu-item-window-fullscreen")!.disabled).toBe(false);
    expect(q("menu-item-window-maximize")!.disabled).toBe(false);
    expect(q("menu-item-window-minimize")!.disabled).toBe(false);
    expect(q("menu-item-window-restore")!.disabled).toBe(true);
  });

  it("フルスクリーン → 元に戻す: action が順に渡り、状態に追従して有効・無効が入れ替わる", async () => {
    const calls = installFakeDesktop();
    await mount();
    await click(q("mainscreen-menu-window")!);
    await click(q("menu-item-window-fullscreen")!);
    expect(calls).toEqual(["fullscreen"]);
    await click(q("mainscreen-menu-window")!);
    expect(q("menu-item-window-fullscreen")!.disabled).toBe(true);
    expect(q("menu-item-window-restore")!.disabled).toBe(false);
    await click(q("menu-item-window-restore")!);
    expect(calls).toEqual(["fullscreen", "restore"]);
    await click(q("mainscreen-menu-window")!);
    expect(q("menu-item-window-restore")!.disabled).toBe(true);
  });

  it("無効の項目を押しても action は渡らない（負例）", async () => {
    const calls = installFakeDesktop();
    await mount();
    await click(q("mainscreen-menu-window")!);
    await click(q("menu-item-window-restore")!);
    expect(calls).toEqual([]);
  });

  it("web（desktop ブリッジ無し）では Window メニューが出ない", async () => {
    await mount();
    expect(q("mainscreen-menu-window")).toBeNull();
    expect(q("mainscreen-menu-file")).not.toBeNull(); // メニューバー自体は出ている（検査が空振りしていない）
  });
});
