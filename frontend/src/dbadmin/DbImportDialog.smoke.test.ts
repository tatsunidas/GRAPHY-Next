// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 荷物の取り込みダイアログの DOM の煙テスト: 実際に描画し、取り消し → 理由の表示 → 取り込み（実行中 → 結果）を通す。
// main（desktop/dbImportFlow.js）は偽物で渡す。形は dbImportFlow の戻り値に合わせる。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbImportJob, DbImportPackage } from "../desktopBridge";
import { I18nProvider } from "../i18n/i18n";
import { DbImportDialog } from "./DbImportDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const win = window as unknown as { graphyDesktop?: unknown };
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const sleep = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

const base: DbImportJob = { ok: true, state: "done", studies: 2, studyUids: ["1", "2"], packages: [] };
const pkg: DbImportPackage = { outcome: "imported", imported: 10, skippedExisting: 0, failed: 0, relatedInserted: 1, relatedSame: 0, conflicts: 0, pluginNotes: [] };

beforeEach(() => {
  host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  delete win.graphyDesktop;
});

async function mount(onImported = vi.fn()) {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(DbImportDialog, { onClose: () => undefined, onImported, pollMs: 5 })));
  });
  return onImported;
}
const click = async (id: string) => { await act(async () => { q(id)!.click(); }); await sleep(0); };

describe("荷物の取り込みダイアログ", () => {
  it("取り消すと何も出さず、もう一度押せる。理由があれば表示する", async () => {
    const answers = [{ ok: false, canceled: true }, { ok: false, reason: "source-is-current" }, { ok: false, reason: "backend-500" }];
    win.graphyDesktop = { dbImportStart: () => Promise.resolve(answers.shift()), dbImportStatus: vi.fn() };
    await mount();
    await click("db-import-run");
    expect(q("db-import-error")).toBeNull();
    expect((q("db-import-run") as HTMLButtonElement).disabled).toBe(false);
    await click("db-import-run");
    expect(q("db-import-error")!.textContent).not.toContain("source-is-current");
    expect(q("db-import-error")!.textContent!.length).toBeGreaterThan(5);
    await click("db-import-run");
    expect(q("db-import-error")!.textContent).toContain("backend-500");
  });

  it("実行中は閉じられず、終わると件数と注記を出して一覧の読み直しを呼ぶ", async () => {
    const states: DbImportJob[] = [
      { ...base, state: "running", studies: 0, studyUids: [] },
      { ...base, packages: [{ ...pkg, pluginNotes: [{ id: "4dflow", sourceVersion: "0.6.1", localVersion: null, kind: "missing" }] },
        { ...pkg, outcome: "damaged", imported: 0, relatedInserted: 0 }] },
    ];
    const status = vi.fn(() => Promise.resolve(states.length > 1 ? states.shift()! : states[0]));
    win.graphyDesktop = { dbImportStart: () => Promise.resolve({ ok: true, jobId: "j" }), dbImportStatus: status };
    const onImported = await mount();
    await click("db-import-run");
    expect(q("db-import-running")).not.toBeNull();
    expect((q("db-import-close") as HTMLButtonElement).disabled).toBe(true);
    await sleep(40);
    const text = q("db-import-result")!.textContent!;
    expect(text).toContain("10");
    expect(q("db-import-plugin-note")!.textContent).toContain("4dflow");
    expect(text).not.toContain("dbImport."); // 訳の抜けが無い
    expect((q("db-import-close") as HTMLButtonElement).disabled).toBe(false);
    expect(onImported).toHaveBeenCalledTimes(1);
    expect(status).toHaveBeenCalledTimes(2);
  });

  it("何も取り込めなかったときは一覧を読み直さない", async () => {
    win.graphyDesktop = {
      dbImportStart: () => Promise.resolve({ ok: true, jobId: "j" }),
      dbImportStatus: () => Promise.resolve({ ...base, studies: 0, studyUids: [], packages: [{ ...pkg, outcome: "incomplete", imported: 0 }] }),
    };
    const onImported = await mount();
    await click("db-import-run");
    expect(q("db-import-result")!.textContent).not.toContain("dbImport.");
    expect(onImported).not.toHaveBeenCalled();
  });
});
