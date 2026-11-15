// @vitest-environment jsdom
/*
 * 再サンプル・Fusion 計算ダイアログの DOM 煙テスト: 開く → loadRegVolume が NonUniformSliceSpacingError を投げる →
 * 断りの文言が画面に出て、[保存] は無効のまま。等間隔（体積が返る）では従来どおり有効になる。
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let mode: "throw" | "ok" = "throw";
vi.mock("@cornerstonejs/core", () => ({ metaData: { get: () => ({}) } }));
vi.mock("../viewer/pixelCalibration", () => ({ resolveValueUnit: () => "HU" }));
vi.mock("../viewer/regVolumeLoader", async (orig) => {
  const real = await orig<typeof import("../viewer/regVolumeLoader")>();
  return {
    ...real,
    // 素の関数。reject する vi.fn は spy が結果を未処理のまま持ち、テストが失敗扱いになる。
    loadRegVolume: () => (mode === "throw"
      ? Promise.reject(new real.NonUniformSliceSpacingError("missing", 2.5, 5, "x"))
      : Promise.resolve(fakeLoaded())),
  };
});

import { I18nProvider } from "../i18n/i18n";
import { ZERO_ADJUST } from "../viewer/regTransform";
import { ResampleDialog } from "./ResampleDialog";
import { FusionCalcDialog } from "./FusionCalcDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** LoadedRegVolume の形（実装の型どおり。2×2×3、間隔 1 mm）。 */
function fakeLoaded() {
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return {
    volume: { data: new Float32Array(12), dims: [2, 2, 3], spacing: [1, 1, 1], indexToWorld: m, worldToIndex: m, direction: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    iop: [1, 0, 0, 0, 1, 0], sliceStep: [0, 0, 1], frameOfReferenceUid: "1.9", modality: "CT",
    slices: [0, 1, 2].map((z) => ({ sopInstanceUid: String(z), ipp: [0, 0, z] })), firstImageId: null,
  };
}

const study = { studyInstanceUid: "1.1" } as never;
const series = { seriesInstanceUid: "1.2", seriesDescription: "S" } as never;
let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
async function mount(el: ReturnType<typeof createElement>) {
  await act(async () => { root.render(createElement(I18nProvider, null, el)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
}

beforeEach(() => {
  localStorage.setItem("graphy.locale", "ja");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

const resample = () => createElement(ResampleDialog, { study, series, instances: [], mode: "standalone", c: 0, t: 0, onClose: () => {} });
const fusion = () => {
  const src = { study, series, instances: [], c: 0, t: 0 };
  return createElement(FusionCalcDialog, { mode: "standalone", background: src, foreground: src, registration: null, adjust: ZERO_ADJUST, initialOp: "absdiff", onClose: () => {} });
};

describe("等間隔でないシリーズ（loadRegVolume が断る）", () => {
  it("再サンプル: 断りの文言が出て、[保存] は無効のまま", async () => {
    mode = "throw";
    await mount(resample());
    expect(q("resample-source")!.textContent).toContain("スライス間隔が一定でない");
    expect(q("resample-source")!.textContent).toContain("missing");
    expect(q("resample-source")!.textContent).toContain("2.50〜5.00 mm");
    expect((q("resample-save") as HTMLButtonElement).disabled).toBe(true);
  });
  it("Fusion 計算: 断りの文言が出て、[保存] は無効のまま", async () => {
    mode = "throw";
    await mount(fusion());
    expect(q("fusion-calc-source")!.textContent).toContain("スライス間隔が一定でない");
    expect((q("fusion-calc-save") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("等間隔（体積が返る）: 従来どおり", () => {
  it("再サンプル: 元の格子が出て、[保存] が有効になる", async () => {
    mode = "ok";
    await mount(resample());
    expect(q("resample-source")!.textContent).toContain("2×2×3");
    expect((q("resample-save") as HTMLButtonElement).disabled).toBe(false);
  });
  it("Fusion 計算: 背景・前景が出て、[保存] が有効になる", async () => {
    mode = "ok";
    await mount(fusion());
    expect(q("fusion-calc-source")!.textContent).toContain("2×2×3");
    expect((q("fusion-calc-save") as HTMLButtonElement).disabled).toBe(false);
  });
});
