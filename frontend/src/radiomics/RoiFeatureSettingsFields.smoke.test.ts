// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 設定欄の DOM 煙テスト: PET の校正の選択を、既定のまま・SUL・校正しない（警告）・VOI 統計の単独部品まで実際に操作して通す。
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { BatchSettingsPanel } from "./BatchSettingsPanel";
import { defaultSpecContent, type SpecQc } from "./batchSpec";
import { CalibrationField, RoiFeatureSettingsFields } from "./RoiFeatureSettingsFields";
import { defaultRoiFeatureForm, type RoiFeatureForm } from "./roiFeatureSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;
let latest: RoiFeatureForm;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function choose(id: string, value: string) {
  const el = q(id) as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function Full() {
  const [form, setForm] = useState(defaultRoiFeatureForm());
  latest = form;
  return createElement(RoiFeatureSettingsFields, {
    form, setForm, disabled: false, testIdPrefix: "batch", layout: { labelMinWidth: 110, align: "left" },
    showRange: true, showPreset: true, presetScale36: false,
  });
}
function Voi() {
  const [form, setForm] = useState(defaultRoiFeatureForm());
  latest = form;
  return createElement(CalibrationField, { form, setForm, disabled: false, testIdPrefix: "batch", layout: { labelMinWidth: 110, align: "left" } });
}
async function render(component: () => ReturnType<typeof createElement>) {
  await act(async () => {
    root.render(createElement(I18nProvider, null, createElement(component)));
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

describe("PET の校正の設定欄", () => {
  it("既定のまま通す: 校正は自動、警告は出ない、範囲に校正後の値の単位が出る", async () => {
    await render(Full);
    const sel = q("batch-calibration") as HTMLSelectElement;
    expect(sel).not.toBeNull();
    expect(sel.value).toBe("auto");
    expect(latest.calibration).toBe("auto");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["auto", "bw", "sul-james", "sul-janma", "bsa", "none"]);
    expect(q("batch-calibration-none-warn")).toBeNull();
    expect(q("batch-range-unit")?.textContent).toContain("校正後の値");
    expect(q("batch-calibration-help")?.textContent).toContain("校正後の値");
  });

  it("SUL を選ぶと値に反映され、校正しないを選ぶと警告が出て、戻すと消える", async () => {
    await render(Full);
    await choose("batch-calibration", "sul-james");
    expect(latest.calibration).toBe("sul-james");
    expect(q("batch-calibration-none-warn")).toBeNull();
    await choose("batch-calibration", "none");
    expect(latest.calibration).toBe("none");
    expect(q("batch-calibration-none-warn")?.textContent).toContain("Bq/mL");
    await choose("batch-calibration", "auto");
    expect(q("batch-calibration-none-warn")).toBeNull();
  });

  it("VOI 統計で使う単独の部品でも、同じ選択ができる", async () => {
    await render(Voi);
    expect(q("batch-range-unit")).toBeNull(); // 単独の部品には範囲の欄は無い
    await choose("batch-calibration", "bsa");
    expect(latest.calibration).toBe("bsa");
  });

  it("無効（実行中）のときは選べない", async () => {
    await act(async () => {
      root.render(createElement(I18nProvider, null, createElement(CalibrationField, {
        form: defaultRoiFeatureForm(), setForm: () => undefined, disabled: true, testIdPrefix: "roifeat",
        layout: { labelMinWidth: 150, align: "right" },
      })));
    });
    expect((q("roifeat-calibration") as HTMLSelectElement).disabled).toBe(true);
  });
});

async function typeInto(id: string, value: string) {
  const el = q(id) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function click(id: string) {
  await act(async () => { (q(id) as HTMLInputElement).click(); });
}

describe("値の種類の設定欄", () => {
  it("既定のまま通す: 自動、ビン幅は空（既定）、丸めは off、警告は出ない", async () => {
    await render(Full);
    const sel = q("batch-valuekind") as HTMLSelectElement;
    expect(sel.value).toBe("auto");
    expect(latest.valueKind).toBe("auto");
    expect(Array.from(sel.options).map((o) => o.value)).toEqual(["auto", "discrete", "continuous", "arbitrary", "legacy"]);
    expect((q("batch-ivh-binwidth") as HTMLInputElement).value).toBe("");
    expect(latest.intensityRounding).toBe(false);
    expect((q("batch-rounding") as HTMLInputElement).checked).toBe(false);
    expect(q("batch-ivh-binwidth-warn")).toBeNull();
    expect(q("batch-valuekind-help")?.textContent).toContain("ADC");
  });

  it("種類を選ぶと、関係する欄だけが出入りする（離散: 丸め、連続: ビン幅、任意単位・従来: どちらも無い）", async () => {
    await render(Full);
    await choose("batch-valuekind", "discrete");
    expect(latest.valueKind).toBe("discrete");
    expect(q("batch-rounding")).not.toBeNull();
    expect(q("batch-ivh-binwidth")).toBeNull();
    await choose("batch-valuekind", "continuous");
    expect(q("batch-ivh-binwidth")).not.toBeNull();
    expect(q("batch-rounding")).toBeNull();
    await choose("batch-valuekind", "arbitrary");
    expect(q("batch-ivh-binwidth")).toBeNull();
    expect(q("batch-rounding")).toBeNull();
    await choose("batch-valuekind", "legacy");
    expect(latest.valueKind).toBe("legacy");
    expect(q("batch-valuekind-help")?.textContent).toContain("判定しません");
  });

  it("ビン幅と丸めの入力が値に反映され、不正なビン幅は警告が出る", async () => {
    await render(Full);
    await typeInto("batch-ivh-binwidth", "0.25");
    expect(latest.ivhBinWidthText).toBe("0.25");
    expect(q("batch-ivh-binwidth-warn")).toBeNull();
    await typeInto("batch-ivh-binwidth", "-1");
    expect(q("batch-ivh-binwidth-warn")).not.toBeNull();
    await typeInto("batch-ivh-binwidth", "abc");
    expect(q("batch-ivh-binwidth-warn")).not.toBeNull();
    await typeInto("batch-ivh-binwidth", "");
    expect(q("batch-ivh-binwidth-warn")).toBeNull();
    await click("batch-rounding");
    expect(latest.intensityRounding).toBe(true);
  });
});

describe("詳細設定（上級者向け）", () => {
  const typeArea = async (id: string, value: string) => {
    const el = q(id) as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const openDetails = async (id: string) => {
    const el = q(id) as HTMLDetailsElement;
    await act(async () => { el.open = true; el.dispatchEvent(new Event("toggle")); });
  };
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  it("既定のまま通す: 空で、エラーは出ず、閉じている", async () => {
    await render(Full);
    expect((q("batch-advanced-text") as HTMLTextAreaElement).value).toBe("");
    expect(latest.advancedText).toBe("");
    expect(q("batch-advanced-errors")).toBeNull();
    expect((q("batch-advanced") as HTMLDetailsElement).open).toBe(false);
  });

  it("書いた値がフォームに入り、他の欄のキー・形の誤りは理由つきで出る（スキーマなしでも）", async () => {
    globalThis.fetch = (() => Promise.reject(new Error("offline"))) as typeof fetch;
    await render(Full);
    await typeArea("batch-advanced-text", "INT_deltaGLCM=2\nINT_binCount=5\nbad line");
    expect(latest.advancedText).toBe("INT_deltaGLCM=2\nINT_binCount=5\nbad line");
    const errs = q("batch-advanced-errors")?.textContent ?? "";
    expect(errs).toContain("INT_binCount");
    expect(errs).toContain("離散化"); // 離散化の欄で指定する、という理由
    expect(errs).toContain("3 行目");
    await openDetails("batch-advanced-defaults");
    expect(q("batch-advanced-defaults")?.textContent).toContain("読み込めません");
    await typeArea("batch-advanced-text", "INT_deltaGLCM=2");
    expect(q("batch-advanced-errors")).toBeNull();
    expect((q("batch-advanced") as HTMLDetailsElement).open).toBe(true); // 書いてあれば開く
  });

  it("スキーマがあれば、知らないキーと値の型も検査し、既定値の一覧から行を追加できる", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify([
      { key: "INT_deltaGLCM", type: "int", defaultValue: "1" },
      { key: "DOUBLE_zScore", type: "double", defaultValue: "3.0" },
      { key: "INT_binCount", type: "int", defaultValue: "32" },
    ]), { status: 200, headers: { "Content-Type": "application/json" } }))) as typeof fetch;
    await render(Full);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    await typeArea("batch-advanced-text", "BOGUS_key=1\nDOUBLE_zScore=abc");
    const errs = q("batch-advanced-errors")?.textContent ?? "";
    expect(errs).toContain("BOGUS_key");
    expect(errs).toContain("DOUBLE_zScore");
    await typeArea("batch-advanced-text", "");
    expect(q("batch-advanced-add-INT_deltaGLCM")).toBeNull(); // 閉じている間は一覧を描かない
    await openDetails("batch-advanced-defaults");
    expect(q("batch-advanced-add-INT_deltaGLCM")).not.toBeNull();
    expect(q("batch-advanced-add-INT_binCount")).toBeNull(); // 他の欄が決めるキーは一覧に出さない
    await act(async () => { (q("batch-advanced-add-INT_deltaGLCM") as HTMLButtonElement).click(); });
    expect(latest.advancedText).toBe("INT_deltaGLCM=1");
  });
});

describe("QC の 3 択", () => {
  function Panel({ qc0 }: { qc0: SpecQc }) {
    const [form, setForm] = useState(defaultRoiFeatureForm());
    const [qc, setQc] = useState(qc0);
    qcLatest = qc;
    return createElement(BatchSettingsPanel, {
      form, setForm, disabled: false, qc, setQc, labelsText: "", setLabelsText: () => {}, kind: "radiomics", setKind: () => {},
    });
  }
  let qcLatest: SpecQc;
  const radios = (id: string) => Array.from(q(id)!.querySelectorAll<HTMLInputElement>("input[type=radio]"));

  it("印を付けて続ける・止める・スキップの 3 つ。選ぶと値に入り、定義の既定は FLAG のまま", async () => {
    await render(() => createElement(Panel, { qc0: defaultSpecContent().qc }));
    expect(radios("batch-qc-small").length).toBe(3);
    expect(radios("batch-qc-lossy").length).toBe(3);
    expect(radios("batch-qc-small").map((r) => r.checked)).toEqual([true, false, false]);
    await act(async () => { radios("batch-qc-small")[2].click(); });
    expect(qcLatest.smallRoi).toBe("SKIP");
    expect(qcLatest.lossy).toBe("FLAG");
    await act(async () => { radios("batch-qc-lossy")[1].click(); });
    expect(qcLatest.lossy).toBe("STOP");
    expect(q("batch-qc")?.textContent).toContain("スキップ");
  });
});

describe("設定の群（折りたたみ）", () => {
  const open = (id: string) => (q(`batch-group-${id}`) as HTMLDetailsElement).open;

  it("既定: ① 計算する内容・② 前処理は開き、③ 値の扱いは閉じる。要約が値に追従し、既定のままなら印は出ない", async () => {
    await render(Full);
    expect(open("content")).toBe(true);
    expect(open("preprocess")).toBe(true);
    expect(open("values")).toBe(false);
    expect(q("batch-group-values-summary")?.textContent).toContain("校正 自動");
    expect(q("batch-group-values-summary")?.textContent).toContain("値の種類 自動");
    expect(q("batch-group-values-summary")?.textContent).toContain("丸め なし");
    expect(q("batch-group-preprocess-summary")?.textContent).toContain("等方 1 mm");
    expect(q("batch-group-preprocess-summary")?.textContent).toContain("ビン数 32");
    expect(q("batch-group-values-changed")).toBeNull();
    // 閉じた群の中の入力も DOM に残る（検査・読み込みで触れる）
    expect(q("batch-calibration")).not.toBeNull();
    expect(q("batch-valuekind")).not.toBeNull();
  });

  it("値を既定から変えると、要約が追従し、閉じたままでも「既定と異なる」の印が出る（要約は固定値ではない）", async () => {
    await render(Full);
    await choose("batch-calibration", "sul-james");
    expect(q("batch-group-values-summary")?.textContent).toContain("校正 SUL");
    expect(q("batch-group-values-summary")?.textContent).not.toContain("校正 自動");
    expect(q("batch-group-values-changed")).not.toBeNull();
    expect(open("values")).toBe(false);
    await choose("batch-calibration", "auto");
    expect(q("batch-group-values-changed")).toBeNull();
    await choose("batch-resampling", "none");
    expect(q("batch-group-preprocess-summary")?.textContent).toContain("リサンプリング なし");
  });

  it("要約の間隔は、浮動小数点の端数を出さない（0.35000000000000003 を 0.35 と書く）", async () => {
    function Odd() {
      const [form, setForm] = useState<RoiFeatureForm>({ ...defaultRoiFeatureForm(), resampleMm: 0.35000000000000003 });
      latest = form;
      return createElement(RoiFeatureSettingsFields, { form, setForm, disabled: false, testIdPrefix: "batch", layout: { labelMinWidth: 110, align: "left" }, showRange: true, showPreset: true });
    }
    await render(Odd);
    expect(String(latest.resampleMm)).toBe("0.35000000000000003"); // 入力欄の操作で実際に出た値（実アプリの検査のスクリーンショット）
    expect(q("batch-group-preprocess-summary")?.textContent).toContain("等方 0.35 mm");
  });

  it("IVH のビン幅に誤りを入れると、閉じた ③ が自動で開き、赤の印が出る。直すと印は消える", async () => {
    await render(Full);
    expect(open("values")).toBe(false);
    await choose("batch-valuekind", "continuous");
    await typeInto("batch-ivh-binwidth", "abc");
    expect(q("batch-group-values-error")).not.toBeNull();
    expect(open("values")).toBe(true);
    await typeInto("batch-ivh-binwidth", "0.1");
    expect(q("batch-group-values-error")).toBeNull();
  });

  it("一括抽出のパネル: ④ QC は既定で閉じ、止めるに変えると印が出る。計算の単位は ① の中にある", async () => {
    function Panel() {
      const [form, setForm] = useState(defaultRoiFeatureForm());
      const [qc, setQc] = useState<SpecQc>(defaultSpecContent().qc);
      const [labels, setLabels] = useState("");
      const [kind, setKind] = useState<"radiomics" | "voiStats">("radiomics");
      return createElement(BatchSettingsPanel, { form, setForm, disabled: false, qc, setQc, labelsText: labels, setLabelsText: setLabels, kind, setKind });
    }
    await render(Panel);
    expect(open("qc")).toBe(false);
    expect(q("batch-group-qc-summary")?.textContent).toContain("小さい ROI 印のみ");
    expect(q("batch-group-qc-changed")).toBeNull();
    expect(q("batch-group-content")?.contains(q("batch-units"))).toBe(true);
    expect(q("batch-group-content-summary")?.textContent).toContain("全腫瘍（3D）");
    await click("batch-unit-SLICES_2D");
    expect(q("batch-group-content-summary")?.textContent).toContain("スライス別（2D）");
    const stop = host.querySelector<HTMLInputElement>('[data-testid="batch-qc-small"] input[type="radio"]:nth-of-type(1)');
    expect(stop).not.toBeNull();
    const radios = host.querySelectorAll<HTMLInputElement>('[data-testid="batch-qc-small"] input[type="radio"]');
    await act(async () => { radios[1].click(); });
    expect(q("batch-group-qc-summary")?.textContent).toContain("小さい ROI 止める");
    expect(q("batch-group-qc-changed")).not.toBeNull();
  });
});
