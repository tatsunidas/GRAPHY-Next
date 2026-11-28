// @vitest-environment jsdom
/*
 * ハンギングプロトコルの適用ダイアログの DOM 煙テスト: 開く → 壊れた入力の理由 → 確認で並ぶ順が出る → キャンセル / 適用。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Series, Study } from "../api";
import { I18nProvider } from "../i18n/i18n";
import { HangingProtocolApplyDialog } from "./HangingProtocolApplyDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const study: Study = {
  studyInstanceUid: "1.2", patientId: "P", patientName: "N", studyDate: null, studyDescription: "check",
  modality: "CT", modalities: ["CT"], numberOfInstances: 4,
};
const series = (n: number): Series =>
  ({ seriesInstanceUid: `1.2.${n}`, modality: "CT", seriesNumber: n, seriesDescription: `synthetic ${n}`, numberOfInstances: 1, sopClassUid: null }) as Series;
const proto = (slots: number[], extra: object = {}) => JSON.stringify({
  id: "p", name: "P", version: 1,
  slots: slots.map((n) => ({ series: { descriptionContains: `synthetic ${n}` } })),
  grid: { rows: 1, cols: 2 }, ...extra,
});

let host: HTMLDivElement;
let root: Root;
const onApply = vi.fn();
const onClose = vi.fn();
const loadSeries = vi.fn(async () => [series(1), series(2), series(3), series(4)]);
let stored: Record<string, string> = {};
const loadSettings = vi.fn(async () => stored);

const mount = async () => {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(HangingProtocolApplyDialog, {
      study, loadSeries, loadSettings, closingCount: 1, transientCount: 0, portrait: false, onApply, onClose,
    })));
  });
};
beforeEach(() => {
  vi.clearAllMocks();
  stored = {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const el = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const button = (id: string) => el(id) as HTMLButtonElement;
const click = async (id: string) => { await act(async () => { button(id).click(); }); };
const type = (value: string) => {
  const area = el("hanging-json") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => { setter.call(area, value); area.dispatchEvent(new Event("input", { bubbles: true })); });
};

describe("HangingProtocolApplyDialog", () => {
  it("開いた直後は確認も適用も押せず、保存が無ければ選択欄を出さない", async () => {
    await mount();
    expect(el("hanging-saved")).toBeNull();
    expect(button("hanging-check").disabled).toBe(true);
    expect(button("hanging-apply").disabled).toBe(true);
  });

  it("JSON でない・形が不正なら理由を出し、シリーズを読みに行かず、適用できない", async () => {
    await mount();
    type("{");
    await click("hanging-check");
    expect(el("hanging-errors")).not.toBeNull();
    type(JSON.stringify({ id: "p", name: "P", version: 2, slots: [] }));
    await click("hanging-check");
    expect(el("hanging-errors")!.textContent).toContain("version");
    expect(button("hanging-apply").disabled).toBe(true);
    expect(loadSeries).not.toHaveBeenCalled();
  });

  it("確認で並ぶ順を出し、適用でその順と行×列を渡す。確認だけでは適用しない", async () => {
    await mount();
    type(proto([3, 1]));
    await click("hanging-check");
    const uids = [...document.querySelectorAll('[data-testid="hanging-preview-series"]')].map((n) => n.getAttribute("data-series-uid"));
    expect(uids).toEqual(["1.2.3", "1.2.1"]);
    // 差し込みの漏れ（波括弧の残り）が無く、名前・枚数・行・列が文に入っている。
    const preview = el("hanging-preview")!.textContent!;
    expect(preview).not.toMatch(/[{}]/);
    expect(preview).toContain('"P" arranges 2 tile(s) in this order (rows: 1 / columns: 2)');
    expect(el("hanging-closing")!.textContent).toContain("The 1 current tile(s)");
    expect(onApply).not.toHaveBeenCalled();
    await click("hanging-apply");
    expect(onApply).toHaveBeenCalledTimes(1);
    const arg = onApply.mock.calls[0][0] as { series: Series[]; rows: number; cols: number };
    expect([arg.series.map((s) => s.seriesInstanceUid), arg.rows, arg.cols]).toEqual([["1.2.3", "1.2.1"], 1, 2]);
  });

  it("キャンセルは閉じるだけ", async () => {
    await mount();
    type(proto([3, 1]));
    await click("hanging-check");
    await click("hanging-cancel");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("確認の後に書き換えると結果は消え、適用できなくなる", async () => {
    await mount();
    type(proto([3, 1]));
    await click("hanging-check");
    type(proto([2]));
    expect(el("hanging-preview")).toBeNull();
    expect(button("hanging-apply").disabled).toBe(true);
  });

  it("並ぶシリーズが無い・match に合わないときは理由を出し、適用できない", async () => {
    await mount();
    type(proto([9]));
    await click("hanging-check");
    expect(el("hanging-reject")).not.toBeNull();
    expect(button("hanging-apply").disabled).toBe(true);
    type(proto([1], { match: { modality: ["MR"] } }));
    await click("hanging-check");
    expect(el("hanging-reject")).not.toBeNull();
    expect(button("hanging-apply").disabled).toBe(true);
  });

  it("シリーズ一覧の取得に失敗したら理由を出す", async () => {
    await mount();
    loadSeries.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    type(proto([1]));
    await click("hanging-check");
    expect(el("hanging-errors")!.textContent).toContain("boom");
    expect(button("hanging-apply").disabled).toBe(true);
  });

  const save = (id: string, name: string, slots: number[], extra: object = {}) => {
    stored[`hanging.protocol.${id}`] = JSON.stringify({ ...JSON.parse(proto(slots, extra)) as object, id, name });
  };
  const choose = async (id: string) => {
    const sel = el("hanging-saved") as HTMLSelectElement;
    await act(async () => { sel.value = id; sel.dispatchEvent(new Event("change", { bubbles: true })); });
  };

  it("保存済みは検査の条件に合うものが先頭で、選ぶとそのまま確認まで進む", async () => {
    save("a-mr", "A for MR", [1], { match: { modality: ["MR"] } });
    save("b-ct", "B for CT", [4, 2], { match: { modality: ["CT"] } });
    await mount();
    const options = [...(el("hanging-saved") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["", "b-ct", "a-mr"]);
    await choose("b-ct");
    const uids = [...document.querySelectorAll('[data-testid="hanging-preview-series"]')].map((n) => n.getAttribute("data-series-uid"));
    expect(uids).toEqual(["1.2.4", "1.2.2"]);
    expect((el("hanging-json") as HTMLTextAreaElement).value).toContain("B for CT");
    expect(onApply).not.toHaveBeenCalled();
  });

  it("後から選んだものがあれば、遅れて届いた前の確認の結果は出さない", async () => {
    save("p1", "one", [1]);
    save("p2", "two", [2]);
    await mount();
    let release!: (v: Series[]) => void;
    loadSeries.mockImplementationOnce(() => new Promise<Series[]>((r) => { release = r; }));
    loadSeries.mockImplementationOnce(() => new Promise<Series[]>(() => {}));
    await choose("p1");
    await choose("p2");
    await act(async () => { release([series(1), series(2)]); });
    expect(el("hanging-preview")).toBeNull();
    expect(button("hanging-apply").disabled).toBe(true);
  });

  it("保存済みの読み込みに失敗したら理由を出す", async () => {
    loadSettings.mockImplementationOnce(() => Promise.reject(new Error("settings-503")));
    await mount();
    expect(el("hanging-saved-error")!.textContent).toContain("settings-503");
  });
});
