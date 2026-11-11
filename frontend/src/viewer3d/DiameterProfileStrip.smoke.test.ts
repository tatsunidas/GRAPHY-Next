// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 径プロファイルの帯の DOM の煙テスト: 実際に描画し、既定のまま（先頭区間）→ セレクタで枝へ → 未校正・全点 null・XA、を通す。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import type { VesselModel } from "../viewer/xaVesselModelStore";
import { DiameterProfileStrip } from "./DiameterProfileStrip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const z = (n: number, step: number, x = 0): number[][] => Array.from({ length: n }, (_, i) => [x, 0, i * step]);
function model(over: Record<string, unknown> = {}): VesselModel {
  return {
    runId: "plugin:t:1",
    kind: "ct-vessel",
    label: "t",
    stableKey: null,
    orientation: { proximalFirst: true, source: "user" },
    at: 0,
    segments: [
      // 幹: 径 4,4,2,4,4（2 mm の狭窄が弧長 6 mm）。1 mm 間隔で 3 点ごと = 3 mm 刻み
      { id: "trunk", name: "幹", points: z(5, 3), diameterMm: [4, 4, 2, 4, 4], parentId: null },
      // 枝: 先頭が測れていない（null）
      { id: "b1", points: z(4, 2, 10), diameterMm: [null, 3, 3.04, 3], parentId: "trunk" },
    ],
    calibration: { diameterCalibrated: true, sources: [], tiers: [], diameterMethod: "mask-equivalent-area" },
    provenance: { studyUid: "1", seriesUid: "2", frameOfReferenceUid: null, voxelSpacingMm: [0.5, 0.5, 0.5], maskOrigin: { type: "plugin" } },
    ...over,
  } as unknown as VesselModel;
}

async function render(m: VesselModel) {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(DiameterProfileStrip, { model: m })));
  });
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

describe("DiameterProfileStrip（煙テスト）", () => {
  it("既定のまま: 先頭区間の最小径が真値（2.0 mm・弧長 6.0 mm）。折れ線は 1 本", async () => {
    await render(model());
    expect(q("geometry3d-min-diameter")!.textContent).toBe("最小径 2.0 mm（弧長 6.0 mm）");
    const svg = q("geometry3d-diameter-profile")!;
    expect(svg.getAttribute("data-segment")).toBe("trunk");
    expect(svg.getAttribute("data-valid")).toBe("5");
    expect(svg.getAttribute("data-runs")).toBe("1");
    expect(svg.querySelectorAll("path")).toHaveLength(1);
  });

  it("セレクタで枝へ: 最小径・区間が変わる。🔴 先頭が null の点は線を引かない（点数 3 の 1 本）", async () => {
    await render(model());
    const sel = q("geometry3d-profile-segment") as HTMLSelectElement;
    expect([...sel.options].map((o) => o.textContent)).toEqual(["幹", "b1"]); // 名前が無ければ id
    await act(async () => {
      sel.value = "b1";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(q("geometry3d-profile-segment")).toBeTruthy();
    const svg = q("geometry3d-diameter-profile")!;
    expect(svg.getAttribute("data-segment")).toBe("b1");
    expect(svg.getAttribute("data-valid")).toBe("3");
    expect(q("geometry3d-min-diameter")!.textContent).toBe("最小径 3.0 mm（弧長 2.0 mm）");
    // 先頭の点（弧長 0）は測れていない: 線の始点は弧長 2 mm の位置（全長 6 mm の 1/3 → x≈333）
    const d = svg.querySelector("path")!.getAttribute("d")!;
    expect(d.startsWith("M333.33")).toBe(true);
  });

  it("途中が null の区間は線が 2 本に分かれる", async () => {
    const m = model();
    (m.segments[0] as { diameterMm: (number | null)[] }).diameterMm = [4, null, 2, 4, 4];
    await render(m);
    expect(q("geometry3d-diameter-profile")!.getAttribute("data-runs")).toBe("2");
    expect(q("geometry3d-diameter-profile")!.querySelectorAll("path, circle")).toHaveLength(2);
    // 1 点だけ測れた run は消さずに点として出す
    expect(q("geometry3d-diameter-profile")!.querySelectorAll("circle")).toHaveLength(1);
  });

  it("負例: 未校正なら帯の代わりに注記だけ（折れ線なし）", async () => {
    const m = model({ calibration: { diameterCalibrated: false, sources: [], tiers: ["uncalibrated"], diameterMethod: null } });
    await render(m);
    expect(q("geometry3d-diameter-uncalibrated")).toBeTruthy();
    expect(q("geometry3d-diameter-profile")).toBeNull();
    expect(q("geometry3d-min-diameter")).toBeNull();
  });

  it("負例: 全点 null は「測れた点がありません」（折れ線も最小径もない）", async () => {
    const m = model();
    (m.segments[0] as { diameterMm: (number | null)[] }).diameterMm = [null, null, null, null, null];
    await render(m);
    expect(q("geometry3d-diameter-none")).toBeTruthy();
    expect(q("geometry3d-diameter-profile")).toBeNull();
    expect(q("geometry3d-min-diameter")).toBeNull();
  });

  it("負例: XA のモデルには何も出さない（従来どおり）", async () => {
    await render(model({ kind: "xa-qca3d" }));
    expect(q("geometry3d-profile-strip")).toBeNull();
    expect(host.innerHTML).toBe("");
  });
});
