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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
function fakeMain(o: { listenFails?: boolean; confirm?: boolean; readError?: McpState["readError"]; relayCommand?: string; forbidden?: boolean; knownPlugins?: string[] } = {}) {
  let prefs: McpPrefs = { enabled: false, includePhi: false, allowAnalysis: false, allowViewerControl: false, allowViewerEdit: false, allowViewerCapture: false, allowDbTransfer: false, pluginTools: [] };
  let listening = false;
  const sent: Partial<McpPrefs>[] = [];
  const state = (): McpState => ({ prefs, readError: o.readError ?? null, listening, ...(o.relayCommand ? { relayCommand: o.relayCommand } : {}) });
  win.graphyDesktop = {
    getMcp: () => Promise.resolve(o.forbidden ? null : state()),
    setMcp: (patch: Partial<McpPrefs>) => {
      sent.push(patch);
      const turningOn = Object.entries(patch).some(([k, v]) => v === true && !prefs[k as keyof McpPrefs]);
      const added = (patch.pluginTools ?? []).filter((id) => !prefs.pluginTools.includes(id));
      if (added.length && o.knownPlugins && added.some((id) => !o.knownPlugins!.includes(id))) return Promise.resolve({ ok: false, error: "unknown-plugin", state: state() });
      if ((turningOn || added.length) && o.confirm === false) return Promise.resolve({ ok: false, error: "cancelled", state: state() });
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
  vi.unstubAllGlobals();
});

describe("McpPanel（実際に描画して操作する）", () => {
  it("既定はすべてオフ。オンにすると main へ送り、待ち受けの表示が変わる。注意書きは常に出る", async () => {
    const { sent } = fakeMain();
    await mount();
    for (const k of ["enabled", "includePhi", "allowAnalysis", "allowViewerControl", "allowViewerEdit", "allowViewerCapture"]) expect(checked(`mcp-${k}`)).toBe(false);
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
    await click("mcp-allowViewerCapture");
    expect(sent.at(-1)).toEqual({ allowViewerCapture: true });
    expect(checked("mcp-allowViewerCapture")).toBe(true);
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
    await click("mcp-allowViewerCapture"); // 画像を返す許可も、確認が取り消されたらオフのまま
    expect(checked("mcp-allowViewerCapture")).toBe(false);
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

// ---- 公開するプラグイン（pluginTools）----
const MANIFESTS = [
  { id: "ai-tools-demo", name: "AI ツールのデモ", permissions: ["ai-tools"], aiTools: [{ name: "echo_size", effect: "read" }, { name: "make_roi", effect: "write" }] },
  { id: "vis-monai", name: "MONAI", permissions: ["ai-tools", "remote-compute"], aiTools: [{ name: "segment_models", effect: "read" }, { name: "segment_run", effect: "write" }] },
  { id: "no-tools", name: "ツールなし", permissions: ["ai-tools"], aiTools: [] },
  { id: "noperm", name: "権限なし", permissions: [], aiTools: [{ name: "x", effect: "read" }] },
];
const stubPlugins = (list: unknown) => vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(list), { status: 200, headers: { "content-type": "application/json" } }))));

describe("McpPanel: 公開するプラグイン", () => {
  it("AI ツールを宣言したプラグインだけが並ぶ（ツールなし・権限なしは出ない）。ツールの効果と、外部の計算機へ送る機能が分かる。チェックで pluginTools が送られる", async () => {
    stubPlugins(MANIFESTS);
    const { sent } = fakeMain();
    await mount();
    expect(q("mcp-plugin-ai-tools-demo")).not.toBeNull();
    expect(q("mcp-plugin-vis-monai")).not.toBeNull();
    expect(q("mcp-plugin-no-tools")).toBeNull();
    expect(q("mcp-plugin-noperm")).toBeNull();
    expect(q("mcp-plugins-none")).toBeNull();
    expect(q("mcp-plugin-tools-vis-monai")!.textContent).toMatch(/segment_run/);
    expect(host.textContent).toMatch(/外部の計算機へ送る機能あり|can send data to an external compute host/); // MONAI の印
    expect(checked("mcp-plugin-ai-tools-demo")).toBe(false);
    await click("mcp-plugin-ai-tools-demo");
    expect(sent.at(-1)).toEqual({ pluginTools: ["ai-tools-demo"] });
    expect(checked("mcp-plugin-ai-tools-demo")).toBe(true);
    await click("mcp-plugin-vis-monai");
    expect(sent.at(-1)).toEqual({ pluginTools: ["ai-tools-demo", "vis-monai"] });
    await click("mcp-plugin-ai-tools-demo"); // 外す
    expect(sent.at(-1)).toEqual({ pluginTools: ["vis-monai"] });
    expect(checked("mcp-plugin-ai-tools-demo")).toBe(false);
    expect(q("mcp-error")).toBeNull();
  });

  it("確認が取り消されたらオフのまま。見つからないプラグインは理由を出す。プラグインが無い・取れないときは「ありません」", async () => {
    stubPlugins(MANIFESTS);
    fakeMain({ confirm: false });
    await mount();
    await click("mcp-plugin-vis-monai");
    expect(checked("mcp-plugin-vis-monai")).toBe(false);
    expect(q("mcp-error")).toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    fakeMain({ knownPlugins: [] });
    await mount();
    await click("mcp-plugin-vis-monai");
    expect(q("mcp-error")!.dataset.code).toBe("unknownPlugin");
    expect(checked("mcp-plugin-vis-monai")).toBe(false);
    await act(async () => root.unmount());
    root = createRoot(host);
    stubPlugins([]);
    fakeMain();
    await mount();
    expect(q("mcp-plugins-none")).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("backend down"))));
    fakeMain();
    await mount();
    expect(q("mcp-plugins-none")).not.toBeNull();
  });
});
