// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// SUV 校正ダイアログの DOM 煙テスト: 既定のまま（SUVbw）・%ID/cc を選ぶ経路・投与量の範囲を実際に操作して通す。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import type { SuvParams } from "./suv";

vi.mock("@cornerstonejs/core", () => ({ metaData: { get: () => undefined } }));
vi.mock("@cornerstonejs/dicom-image-loader", () => ({ default: {} }));
// DICOM の読み出しだけを偽物にし、計算（computeSuvScale）は本物を使う。体重の無い小動物 PET を模す。
vi.mock("./suv", async (orig) => {
  const actual = await orig<typeof import("./suv")>();
  const fake: SuvParams = {
    patientWeight: undefined,
    patientHeight: undefined,
    patientSex: "M",
    totalDoseBq: 5e6,
    halfLifeSec: 6586.2,
    radionuclideName: "Fluorine-18",
    injectionTimeMs: Date.UTC(2026, 6, 27, 9, 0, 0),
    scanTimeMs: Date.UTC(2026, 6, 27, 10, 0, 0),
    units: "BQML",
    correctedImage: ["ATTN", "DECY"],
    alreadySuv: false,
    modality: "PT",
  };
  return { ...actual, extractSuvParams: () => ({ ...fake, ...(globalThis as { __fakeSuv?: Partial<SuvParams> }).__fakeSuv }) };
});

import type { RefMeasure } from "./suvr";

import type { SaveCalibratedInput, SaveCalibratedResult } from "./calibratedSeriesSaveRun";

const saveCalls: SaveCalibratedInput[] = [];
let saveResult: SaveCalibratedResult | Error = { ok: true, count: 21 };
let saveGate: Promise<void> | null = null;
vi.mock("./calibratedSeriesSaveRun", () => ({
  saveCalibratedSeries: async (i: SaveCalibratedInput) => {
    saveCalls.push(i);
    if (saveGate) await saveGate;
    if (saveResult instanceof Error) throw saveResult;
    return saveResult;
  },
}));

let fakeMeasures: RefMeasure[] = [];
vi.mock("./suvrReference", () => ({ loadReferenceMeasures: async () => fakeMeasures }));

import { SUVCalibrationDialog } from "./SUVCalibrationDialog";
import { getSuv, setSuv } from "./suvStore";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UID = "1.2.3";
let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

async function setInput(id: string, value: string) {
  const el = q(id) as HTMLInputElement | HTMLSelectElement;
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function apply() {
  await act(async () => {
    q("suv-apply").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  localStorage.setItem("graphy.locale", "ja");
  setSuv(UID, null);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  setSuv(UID, null);
});

const SAVE_CTX = {
  study: { studyInstanceUid: "1.2" },
  series: { seriesInstanceUid: UID, seriesDescription: "PET small animal" },
  instances: [],
  mode: "web",
  c: 0,
  t: 0,
} as unknown as import("./SUVCalibrationDialog").SuvSaveContext;

async function open(applied?: import("./suvStore").SuvCalibration | null, withSave = false) {
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(SUVCalibrationDialog, { imageId: "wadouri:x", seriesUid: UID, applied, saveCtx: withSave ? SAVE_CTX : undefined, onClose: () => {} }),
      ),
    );
  });
}

