// @vitest-environment jsdom
/*
 * ハンギングプロトコルの管理ダイアログの DOM 煙テスト。偽の設定ストアは本物と同じく「送ったキーだけ上書きして全件を返す」。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import type { SettingsMap } from "../settings/settingsApi";
import { HangingProtocolManageDialog } from "./HangingProtocolManageDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: SettingsMap = {};
const load = vi.fn(async () => ({ ...store }));
const save = vi.fn(async (u: SettingsMap) => { store = { ...store, ...u }; return { ...store }; });
const download = vi.fn();
const onClose = vi.fn();
let host: HTMLDivElement;
let root: Root;

const body = (id: string, name = `name ${id}`) =>
  ({ id, name, version: 1, match: {}, slots: [{ series: { descriptionContains: "t1" } }], grid: { rows: 1, cols: 2 } });

const mount = async () => {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(HangingProtocolManageDialog, { load, save, download, onClose })));
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  store = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string) => [...document.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const click = async (id: string) => { await act(async () => { el(id)!.click(); }); };
const edit = (value: string) => {
  const area = el("hanging-editor") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(area, value); area.dispatchEvent(new Event("input", { bubbles: true })); });
};
const importFile = async (content: string) => {
  const input = el("hanging-import-file") as HTMLInputElement;
  // jsdom の File は text() を持たない版があるので、本物と同じ形（Promise<string>）を持たせる。
  const file = { name: "p.json", text: () => Promise.resolve(content) };
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })); });
};

describe("HangingProtocolManageDialog", () => {
  it("0 件のまま開く: 自動適用は切、書き出しは押せない。開いただけでは何も保存しない", async () => {
    await mount();
    expect(el("hanging-manage-empty")).not.toBeNull();
    expect((el("hanging-auto") as HTMLInputElement).checked).toBe(false);
    expect((el("hanging-export") as HTMLButtonElement).disabled).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("自動適用の切替を保存する", async () => {
    await mount();
    await click("hanging-auto");
    expect(store["viewer.hangingAutoApply"]).toBe("true");
    await click("hanging-auto");
    expect(store["viewer.hangingAutoApply"]).toBe("false");
  });

  it("新規で保存し、編集で名前を変える。編集で id は変えられず、新規で同じ id は断る", async () => {
    await mount();
    await click("hanging-new");
    edit(JSON.stringify(body("a", "first")));
    await click("hanging-save");
    expect(all("hanging-manage-row").map((r) => r.dataset.protocolId)).toEqual(["a"]);

    await click("hanging-new");
    edit(JSON.stringify(body("a", "duplicate")));
    await click("hanging-save");
    expect(el("hanging-manage-errors")!.textContent).toContain('"a" is already saved');
    expect(JSON.parse(store["hanging.protocol.a"]).name).toBe("first");
    await click("hanging-back");

    await click("hanging-edit");
    edit(JSON.stringify(body("renamed", "second")));
    await click("hanging-save");
    expect(el("hanging-manage-errors")!.textContent).toContain("original id: a");
    expect(store["hanging.protocol.renamed"]).toBeUndefined();
    edit(JSON.stringify(body("a", "second")));
    await click("hanging-save");
    expect(JSON.parse(store["hanging.protocol.a"]).name).toBe("second");
  });

  it("不正な内容は理由を出して保存しない", async () => {
    await mount();
    await click("hanging-new");
    edit("{");
    await click("hanging-save");
    expect(el("hanging-manage-errors")).not.toBeNull();
    edit(JSON.stringify({ ...body("a"), version: 3 }));
    await click("hanging-save");
    expect(el("hanging-manage-errors")!.textContent).toContain("version");
    expect(save).not.toHaveBeenCalled();
  });

  it("削除は確認してから。やめれば残り、実行すれば空文字で上書きする", async () => {
    store = { "hanging.protocol.a": JSON.stringify(body("a")) };
    await mount();
    await click("hanging-delete");
    await click("hanging-delete-no");
    expect(save).not.toHaveBeenCalled();
    await click("hanging-delete");
    await click("hanging-delete-yes");
    expect(store["hanging.protocol.a"]).toBe("");
    expect(el("hanging-manage-empty")).not.toBeNull();
  });

  it("読めない保存は理由を出して削除できる", async () => {
    store = { "hanging.protocol.x": "{" };
    await mount();
    expect(el("hanging-broken")!.textContent).toContain("hanging.protocol.x");
    await click("hanging-broken-delete");
    expect(store["hanging.protocol.x"]).toBe("");
    expect(el("hanging-broken")).toBeNull();
  });

  it("取り込みは件数を出し、確認するまで保存しない。正しいものだけを保存する", async () => {
    store = { "hanging.protocol.a": JSON.stringify(body("a", "old")) };
    await mount();
    await importFile(JSON.stringify([body("a", "new"), body("b"), { ...body("c"), version: 5 }]));
    expect(el("hanging-import-summary")!.textContent).toBe("New: 1 / overwrite: 1 / invalid: 1");
    expect(save).not.toHaveBeenCalled();
    await click("hanging-import-commit");
    expect(JSON.parse(store["hanging.protocol.a"]).name).toBe("new");
    expect(store["hanging.protocol.b"]).toBeDefined();
    expect(store["hanging.protocol.c"]).toBeUndefined();
    expect(el("hanging-manage-message")!.textContent).toContain("Imported 2.");
  });

  it("取り込みをやめると何も変わらない", async () => {
    await mount();
    await importFile(JSON.stringify(body("a")));
    await click("hanging-back");
    expect(save).not.toHaveBeenCalled();
  });

  it("書き出しは保存した全件を配列で渡す", async () => {
    store = { "hanging.protocol.a": JSON.stringify(body("a")), "hanging.protocol.gone": "" };
    await mount();
    await click("hanging-export");
    const [text, filename] = download.mock.calls[0] as [string, string];
    expect(filename).toBe("hanging-protocols.json");
    expect((JSON.parse(text) as { id: string }[]).map((p) => p.id)).toEqual(["a"]);
  });

  it("保存に失敗したら理由を出し、成功の表示にしない", async () => {
    await mount();
    save.mockImplementationOnce(() => Promise.reject(new Error("backend-500")));
    await click("hanging-new");
    edit(JSON.stringify(body("a")));
    await click("hanging-save");
    expect(el("hanging-manage-errors")!.textContent).toContain("backend-500");
    expect(el("hanging-manage-message")).toBeNull();
    expect(el("hanging-editor")).not.toBeNull();
  });

  it("文言に差し込み漏れ・訳の抜けが無い", async () => {
    store = { "hanging.protocol.a": JSON.stringify(body("a")), "hanging.protocol.x": "{" };
    await mount();
    const text = el("hanging-manage-dialog")!.textContent!;
    expect(text).not.toContain("{{");
    expect(text).not.toContain("viewer2d.");
  });
});
