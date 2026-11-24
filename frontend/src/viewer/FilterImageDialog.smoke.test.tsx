// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// フィルタ画像（LoG）のダイアログの DOM 煙テスト: PET で「校正（PET）」の欄が出て既定のまま auto を送る・
// 校正しない（警告）を選ぶと none を送る・CT と PET の Parametric Map では欄が出ず auto を送る。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";

const submitted: Record<string, unknown>[] = [];

vi.mock("../api", () => ({
  fetchSeries: vi.fn(async () => [
    { seriesInstanceUid: "1.PET", seriesNumber: 1, modality: "PT", seriesDescription: "PET" },
    { seriesInstanceUid: "1.CT", seriesNumber: 2, modality: "CT", seriesDescription: "CT" },
    { seriesInstanceUid: "1.SUVPM", seriesNumber: 3, modality: "PT", seriesDescription: "SUV map", sopClassUid: "1.2.840.10008.5.1.4.1.1.30" },
  ]),
  fetchSeriesLayout: vi.fn(async () => ({ nC: 1, nT: 1 })),
  submitFilteredSeriesJob: vi.fn(async (req: Record<string, unknown>) => {
    submitted.push(req);
    return { jobId: "j1", state: "QUEUED", scaleDone: 0, scaleTotal: 0, scaleMm: 0, elapsedMs: 0, created: [] };
  }),
  getFilteredSeriesJob: vi.fn(async () => ({ jobId: "j1", state: "RUNNING", scaleDone: 0, scaleTotal: 1, scaleMm: 2, elapsedMs: 0, created: [] })),
  cancelFilteredSeriesJob: vi.fn(async () => ({ jobId: "j1", state: "CANCELLED", scaleDone: 0, scaleTotal: 0, scaleMm: 0, elapsedMs: 0, created: [] })),
}));

import { FilterImageDialog } from "./FilterImageDialog";

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
  await act(async () => {
    q("filterimg-run")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function open(modality: string, uid: string) {
  const series = { seriesInstanceUid: uid, seriesNumber: 1, modality, seriesDescription: "s" };
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(FilterImageDialog, {
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

describe("フィルタ画像のダイアログ: PET の校正", () => {
  it("PET: 欄が出て、既定のまま実行すると auto を送る", async () => {
    await open("PT", "1.PET");
    const sel = q("filterimg-calibration") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(sel.value).toBe("auto");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["auto", "bw", "sul-james", "sul-janma", "bsa", "none"]);
    expect(q("filterimg-calibration-none-warn")).toBeNull();
    expect(q("filterimg-calibration-help")?.textContent).toContain("SUVbw");
    await run();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].calibration).toBe("auto");
    expect(submitted[0].sourceSeriesUid).toBe("1.PET");
  });

  it("PET: SUL（James）を選ぶと sul-james、校正しないを選ぶと警告が出て none を送る", async () => {
    await open("PT", "1.PET");
    await choose(q("filterimg-calibration") as HTMLSelectElement, "sul-james");
    await run();
    expect(submitted[0].calibration).toBe("sul-james");

    submitted.length = 0;
    act(() => root.unmount());
    root = createRoot(host);
    await open("PT", "1.PET");
    await choose(q("filterimg-calibration") as HTMLSelectElement, "none");
    expect(q("filterimg-calibration-none-warn")?.textContent).toContain("校正しない");
    await run();
    expect(submitted[0].calibration).toBe("none");
  });

  it("CT: 欄が出ず auto を送る。PET で none を選んだあとに CT へ替えても auto", async () => {
    await open("CT", "1.CT");
    expect(q("filterimg-calibration")).toBeNull();
    await run();
    expect(submitted[0].calibration).toBe("auto");

    submitted.length = 0;
    act(() => root.unmount());
    root = createRoot(host);
    await open("PT", "1.PET");
    await choose(q("filterimg-calibration") as HTMLSelectElement, "none");
    await choose(host.querySelector("select") as HTMLSelectElement, "1.CT"); // 先頭の select がターゲット
    expect(q("filterimg-calibration")).toBeNull();
    await run();
    expect(submitted[0].sourceSeriesUid).toBe("1.CT");
    expect(submitted[0].calibration).toBe("auto");
  });

  it("PET の Parametric Map: 欄が出ず、校正済みの説明が出て、auto を送る", async () => {
    await open("PT", "1.SUVPM");
    expect(q("filterimg-calibration")).toBeNull();
    expect(q("filterimg-calibration-calibrated")?.textContent).toContain("校正済み");
    await run();
    expect(submitted[0].calibration).toBe("auto");
  });
});
