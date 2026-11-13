// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// ［ファイル］→「NIfTI で書き出し…」の DOM の煙テスト: 実際に描画し、メニューを開いて押す。
// 既定のまま（理由なし＝押せる／理由あり＝押せない）と、公開デモ（項目なし）を通す。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";

vi.mock("../plugins/pluginRegistry", () => ({ usePluginMenu: () => [] }));
vi.mock("../help/updateState", () => ({ useUpdateState: () => ({ phase: "idle" }) }));

import { MenuBar } from "./MenuBar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  localStorage.setItem("graphy.locale", "ja");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function render(niftiExport: { onClick: () => void; disabledReason: string | null } | undefined) {
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
          niftiExport,
        }),
      ),
    );
  });
}

async function openFileMenu() {
  const btn = [...host.querySelectorAll("button")].find((b) => b.textContent === "ファイル");
  await act(async () => {
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("NIfTI で書き出し…（メニューの煙テスト）", () => {
  it("押せる状態: 項目が出て、押すと 1 回だけ呼ばれる", async () => {
    const onClick = vi.fn();
    await render({ onClick, disabledReason: null });
    await openFileMenu();
    const item = q("menu-item-nifti-export")!;
    expect(item.textContent).toBe("NIfTI で書き出し…");
    expect(item.disabled).toBe(false);
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("負例: 理由があると押せず、理由が title に出る。押しても呼ばれない", async () => {
    const onClick = vi.fn();
    await render({ onClick, disabledReason: "シリーズを 1 本選んでください。" });
    await openFileMenu();
    const item = q("menu-item-nifti-export")!;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe("シリーズを 1 本選んでください。");
    await act(async () => {
      item.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("公開デモ（項目を渡さない）では項目が出ない。他の項目は残る", async () => {
    await render(undefined);
    await openFileMenu();
    expect(q("menu-item-nifti-export")).toBeNull();
    expect(q("menu-item-send")).not.toBeNull();
  });
});