describe("SUVCalibrationDialog（煙テスト）", () => {
  it("既定のまま（SUVbw）: 体重が空なら適用できずエラー、校正は付かない", async () => {
    await open();
    expect((q("suv-type") as HTMLSelectElement).value).toBe("bw");
    await setInput("suv-dose", "5");
    await apply();
    expect(getSuv(UID)).toBeUndefined();
    expect(host.textContent).toContain("体重・投与量・半減期は必須です");
  });

  it("%ID/cc を選ぶ: 体重が空でも適用でき、単位 %ID/cc・scale は 100÷崩壊後投与量。身長欄は無効", async () => {
    await open();
    await setInput("suv-type", "pid");
    expect((q("suv-height") as HTMLInputElement).disabled).toBe(true);
    await setInput("suv-dose", "5");
    await apply();
    const cal = getSuv(UID)!;
    expect(cal.unit).toBe("%ID/cc");
    expect(cal.type).toBe("pid");
    const decayed = 5e6 * Math.exp((-Math.LN2 * 3600) / 6586.2);
    expect(Math.abs(cal.scale / (100 / decayed) - 1)).toBeLessThan(1e-9);
  });

  it("性別が不明の PET: 欄は「不明」、SUL は適用できずエラー。女性を選ぶと適用できる。SUVbw は性別不明でも適用できる", async () => {
    (globalThis as { __fakeSuv?: Partial<SuvParams> }).__fakeSuv = { patientWeight: 70, patientHeight: 1.75, patientSex: undefined, totalDoseBq: 370e6 };
    try {
      await open();
      expect((q("suv-sex") as HTMLSelectElement).value).toBe("");
      await setInput("suv-type", "sul-james");
      await apply();
      expect(getSuv(UID)).toBeUndefined();
      expect(host.textContent).toContain("性別（男性・女性）が必要");
      await setInput("suv-sex", "F");
      await apply();
      expect(getSuv(UID)?.type).toBe("sul-james");
      setSuv(UID, null);
      await setInput("suv-sex", "");
      await setInput("suv-type", "bw");
      await apply();
      expect(getSuv(UID)?.type).toBe("bw");
    } finally {
      delete (globalThis as { __fakeSuv?: Partial<SuvParams> }).__fakeSuv;
    }
  });

  it("投与量の範囲: %ID/cc は 0.005 MBq を拒否・0.05 MBq を受理。SUVbw は 0.05 MBq を拒否", async () => {
    await open();
    await setInput("suv-type", "pid");
    await setInput("suv-dose", "0.005");
    await apply();
    expect(getSuv(UID)).toBeUndefined();
    expect(host.textContent).toContain("0.01〜1000 MBq");
    await setInput("suv-dose", "0.05");
    await apply();
    expect(getSuv(UID)?.unit).toBe("%ID/cc");

    setSuv(UID, null);
    await setInput("suv-type", "bw");
    await setInput("suv-weight", "25");
    await apply();
    expect(getSuv(UID)).toBeUndefined(); // 0.05 MBq のまま: SUV 4 種の下限は従来の 1 MBq
    expect(host.textContent).toContain("1〜1000 MBq");
    await setInput("suv-dose", "5");
    await apply();
    expect(getSuv(UID)?.unit).toBe("SUVbw");
  });

  describe("SUVR", () => {
    const ok: RefMeasure = { key: "a", label: "小脳", group: false, mean: 500, n: 120, unit: "BQML" };
    it("SUVR を選ぶと SUV 用の欄が無効になり、参照の候補と平均が出る。適用すると参照の平均が 1 になる乗数・単位 SUVR・ref つき", async () => {
      fakeMeasures = [ok, { key: "b", label: "背景", group: false, mean: 100, n: 50, unit: "BQML" }];
      await open();
      await setInput("suv-type", "suvr");
      expect((q("suv-weight") as HTMLInputElement).disabled).toBe(true);
      expect((q("suv-dose") as HTMLInputElement).disabled).toBe(true);
      expect(host.querySelectorAll('[data-testid="suv-ref"] option')).toHaveLength(2);
      expect(q("suv-ref-note").textContent).toContain("500");
      await apply();
      const cal = getSuv(UID)!;
      expect(cal.unit).toBe("SUVR");
      expect(cal.type).toBe("suvr");
      expect(cal.ref).toEqual({ label: "小脳", mean: 500, unit: "BQML", n: 120 });
      expect(Math.abs(500 * cal.scale - 1)).toBeLessThan(1e-12);
    });
    it("参照を選び直せる（背景を参照にすると目的は別の値になる）", async () => {
      fakeMeasures = [ok, { key: "b", label: "背景", group: false, mean: 100, n: 50, unit: "BQML" }];
      await open();
      await setInput("suv-type", "suvr");
      await setInput("suv-ref", "b");
      await apply();
      expect(100 * getSuv(UID)!.scale).toBeCloseTo(1, 12);
      expect(getSuv(UID)!.ref!.label).toBe("背景");
    });
    it("候補なしは適用できず理由が出る（負例）", async () => {
      fakeMeasures = [];
      await open();
      await setInput("suv-type", "suvr");
      expect((q("suv-apply") as HTMLButtonElement).disabled).toBe(true);
      expect(q("suv-ref-note").textContent).toContain("参照にできる ROI");
      await apply();
      expect(getSuv(UID)).toBeUndefined();
    });
    it("参照の平均が 0 以下は適用できず理由が出る（負例）", async () => {
      fakeMeasures = [{ key: "z", label: "空", group: false, mean: 0, n: 10, unit: "BQML", reason: "refNotPositive" }];
      await open();
      await setInput("suv-type", "suvr");
      expect((q("suv-apply") as HTMLButtonElement).disabled).toBe(true);
      expect(q("suv-ref-note").textContent).toContain("0 以下");
      expect(getSuv(UID)).toBeUndefined();
    });
    it("SUV 化済み（GML）の画像でも SUVR だけは作れる。種類は SUVR だけで、%ID/cc は選べない", async () => {
      (globalThis as { __fakeSuv?: Partial<SuvParams> }).__fakeSuv = { units: "GML", alreadySuv: true };
      try {
        fakeMeasures = [{ key: "a", label: "小脳", group: false, mean: 2.5, n: 120, unit: "GML" }];
        await open();
        const opts = [...host.querySelectorAll('[data-testid="suv-type"] option')].map((o) => (o as HTMLOptionElement).value);
        expect(opts).toEqual(["suvr"]);
        await apply();
        const cal = getSuv(UID)!;
        expect(cal.unit).toBe("SUVR");
        expect(Math.abs(2.5 * cal.scale - 1)).toBeLessThan(1e-12); // 今の乗数は 1 とみなす
      } finally {
        delete (globalThis as { __fakeSuv?: Partial<SuvParams> }).__fakeSuv;
      }
    });
    it("すでに SUV を掛けてある状態から適用しても、参照の平均（SUV 値）が 1 になる", async () => {
      // 現在の乗数 3e-4。統計は校正込みで返るので、参照 500 Bq/mL は 0.15 SUV。
      fakeMeasures = [{ key: "a", label: "小脳", group: false, mean: 0.15, n: 120, unit: "SUVbw" }];
      await open({ scale: 3e-4, unit: "SUVbw", type: "bw" });
      await setInput("suv-type", "suvr");
      await apply();
      expect(Math.abs(500 * getSuv(UID)!.scale - 1)).toBeLessThan(1e-9);
    });
  });

  describe("校正値を派生シリーズとして保存", () => {
    const click = async (id: string) => {
      await act(async () => {
        q(id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
    };
    it("保存先が無ければボタンを出さない。校正が無ければ押せず理由が出る（負例）", async () => {
      saveCalls.length = 0;
      await open(null, false);
      expect(host.querySelector('[data-testid="suv-save-derived"]')).toBeNull();
      await open(null, true);
      expect((q("suv-save-derived") as HTMLButtonElement).disabled).toBe(true);
      expect(q("suv-save-hint").textContent).toContain("先に校正を適用");
      await click("suv-save-derived");
      expect(saveCalls).toHaveLength(0);
    });
    it("適用中の校正があれば押せ、その校正（未適用の編集ではなく）を 1 回だけ保存に渡す。結果が出る", async () => {
      saveCalls.length = 0;
      saveResult = { ok: true, count: 21 };
      const cal = { scale: 0.002, unit: "SUVR", type: "suvr" as const, ref: { label: "小脳", mean: 500, unit: "BQML", n: 120 } };
      await open(cal, true);
      // ダイアログ内の未適用の編集（タイプを %ID/cc にする）は保存に影響しない
      await setInput("suv-type", "pid");
      expect((q("suv-save-derived") as HTMLButtonElement).disabled).toBe(false);
      await click("suv-save-derived");
      expect(saveCalls).toHaveLength(1);
      expect(saveCalls[0].cal).toEqual(cal);
      expect(saveCalls[0].series.seriesInstanceUid).toBe(UID);
      expect(q("suv-save-msg").textContent).toContain("21 枚");
    });
    it("保存中は二重に押せない", async () => {
      saveCalls.length = 0;
      let release!: () => void;
      saveGate = new Promise<void>((r) => (release = r));
      try {
        await open({ scale: 1e-3, unit: "%ID/cc", type: "pid" }, true);
        await click("suv-save-derived");
        expect((q("suv-save-derived") as HTMLButtonElement).disabled).toBe(true);
        await click("suv-save-derived");
        expect(saveCalls).toHaveLength(1);
      } finally {
        release();
        saveGate = null;
        await act(async () => {});
      }
    });
    it("元が不均一・失敗は理由を赤字で出す", async () => {
      saveResult = { ok: false, reason: "nonUniform" };
      await open({ scale: 1e-3, unit: "%ID/cc", type: "pid" }, true);
      await click("suv-save-derived");
      expect(q("suv-save-msg").textContent).toContain("スライス間隔が一定でない");
      saveResult = new Error("boom");
      await click("suv-save-derived");
      expect(q("suv-save-msg").textContent).toContain("保存に失敗しました: Error: boom");
    });
  });
});
