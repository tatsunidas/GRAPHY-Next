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
