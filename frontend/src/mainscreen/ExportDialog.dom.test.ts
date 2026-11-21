// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// エクスポート画面の DOM の煙テスト: 書き出しを完了 → 閉じる → 開き直す、で前回の完了メッセージが残らないこと。
// 本体の API は fetch の偽物、デスクトップの橋（出力先の選択）は偽物で渡す。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import type { Study } from "../api";
import { ExportDialog } from "./ExportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STUDY = {
  studyInstanceUid: "1.2.3", patientId: "P1", patientName: "N", studyDate: "20261122",
  studyDescription: null, modality: "CT", numberOfInstances: 1,
} as unknown as Study;

let host: HTMLElement;
let root: Root;
let failJob = false;

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
function fakeHost(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(String(input), "http://x");
  if (url.pathname === "/api/studies") return Promise.resolve(json([STUDY]));
  if (/^\/api\/studies\/[^/]+\/series$/.test(url.pathname))
    return Promise.resolve(json([{ seriesInstanceUid: "1.2.3.1", modality: "CT", seriesNumber: 1, seriesDescription: "x", numberOfInstances: 1 }]));
  if (url.pathname === "/api/export/jobs" && init?.method === "POST")
    return Promise.resolve(json({ jobId: "j1", state: failJob ? "FAILED" : "DONE", total: 1, processed: 1, outputPath: "/out/exp", error: failJob ? "boom" : null }));
  return Promise.resolve(json({ message: "unexpected " + url.pathname }, 404));
}

const render = (open: boolean) =>
  act(async () => {
    root.render(createElement(I18nProvider, null, createElement(ExportDialog, { open, onClose: () => {}, study: STUDY })));
  });
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const done = () => host.querySelector('[data-testid="export-done"]');

beforeEach(async () => {
  failJob = false;
  vi.stubGlobal("fetch", fakeHost);
  (window as unknown as { graphyDesktop: unknown }).graphyDesktop = { pickDirectory: async () => "/out" };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  delete (window as unknown as { graphyDesktop?: unknown }).graphyDesktop;
  vi.unstubAllGlobals();
});

describe("ExportDialog のログ", () => {
  it("完了メッセージが出て、閉じて開き直すと消えている", async () => {
    await render(true);
    await flush();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="export-run"]')!.click(); });
    await flush();
    expect(done()?.textContent).toContain("/out/exp"); // 前提: 出ている

    await render(false);
    await render(true);
    await flush();
    expect(done()).toBeNull();
  });

  it("失敗メッセージも、閉じて開き直すと消えている", async () => {
    failJob = true;
    await render(true);
    await flush();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="export-run"]')!.click(); });
    await flush();
    expect(host.textContent).toContain("boom"); // 前提: 出ている

    await render(false);
    await render(true);
    await flush();
    expect(host.textContent).not.toContain("boom");
  });
});
