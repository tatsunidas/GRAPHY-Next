// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 外部 AI クライアント（MCP）パネルの DOM の煙テスト: 実際に描画し、既定（すべてオフ）→ オン → キャンセル → 待ち受け失敗 → 他の窓、を通す。
// main（desktop/main.js の graphy:mcp-get / mcp-set）は偽物で渡す。形は main の実際の応答に合わせる:
// 成功 {ok:true,state}、確認の取り消し {ok:false,error:"cancelled",state}、待ち受け失敗 {ok:false,error:"listen-failed",state}、他の窓 get が null。
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpPrefs, McpState } from "../desktopBridge";
import { I18nProvider } from "../i18n/i18n";
import { McpPanel } from "./McpPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const win = window as unknown as { graphyDesktop?: unknown };

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const checked = (id: string) => (q(id) as HTMLInputElement).checked;

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
async function mount() {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(McpPanel)));
  });
  await flush();
}
async function click(id: string) {
  await act(async () => {
    q(id)!.click();
  });
  await flush();
}

/** main の mcp-get / mcp-set の偽物。confirm=false なら、オンにする変更で確認が取り消される。 */
function fakeMain(o: { listenFails?: boolean; confirm?: boolean; readError?: McpState["readError"]; relayCommand?: string; forbidden?: boolean } = {}) {
  let prefs: McpPrefs = { enabled: false, includePhi: false, allowAnalysis: false, allowViewerControl: false, allowViewerEdit: false };
  let listening = false;
  const sent: Partial<McpPrefs>[] = [];
  const state = (): McpState => ({ prefs, readError: o.readError ?? null, listening, ...(o.relayCommand ? { relayCommand: o.relayCommand } : {}) });
  win.graphyDesktop = {
    getMcp: () => Promise.resolve(o.forbidden ? null : state()),
    setMcp: (patch: Partial<McpPrefs>) => {
      sent.push(patch);
      const turningOn = Object.entries(patch).some(([k, v]) => v === true && !prefs[k as keyof McpPrefs]);
      if (turningOn && o.confirm === false) return Promise.resolve({ ok: false, error: "cancelled", state: state() });
      prefs = { ...prefs, ...patch };
      if (patch.enabled === true && o.listenFails) {
        prefs = { ...prefs, enabled: false };
        return Promise.resolve({ ok: false, error: "listen-failed", state: state() });
      }
      if (patch.enabled !== undefined) listening = patch.enabled;
      return Promise.resolve({ ok: true, state: state() });
    },
  };
  return { sent };
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete win.graphyDesktop;
});

describe("McpPanel（実際に描画して操作する）", () => {
  it("既定はすべてオフ。オンにすると main へ送り、待ち受けの表示が変わる。注意書きは常に出る", async () => {
    const { sent } = fakeMain();
    await mount();
    for (const k of ["enabled", "includePhi", "allowAnalysis", "allowViewerControl", "allowViewerEdit"]) expect(checked(`mcp-${k}`)).toBe(false);
    expect(q("mcp-status")!.dataset.listening).toBe("false");
    expect(q("mcp-privacy-notice")!.querySelectorAll("li").length).toBe(5);
    await click("mcp-enabled");
    expect(sent).toEqual([{ enabled: true }]);
    expect(checked("mcp-enabled")).toBe(true);
    expect(q("mcp-status")!.dataset.listening).toBe("true");
    await click("mcp-includePhi");
    expect(sent.at(-1)).toEqual({ includePhi: true });
    expect(checked("mcp-includePhi")).toBe(true);
    await click("mcp-allowViewerControl");
    expect(sent.at(-1)).toEqual({ allowViewerControl: true });
    expect(checked("mcp-allowViewerControl")).toBe(true);
    await click("mcp-allowViewerEdit");
    expect(sent.at(-1)).toEqual({ allowViewerEdit: true });
    expect(checked("mcp-allowViewerEdit")).toBe(true);
    expect(q("mcp-error")).toBeNull();
  });

  it("確認が取り消されたら、チェックは元のまま・エラーは出さない（負例）", async () => {
    fakeMain({ confirm: false });
    await mount();
    await click("mcp-includePhi");
    expect(checked("mcp-includePhi")).toBe(false);
    await click("mcp-allowViewerControl"); // 表示操作の許可も、確認が取り消されたらオフのまま
    expect(checked("mcp-allowViewerControl")).toBe(false);
    await click("mcp-allowViewerEdit"); // データを変える許可も、確認が取り消されたらオフのまま
    expect(checked("mcp-allowViewerEdit")).toBe(false);
    expect(q("mcp-error")).toBeNull();
  });

  it("待ち受けを開始できなかったら、オフのまま理由を出す", async () => {
    fakeMain({ listenFails: true });
    await mount();
    await click("mcp-enabled");
    expect(checked("mcp-enabled")).toBe(false);
    expect(q("mcp-error")!.dataset.code).toBe("listenFailed");
  });

  it("設定ファイルを読めなかったときの警告と、パッケージ版の中継コマンドの表示", async () => {
    fakeMain({ readError: "corrupt", relayCommand: "/opt/GRAPHY-Next/resources/cli/graphy-mcp" });
    await mount();
    expect(q("mcp-read-error")).not.toBeNull();
    expect((q("mcp-relay-command") as HTMLInputElement).value).toBe("/opt/GRAPHY-Next/resources/cli/graphy-mcp");
  });

  it("中継コマンドが無い（開発起動）なら欄を出さず、警告も出ない", async () => {
    fakeMain();
    await mount();
    expect(q("mcp-relay-command")).toBeNull();
    expect(q("mcp-read-error")).toBeNull();
  });

  it("橋が無い（web）なら説明だけ。メインの窓以外（get が null）ならメイン画面を案内し、操作欄は出さない", async () => {
    await mount();
    expect(q("mcp-desktop-only")).not.toBeNull();
    expect(q("mcp-enabled")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    fakeMain({ forbidden: true });
    await mount();
    expect(q("mcp-main-only")).not.toBeNull();
    expect(q("mcp-enabled")).toBeNull();
  });
});
