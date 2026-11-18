// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 施設の資料の設定画面の DOM の煙テスト: 実際に描画し、既定のまま（未設定）→ パスを入れて保存 → 読めた／壊れた／サーバー側の設定、を通す。
// 本体の API は fetch の偽物（fakeHost）で渡す。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { FacilityPanel } from "./FacilityPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { method: string; path: string; body: string | null }

let calls: Call[];
let settings: Record<string, string>;
let facility: Record<string, unknown> | null;
let mode: string;
let host: HTMLElement;
let root: Root;

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

const config = { title: "T", updatedAt: null, contact: null, groups: [{ id: "g", title: "G", items: [{ id: "g.0", type: "link", title: "L", url: "https://a.example/", note: null, body: null }], groups: [] }] };

function fakeHost(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, path, body: typeof init?.body === "string" ? init.body : null });
  if (path === "/api/facility/config") return Promise.resolve(facility === null ? new Response(null, { status: 204 }) : json(facility));
  if (path === "/api/status") return Promise.resolve(json({ app: "x", version: "1", mode, activeProfiles: [], javaVersion: "21" }));
  if (path === "/api/settings" && method === "GET") return Promise.resolve(json(settings));
  if (path === "/api/settings" && method === "PUT") {
    settings = { ...settings, ...JSON.parse(String(init?.body)) };
    return Promise.resolve(json(settings));
  }
  return Promise.resolve(json({ message: "unexpected " + path }, 404));
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }

async function mount() {
  await act(async () => { root.render(createElement(I18nProvider, null, createElement(FacilityPanel))); });
  await flush();
  await flush();
}

beforeEach(() => {
  calls = [];
  settings = {};
  facility = null;
  mode = "standalone";
  vi.stubGlobal("fetch", vi.fn(fakeHost));
  localStorage.setItem("graphy.locale", "ja");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("FacilityPanel（煙テスト）", () => {
  it("既定のまま（未設定）: パスの入力欄と「未設定」の状態が出る", async () => {
    await mount();
    expect(q("facility-panel")).not.toBeNull();
    expect(q("facility-path")).not.toBeNull();
    expect(q("facility-status")!.getAttribute("data-state")).toBe("unconfigured");
    expect(q("facility-status")!.textContent).toContain("未設定");
    expect((q("facility-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("パスを入れて保存すると、設定 facility.configPath が PUT される", async () => {
    await mount();
    const el = q("facility-path") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "  /srv/facility.json ");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { q("facility-save")!.click(); });
    await flush();
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/settings")!;
    expect(JSON.parse(put.body!)).toEqual({ "facility.configPath": "/srv/facility.json" });
    expect(host.textContent).toContain("保存しました");
  });

  it("読めたとき: グループ・項目の数が出る", async () => {
    facility = { state: "ok", error: null, errorPath: null, lastReadAt: 1_700_000_000_000, rev: 1, source: "setting", config };
    await mount();
    expect(q("facility-status")!.getAttribute("data-state")).toBe("ok");
    expect(q("facility-status")!.textContent).toContain("1 グループ・1 項目");
  });

  it("壊れたとき: 理由と場所が出て、前回の内容を表示していると分かる。コードの文字列は出ない", async () => {
    facility = { state: "error", error: "url", errorPath: "groups[0].items[0].url", lastReadAt: 1, rev: 1, source: "setting", config };
    await mount();
    const err = q("facility-error")!;
    expect(err.getAttribute("data-code")).toBe("url");
    expect(err.textContent).toContain("https か mailto ではありません");
    expect(err.textContent).toContain("groups[0].items[0].url");
    expect(err.textContent).toContain("前回の有効な内容を表示しています");
  });

  it("壊れていて、まだ内容が無いとき: 表示できる内容が無いと言う。知らない理由のコードは汎用の文言", async () => {
    facility = { state: "error", error: "brand-new-code", errorPath: null, lastReadAt: 1, rev: 1, source: "setting", config: null };
    await mount();
    expect(q("facility-error")!.textContent).toContain("原因が分かりません");
    expect(q("facility-error")!.textContent).toContain("まだ表示できる内容がありません");
  });

  it("サーバー側の設定のとき・Web 版では、パスの入力欄を出さない（変えられない）", async () => {
    facility = { state: "ok", error: null, errorPath: null, lastReadAt: 1, rev: 1, source: "server", config };
    await mount();
    expect(q("facility-path")).toBeNull();
    expect(q("facility-readonly")!.textContent).toContain("GRAPHY_FACILITY_CONFIG_PATH");
    await act(async () => root.unmount());
    root = createRoot(host);
    facility = null;
    mode = "web";
    await mount();
    expect(q("facility-path")).toBeNull();
    expect(q("facility-readonly")).not.toBeNull();
  });
});
