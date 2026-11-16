// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 電子カルテ連携の設定画面の DOM の煙テスト: 実際に描画し、既定のまま → 有効にして必須を満たす → 保存 → 読めるか確認、を通す。
// 本体の API は fetch の偽物（fakeHost）で渡す。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { EmrPanel } from "./EmrPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call { method: string; path: string; body: string | null }

let calls: Call[];
let settings: Record<string, string>;
let status: Record<string, unknown>;
let statusCode: number;
let checkResult: Record<string, unknown>;
let host: HTMLElement;
let root: Root;

const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });

const baseStatus = () => ({
  enabled: false, valid: true, errors: [], autoOpen: false,
  file: { state: "disabled", error: null, lastReadAt: null }, patient: null,
  fetch: { state: "idle", patientId: null, found: 0, retrieved: 0, latestStudyUid: null, latestReady: false, error: null },
});

function fakeHost(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, path, body: typeof init?.body === "string" ? init.body : null });
  if (path === "/api/emr/status") return Promise.resolve(statusCode === 200 ? json(status) : json({ message: "no" }, statusCode));
  if (path === "/api/emr/check") return Promise.resolve(json(checkResult));
  if (path === "/api/settings" && method === "GET") return Promise.resolve(json(settings));
  if (path === "/api/settings" && method === "PUT") {
    settings = { ...settings, ...JSON.parse(String(init?.body)) };
    const s = settings;
    status = { ...status, enabled: s["emr.watch.enabled"] === "true", valid: true };
    return Promise.resolve(json(settings));
  }
  if (path === "/api/dicom/remote-aes") return Promise.resolve(json([{ aeTitle: "PACS", host: "h", port: 104, tls: false }]));
  return Promise.resolve(json({ message: "unexpected " + path }, 404));
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function flush() { await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); }
async function type(id: string, value: string) {
  const el = q(id) as HTMLInputElement | HTMLSelectElement;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function click(id: string) { await act(async () => { q(id)!.click(); }); await flush(); }

beforeEach(async () => {
  calls = [];
  settings = {};
  status = baseStatus();
  statusCode = 200;
  checkResult = { ok: true, error: null, hint: "12…78", length: 8 };
  vi.stubGlobal("fetch", vi.fn(fakeHost));
  localStorage.setItem("graphy.locale", "ja");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(I18nProvider, null, createElement(EmrPanel))); });
  await flush();
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("EmrPanel（実際に描画して操作する）", () => {
  it("既定のまま: 無効・入力なし・エラーなし・保存は押せない・監視していない旨が出る", async () => {
    expect((q("emr-enabled") as HTMLInputElement).checked).toBe(false);
    expect(q("emr-form-errors")).toBeNull();
    expect((q("emr-save") as HTMLButtonElement).disabled).toBe(true);
    expect(q("emr-status-file")!.textContent).toContain("監視していません");
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("有効にすると必須が出て保存できない → 全部入れると保存でき、設定のキーに入る → 保存後に読めるか確認できる", async () => {
    await click("emr-enabled");
    expect(q("emr-form-errors")!.textContent).toContain("ファイル");
    expect((q("emr-save") as HTMLButtonElement).disabled).toBe(true); // 変更はあるが、必須が空

    await type("emr-path", "C:\\emr\\pid.csv");
    await type("emr-format", "csv");
    await type("emr-charset", "Shift_JIS");
    await type("emr-csv-column", "患者ID");
    await type("emr-pacs-ae", "PACS");
    await type("emr-retrieve", "move");
    await type("emr-timeout", "120");
    expect(q("emr-form-errors")).toBeNull();
    expect((q("emr-check") as HTMLButtonElement).disabled).toBe(true); // 保存前は確認できない
    await click("emr-auto-open");
    await click("emr-save");

    const put = calls.filter((c) => c.method === "PUT").pop()!;
    expect(JSON.parse(put.body!)).toMatchObject({
      "emr.watch.enabled": "true", "emr.watch.path": "C:\\emr\\pid.csv", "emr.watch.format": "csv",
      "emr.watch.charset": "Shift_JIS", "emr.watch.csv.column": "患者ID", "emr.watch.csv.header": "true",
      "emr.watch.autoOpen": "true", "emr.watch.pacs.ae": "PACS", "emr.watch.retrieve": "move", "emr.watch.timeoutSec": "120",
    });
    await flush();
    expect((q("emr-check") as HTMLButtonElement).disabled).toBe(false);
    await click("emr-check");
    expect(q("emr-check-result")!.textContent).toContain("12…78（8 文字）");
  });

  it("形式を bat にすると、変数名の欄に変わる（CSV の列の欄は消える）", async () => {
    await click("emr-enabled");
    await type("emr-format", "csv");
    expect(q("emr-csv-column")).not.toBeNull();
    expect(q("emr-bat-var")).toBeNull();
    await type("emr-format", "bat");
    expect(q("emr-bat-var")).not.toBeNull();
    expect(q("emr-csv-column")).toBeNull();
  });

  it("読めないときは、理由を日本語で出す（ID の中身は出ない）", async () => {
    settings = {
      "emr.watch.enabled": "true", "emr.watch.path": "x", "emr.watch.format": "csv", "emr.watch.charset": "UTF-8",
      "emr.watch.csv.column": "1", "emr.watch.pacs.ae": "PACS", "emr.watch.retrieve": "move", "emr.watch.timeoutSec": "60",
    };
    status = { ...baseStatus(), enabled: true };
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(createElement(I18nProvider, null, createElement(EmrPanel))); });
    await flush();
    await flush();
    checkResult = { ok: false, error: "id-invalid", hint: null, length: 0 };
    await click("emr-check");
    expect(q("emr-check-result")!.textContent).toContain("ID として使えない文字");
  });

  it("状態: 患者 ID は先頭と末尾だけ。取り込みの失敗は分類つきの文言", async () => {
    status = {
      ...baseStatus(), enabled: true,
      file: { state: "ok", error: null, lastReadAt: 1 },
      patient: { id: "SECRETPATIENT123", seq: 3, changedAt: 1 },
      fetch: { state: "error", patientId: "SECRETPATIENT123", found: 0, retrieved: 0, latestStudyUid: null, latestReady: false, error: "find-failed:DROPPED" },
    };
    await act(async () => { await new Promise((r) => setTimeout(r, 2100)); }); // 状態の再取得（2 秒周期）を待つ
    await flush();
    expect(q("emr-status-patient")!.textContent).toContain("SE…23");
    expect(host.textContent).not.toContain("SECRETPATIENT123");
    expect(q("emr-fetch-error")!.textContent).toContain("返事をせずに接続を切りました");
  }, 10_000);

  it("web モード（404）では、使えない旨だけを出す", async () => {
    statusCode = 404;
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => { root.render(createElement(I18nProvider, null, createElement(EmrPanel))); });
    await flush();
    await flush();
    expect(host.textContent).toContain("デスクトップ版");
    expect(q("emr-panel")).toBeNull();
  });
});
