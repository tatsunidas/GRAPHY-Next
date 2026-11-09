// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 事前取得パネルの DOM の煙テスト: 実際に描画し、既定のまま保存 → 有効にして入力 → 保存 → 確認 → 実行 → 記録を開く、を通す。
// 本体の API は fetch の偽物（fakeHost）で渡す。
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { PrefetchPanel } from "./PrefetchPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Call {
  method: string;
  path: string;
  body: string | null;
}

let calls: Call[];
let settings: Record<string, string>;
let status: Record<string, unknown>;
let host: HTMLElement;
let root: Root;

function json(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), { status: statusCode, headers: { "content-type": "application/json" } });
}

function fakeHost(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const path = String(input);
  const method = init?.method ?? "GET";
  calls.push({ method, path, body: typeof init?.body === "string" ? init.body : null });
  if (path === "/api/prefetch/status") return Promise.resolve(json(status));
  if (path === "/api/settings" && method === "GET") return Promise.resolve(json(settings));
  if (path === "/api/settings" && method === "PUT") {
    settings = { ...settings, ...JSON.parse(String(init?.body)) };
    return Promise.resolve(json(settings));
  }
  if (path === "/api/dicom/remote-aes") {
    return Promise.resolve(json([{ aeTitle: "PACS", host: "h", port: 104, tls: false }, { aeTitle: "RIS", host: "h", port: 105, tls: false }]));
  }
  if (path === "/api/prefetch/preview-schedule") return Promise.resolve(json({ days: { "20261110": 3 }, error: null }));
  if (path === "/api/prefetch/run" && method === "POST") {
    status = { ...status, running: true };
    return Promise.resolve(new Response(null, { status: 202 }));
  }
  return Promise.resolve(json({ message: "unexpected " + path }, 404));
}

const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function type(id: string, value: string) {
  const el = q(id) as HTMLInputElement | HTMLSelectElement;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function click(id: string) {
  await act(async () => {
    q(id)!.click();
  });
  await flush();
}

beforeEach(async () => {
  calls = [];
  settings = {};
  status = { enabled: false, valid: true, errors: [], running: false, runs: [] };
  vi.stubGlobal("fetch", vi.fn(fakeHost));
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(PrefetchPanel)));
  });
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("PrefetchPanel（実際に描画して操作する）", () => {
  it("既定のまま描画でき、無効のまま保存できる（何も入れていなくても保存が通る）", async () => {
    expect(q("prefetch-panel")).not.toBeNull();
    expect((q("prefetch-enabled") as HTMLInputElement).checked).toBe(false);
    expect((q("prefetch-save") as HTMLButtonElement).disabled).toBe(false);
    await click("prefetch-save");
    const put = calls.find((c) => c.method === "PUT" && c.path === "/api/settings");
    expect(put).toBeDefined();
    expect(JSON.parse(put!.body!)["prefetch.enabled"]).toBe("false");
  });

  it("有効にすると不備が出て保存できず、CSV の項目を入れると保存できる", async () => {
    await click("prefetch-enabled");
    expect(q("prefetch-form-errors")).not.toBeNull();
    expect((q("prefetch-save") as HTMLButtonElement).disabled).toBe(true);

    await type("prefetch-source", "csv");
    expect(q("prefetch-csv-folder")).not.toBeNull(); // CSV の入力欄が出る
    expect(q("prefetch-mwl-ae")).toBeNull();
    await type("prefetch-csv-folder", "C:/ris");
    await type("prefetch-csv-charset", "Shift_JIS");
    await type("prefetch-csv-col-id", "患者ID");
    await type("prefetch-target-day", "tomorrow");
    await type("prefetch-times", "07:00, 18:30");
    await type("prefetch-pacs-ae", "PACS");
    await type("prefetch-retrieve", "move");
    await type("prefetch-timeout", "600");
    expect(q("prefetch-form-errors")).toBeNull();
    expect((q("prefetch-save") as HTMLButtonElement).disabled).toBe(false);

    await click("prefetch-save");
    const put = JSON.parse(calls.filter((c) => c.method === "PUT").at(-1)!.body!);
    expect(put).toMatchObject({
      "prefetch.enabled": "true",
      "prefetch.source": "csv",
      "prefetch.csv.folder": "C:/ris",
      "prefetch.csv.charset": "Shift_JIS",
      "prefetch.times": "07:00, 18:30",
      "prefetch.pacs.ae": "PACS",
      "prefetch.retrieve": "move",
      "prefetch.timeoutSec": "600",
    });
  });

  it("負例: 保存前の入力のあいだは、確認と実行のボタンが押せない", async () => {
    status = { ...status, enabled: true, valid: true };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3100)); // 状態の再取得（3 秒周期）
    });
    expect((q("prefetch-preview") as HTMLButtonElement).disabled).toBe(false);
    await type("prefetch-times", "09:00"); // 未保存の編集
    expect((q("prefetch-preview") as HTMLButtonElement).disabled).toBe(true);
    expect((q("prefetch-run-now") as HTMLButtonElement).disabled).toBe(true);
  }, 10_000);

  it("確認・実行・記録: 保存済みで有効なら、予約一覧の患者数が出て、実行が始まり、記録を開ける", async () => {
    status = {
      enabled: true,
      valid: true,
      errors: [],
      running: false,
      runs: [
        {
          id: 1, slotKey: "2026-11-09T07:00", trigger: "SCHEDULE", startedAt: Date.UTC(2026, 10, 9, 22, 0), finishedAt: Date.UTC(2026, 10, 9, 22, 5),
          status: "INTERRUPTED", targetDays: "20261110", patients: 5, found: 2, retrieved: 2, existing: 0, failed: 0, pending: 3, error: "pacs-find-failed",
        },
      ],
    };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 3100));
    });
    expect(q("prefetch-last")!.textContent).toContain("Interrupted");
    expect(q("prefetch-last-error")!.textContent).toContain("Could not query the PACS");

    await click("prefetch-preview");
    expect(q("prefetch-preview-result")!.textContent).toContain(": 3 patients");

    await click("prefetch-run-now");
    expect(calls.some((c) => c.method === "POST" && c.path === "/api/prefetch/run")).toBe(true);

    await click("prefetch-log-open");
    expect(q("prefetch-log-table")!.querySelectorAll("tbody tr").length).toBe(1);
    await click("prefetch-log-close");
    expect(q("prefetch-log")).toBeNull();
  }, 10_000);
});
