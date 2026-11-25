// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 一括抽出ダイアログの DOM 煙テスト: 実際に開いて、注意帯（モダリティの混在・PET のビン幅）と、
// 入力欄・チェック・ボタンの説明（title・ⓘ）の付け忘れを検出する。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import type { BatchPair } from "./batchApi";

vi.mock("../api", async (orig) => ({
  ...(await orig<typeof import("../api")>()),
  fetchStudies: vi.fn(async () => []),
  fetchSeries: vi.fn(async () => [
    { seriesInstanceUid: "CT1", modality: "CT", seriesNumber: 1, seriesDescription: "ct", sopClassUid: null, numberOfInstances: 1 },
    { seriesInstanceUid: "PT1", modality: "PT", seriesNumber: 2, seriesDescription: "pet", sopClassUid: null, numberOfInstances: 1 },
    { seriesInstanceUid: "SEG", modality: "SEG", seriesNumber: 3, seriesDescription: "seg", sopClassUid: null, numberOfInstances: 1 },
  ]),
  getRoiFeatureSettingsSchema: vi.fn(async () => [{ key: "INT_sampleOnly", type: "int", defaultValue: "3" }]),
}));
const plan = vi.hoisted(() => ({ pairs: [] as unknown[] }));
vi.mock("./batchApi", async (orig) => ({
  ...(await orig<typeof import("./batchApi")>()),
  planBatch: vi.fn(async () => plan.pairs),
}));

import { RoiFeatureBatchDialog } from "./RoiFeatureBatchDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const pair = (study: string, source: string, over: Partial<BatchPair> = {}): BatchPair => ({
  studyUid: study, sourceSeriesUid: source, maskSeriesUid: "SEG", segmentNumber: 1, segmentLabel: "GTV",
  maskChannel: 0, status: "AUTO", reason: null, sourceCandidates: [source], ...over,
});

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function open(pairs: BatchPair[]) {
  plan.pairs = pairs;
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(RoiFeatureBatchDialog, { albumId: 1, albumName: "A", uids: ["S1", "S2"], onClose: () => undefined })));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}
async function click(el: HTMLElement) {
  await act(async () => { el.click(); });
}

beforeEach(() => {
  localStorage.setItem("graphy.locale", "ja");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** 利用者が触れる欄（隠しのファイル入力は除く）。 */
const controls = () =>
  Array.from(host.querySelectorAll<HTMLElement>("input, select, textarea, button"))
    .filter((e) => !(e instanceof HTMLInputElement && e.type === "file"));
const titleOf = (e: HTMLElement) => e.closest("[title]")?.getAttribute("title")?.trim() ?? "";
const nameOf = (e: HTMLElement) => e.getAttribute("data-testid") ?? `${e.tagName}:${e.outerHTML.slice(0, 80)}`;

describe("一括抽出ダイアログ", () => {
  it("CT と PT が混ざると注意帯が出る（モダリティ名つき）。1 種類なら出ない", async () => {
    await open([pair("ST1", "CT1"), pair("ST2", "PT1")]);
    expect(q("batch-row-0")).not.toBeNull();
    const band = q("batch-modality-mixed-warn");
    expect(band?.textContent).toContain("CT / PT");
    expect(band?.textContent).toContain("モダリティごとに分けて実行してください");
    // PT を外すと 1 種類になり、帯は消える（対象にした組だけを数える）
    await click(q("batch-include-1") as HTMLInputElement);
    expect(q("batch-modality-mixed-warn")).toBeNull();
  });

  it("PET を対象にし、固定ビン幅が初期値のままのときだけ、ビン幅の注意帯が出る（既定のままでは出ない）", async () => {
    await open([pair("ST2", "PT1")]);
    expect(q("batch-pet-binwidth-warn")).toBeNull(); // 既定は固定ビン数
    const widthRadio = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.closest("label")?.textContent?.includes("ビン幅"));
    expect(widthRadio).toBeTruthy();
    await click(widthRadio as HTMLElement);
    expect(q("batch-pet-binwidth-warn")?.textContent).toContain("0.10 SUV");
  });

  it("CT だけなら、ビン幅を初期値にしても PET の注意帯は出ない", async () => {
    await open([pair("ST1", "CT1")]);
    const widthRadio = Array.from(host.querySelectorAll<HTMLInputElement>('input[type="radio"]')).find((r) => r.closest("label")?.textContent?.includes("ビン幅"));
    await click(widthRadio as HTMLElement);
    expect(q("batch-pet-binwidth-warn")).toBeNull();
  });

  it("入力欄・チェック・ボタンのすべてに説明（title）があり、見出しに ⓘ がある（2D の単位・詳細設定の一覧も開いて確かめる）", async () => {
    await open([pair("ST1", "CT1", { status: "NEEDS_CONFIRMATION", sourceSeriesUid: null, sourceCandidates: ["CT1", "PT1"] }), pair("ST2", "PT1")]);
    await click(q("batch-unit-MAX_SECTION_2D") as HTMLElement);
    const defaults = q("batch-advanced-defaults") as HTMLDetailsElement;
    await act(async () => { defaults.open = true; defaults.dispatchEvent(new Event("toggle")); });
    expect(q("batch-advanced-add-INT_sampleOnly")).not.toBeNull();
    const all = controls();
    expect(all.length).toBeGreaterThan(40);
    expect(all.filter((e) => titleOf(e) === "").map(nameOf)).toEqual([]);
    const marks = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="info-mark"]'));
    expect(marks.length).toBeGreaterThan(30);
    expect(marks.filter((m) => (m.getAttribute("title") ?? "").trim() === "")).toEqual([]);
    // 説明（title）のある見出し（欄を含まない要素）には ⓘ が付く。値そのものの注記（SHA の表示など）は対象外
    const headings = Array.from(host.querySelectorAll<HTMLElement>("[title]")).filter((e) =>
      e.getAttribute("data-testid") !== "info-mark" && !e.querySelector("input, select, textarea, button")
      && !e.matches("input, select, textarea, button, td, [data-testid=\"batch-spec-sha\"], [data-testid=\"batch-progress-footer\"]")
      && !e.closest("button"));
    expect(headings.length).toBeGreaterThan(20);
    expect(headings.filter((e) => !e.querySelector('[data-testid="info-mark"]')).map((e) => e.textContent?.slice(0, 40))).toEqual([]);
    // 族のチェックごとに ⓘ がある
    const fams = Array.from(host.querySelectorAll<HTMLElement>('[data-testid^="batch-family-"]'));
    expect(fams.length).toBeGreaterThanOrEqual(13);
    for (const f of fams) expect(f.closest("label")?.querySelector('[data-testid="info-mark"]'), nameOf(f)).not.toBeNull();
  });
});
