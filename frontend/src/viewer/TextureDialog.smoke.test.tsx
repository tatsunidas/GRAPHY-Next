// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// テクスチャのマップのダイアログの DOM 煙テスト: PET で「PET の校正」の欄が出る・CT で出ない・
// 既定のまま実行すると auto を送る・校正しない（警告）を選ぶと none を送る・PET→CT に替えると auto に戻して送る。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";

const submitted: Record<string, unknown>[] = [];

vi.mock("../api", () => ({
  fetchSeries: vi.fn(async () => [
    { seriesInstanceUid: "1.PET", seriesNumber: 1, modality: "PT", seriesDescription: "PET" },
    { seriesInstanceUid: "1.CT", seriesNumber: 2, modality: "CT", seriesDescription: "CT" },
  ]),
  fetchSeriesLayout: vi.fn(async () => ({ nC: 1, nT: 1 })),
  submitTextureJob: vi.fn(async (req: Record<string, unknown>) => {
    submitted.push(req);
    return { jobId: "j1", state: "QUEUED", slicesDone: 0, slicesTotal: 0, elapsedMs: 0 };
  }),
  getTextureJob: vi.fn(async () => ({ jobId: "j1", state: "RUNNING", slicesDone: 0, slicesTotal: 0, elapsedMs: 0 })),
  cancelTextureJob: vi.fn(async () => ({ jobId: "j1", state: "CANCELLED", slicesDone: 0, slicesTotal: 0, elapsedMs: 0 })),
}));
vi.mock("../settings/settingsApi", () => ({ fetchSettings: vi.fn(async () => ({})) }));

import { TextureDialog } from "./TextureDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function choose(el: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function run() {
  const buttons = host.querySelectorAll("button");
  await act(async () => {
    buttons[buttons.length - 1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function open(modality: string, uid: string) {
  const series = { seriesInstanceUid: uid, seriesNumber: 1, modality, seriesDescription: "s" };
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(TextureDialog, {
      study: { studyInstanceUid: "1.2" } as never, series: series as never, onCreated: () => {}, onClose: () => {},
    })));
  });
  await act(async () => { await Promise.resolve(); }); // fetchSeries の解決を待つ
}

beforeEach(() => {
  submitted.length = 0;
  localStorage.setItem("graphy.locale", "ja");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("テクスチャのマップのダイアログ: PET の校正", () => {
  it("PET: 欄が出て、既定のまま実行すると auto を送る", async () => {
    await open("PT", "1.PET");
    const sel = q("texture-calibration") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(sel.value).toBe("auto");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["auto", "bw", "sul-james", "sul-janma", "bsa", "none"]);
    expect(q("texture-calibration-none-warn")).toBeNull();
    // マップ専用の説明文（「その組は…」を使わない）
    const help = q("texture-calibration-help")?.textContent ?? "";
    expect(help).toContain("理由つきで失敗します");
    expect(help).not.toContain("その組");
    await run();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].calibration).toBe("auto");
    expect(submitted[0].sourceSeriesUid).toBe("1.PET");
  });

  it("PET: 校正しないを選ぶと警告が出て none を送る", async () => {
    await open("PT", "1.PET");
    await choose(q("texture-calibration") as HTMLSelectElement, "none");
    expect(q("texture-calibration-none-warn")?.textContent).toContain("校正しない");
    await run();
    expect(submitted[0].calibration).toBe("none");
  });

  it("CT: 欄が出ず、auto を送る。PET で none を選んだあとに CT へ替えても auto", async () => {
    await open("CT", "1.CT");
    expect(q("texture-calibration")).toBeNull();
    await run();
    expect(submitted[0].calibration).toBe("auto");

    submitted.length = 0;
    act(() => root.unmount());
    root = createRoot(host);
    await open("PT", "1.PET");
    await choose(q("texture-calibration") as HTMLSelectElement, "none");
    const target = host.querySelector("select") as HTMLSelectElement; // 先頭の select がターゲット
    await choose(target, "1.CT");
    expect(q("texture-calibration")).toBeNull();
    await run();
    expect(submitted[0].sourceSeriesUid).toBe("1.CT");
    expect(submitted[0].calibration).toBe("auto");
  });
});
