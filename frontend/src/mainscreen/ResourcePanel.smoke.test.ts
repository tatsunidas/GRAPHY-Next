// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 「資料」節の DOM の煙テスト: 実際に描画し、既定のまま（未設定は節なし → 設定ありで畳んで出る）→ 開く → リンクで openExternal に設定の URL が渡る、を通す。
// 本体の API は fetch の偽物（fakeHost）で渡す。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";

const opened: string[] = [];
vi.mock("../help/links", () => ({ openExternal: (u: string) => opened.push(u), isSafeExternalUrl: () => true }));

import { ResourcePanel } from "./ResourcePanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let facility: { status: number; body?: unknown; etag?: string } ;
let seenIfNoneMatch: Array<string | null>;
let host: HTMLElement;
let root: Root;

const config = {
  title: null, updatedAt: "2026-11-18", contact: "mailto:rad-info@example.org",
  groups: [
    { id: "protocols", title: "撮影プロトコル", items: [{ id: "p.0", type: "link", title: "造影 CT", url: "https://intra.example.org/ct", note: "改訂" }],
      groups: [{ id: "peds", title: "小児", items: [{ id: "p.1", type: "link", title: "鎮静", url: "https://intra.example.org/sed", note: null }], groups: [] }] },
    { id: "phones", title: "電話帳", items: [{ id: "ph.0", type: "card", title: "当直", url: null, note: null, body: "内線 1234\n内線 5678" }], groups: [] },
  ],
};
const ok = (cfg: unknown = config, state = "ok") => ({ status: 200, etag: 'W/"1-1"', body: { state, error: state === "ok" ? null : "url", errorPath: null, lastReadAt: 1, rev: 1, source: "setting", config: cfg } });

function fakeHost(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  expect(String(input)).toBe("/api/facility/config");
  seenIfNoneMatch.push((init?.headers as Record<string, string> | undefined)?.["If-None-Match"] ?? null);
  if (facility.status === 204) return Promise.resolve(new Response(null, { status: 204 }));
  return Promise.resolve(new Response(JSON.stringify(facility.body), { status: facility.status, headers: { "content-type": "application/json", ETag: facility.etag ?? "" } }));
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function click(id: string) { await act(async () => { q(id)!.click(); }); }
async function mount() {
  await act(async () => { root.render(createElement(I18nProvider, null, createElement(ResourcePanel))); });
  await flush();
  await flush();
}

beforeEach(() => {
  opened.length = 0;
  seenIfNoneMatch = [];
  facility = { status: 204 };
  vi.stubGlobal("fetch", vi.fn(fakeHost));
  localStorage.clear();
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

describe("ResourcePanel（煙テスト）", () => {
  it("未設定（204）では節を出さない", async () => {
    await mount();
    expect(q("resource-panel")).toBeNull();
    expect(host.textContent).toBe("");
  });

  it("既定のまま（設定あり）: 節は畳まれ、グループは見えない。開くと、グループは全部閉じている", async () => {
    facility = ok();
    await mount();
    expect(q("resource-panel")).not.toBeNull();
    expect(q("resource-panel-toggle")!.getAttribute("aria-expanded")).toBe("false");
    expect(q("resource-panel-group-protocols")).toBeNull();
    await click("resource-panel-toggle");
    expect(q("resource-panel-group-toggle-protocols")!.getAttribute("aria-expanded")).toBe("false");
    expect(q("resource-panel-group-toggle-phones")!.getAttribute("aria-expanded")).toBe("false");
    expect(q("resource-panel-link-p.0")).toBeNull(); // 閉じているグループの中は出ない
    expect(host.textContent).toContain("更新 2026-11-18");
  });

  it("グループを開くとリンクが出て、押すと openExternal に設定の URL が完全一致で渡る。入れ子・カードも開ける", async () => {
    facility = ok();
    await mount();
    await click("resource-panel-toggle");
    await click("resource-panel-group-toggle-protocols");
    await click("resource-panel-link-p.0");
    expect(opened).toEqual(["https://intra.example.org/ct"]);
    expect(q("resource-panel-link-p.0")!.getAttribute("title")).toBe("https://intra.example.org/ct"); // 行き先を確かめられる
    await click("resource-panel-group-toggle-peds");
    await click("resource-panel-link-p.1");
    expect(opened[1]).toBe("https://intra.example.org/sed");
    await click("resource-panel-group-toggle-phones");
    await click("resource-panel-card-ph.0");
    expect(q("resource-panel-card-body-ph.0")!.textContent).toContain("内線 1234");
  });

  it("開閉の状態は再描画（再マウント）後も保たれる", async () => {
    facility = ok();
    await mount();
    await click("resource-panel-toggle");
    await click("resource-panel-group-toggle-protocols");
    await act(async () => root.unmount());
    root = createRoot(host);
    await mount();
    expect(q("resource-panel-group-toggle-protocols")!.getAttribute("aria-expanded")).toBe("true");
    expect(q("resource-panel-group-toggle-phones")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("「管理者に連絡」は、設定の mailto に件名だけ足して開く", async () => {
    facility = ok();
    await mount();
    await click("resource-panel-toggle");
    await click("resource-panel-contact");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatch(/^mailto:rad-info@example\.org\?subject=/);
  });

  it("壊れた設定（直前の内容あり）: 警告を出しつつ、前回の内容は出る。内容が無ければ読めない旨だけ", async () => {
    facility = ok(config, "error");
    await mount();
    await click("resource-panel-toggle");
    expect(q("resource-panel-status")!.textContent).toContain("前回の有効な内容");
    expect(q("resource-panel-group-protocols")).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(host);
    facility = ok(null, "error");
    await mount();
    expect(q("resource-panel-status")!.textContent).toContain("読み込めません");
    expect(q("resource-panel-group-protocols")).toBeNull();
  });

  it("負例: 安全でないリンクが（万一）届いても、画面には出ない", async () => {
    facility = ok({ ...config, groups: [{ id: "g", title: "G", items: [{ id: "x", type: "link", title: "危険", url: "javascript:alert(1)", note: null }, { id: "y", type: "link", title: "http", url: "http://a.example/", note: null }], groups: [] }] });
    localStorage.setItem("graphy.facility.open", JSON.stringify(["__section__", "g"]));
    await mount();
    expect(q("resource-panel-group-g")).not.toBeNull();
    expect(q("resource-panel-link-x")).toBeNull();
    expect(q("resource-panel-link-y")).toBeNull();
  });

  it("localStorage が使えなくても、既定（閉）で描画できる", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, clear: () => undefined });
    facility = ok();
    await mount();
    expect(q("resource-panel")).not.toBeNull();
    await click("resource-panel-toggle");
    expect(q("resource-panel-group-toggle-protocols")!.getAttribute("aria-expanded")).toBe("false");
  });

  it("2 回目以降の問い合わせは ETag を付ける（変わっていなければ 304 で転送しない）", async () => {
    vi.useFakeTimers();
    try {
      facility = ok();
      await act(async () => { root.render(createElement(I18nProvider, null, createElement(ResourcePanel))); });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      await act(async () => { await vi.advanceTimersByTimeAsync(2100); });
      expect(seenIfNoneMatch[0]).toBeNull();
      expect(seenIfNoneMatch[1]).toBe('W/"1-1"');
    } finally {
      vi.useRealTimers();
    }
  });

  it("パネルのコードは、選択中の検査・電子カルテ連携・患者に関する module を import しない（静的検査）", () => {
    for (const f of ["ResourcePanel.tsx", "useFacilityConfig.ts", "resourcePanelView.ts"]) {
      const src = readFileSync(join(__dirname, f), "utf8");
      const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(i, `${f} imports ${i}`).not.toMatch(/emr|patient|study|Study|series|Series|album/i);
    }
  });
});
