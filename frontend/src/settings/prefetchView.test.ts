/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  canSave,
  configCodes,
  errorKey,
  formErrors,
  formFromSettings,
  parseTimes,
  runStatusKey,
  toSettings,
  triggerKey,
  type PrefetchForm,
} from "./prefetchView";

const empty = formFromSettings({});

function csvForm(over: Partial<PrefetchForm> = {}): PrefetchForm {
  return {
    ...empty,
    enabled: true,
    source: "csv",
    targetDay: "tomorrow",
    times: "07:00, 18:30",
    csvFolder: "C:/ris",
    csvCharset: "Shift_JIS",
    csvColPatientId: "患者ID",
    pacsAe: "PACS",
    retrieve: "move",
    timeoutSec: "600",
    ...over,
  };
}

describe("formFromSettings / toSettings", () => {
  it("保存していない設定は空の入力欄で、無効", () => {
    expect(empty.enabled).toBe(false);
    expect(empty.source).toBe("");
    expect(canSave(empty)).toBe(true); // 無効のままなら保存できる（必須は見ない）
  });

  it("保存した値を往復しても変わらない", () => {
    const f = csvForm({ years: "5", modalities: "CT, MR", maxStudies: "3", catchUp: true });
    expect(formFromSettings(toSettings(f))).toEqual(f);
  });

  it("未知の選択肢の値は空に戻す（黙って別の意味にしない）", () => {
    const f = formFromSettings({ "prefetch.source": "ftp", "prefetch.csv.charset": "EUC-JP", "prefetch.retrieve": "x" });
    expect([f.source, f.csvCharset, f.retrieve]).toEqual(["", "", ""]);
  });
});

describe("parseTimes", () => {
  it("カンマ・空白区切りで昇順・重複なし、1 桁の時も読む", () => {
    expect(parseTimes("18:30, 7:00 18:30")).toEqual(["07:00", "18:30"]);
    expect(parseTimes("")).toEqual([]);
  });
  it("負例: 範囲外や形式違いは null", () => {
    expect(parseTimes("24:00")).toBeNull();
    expect(parseTimes("07:60")).toBeNull();
    expect(parseTimes("7時")).toBeNull();
    expect(parseTimes("07:00, abc")).toBeNull();
  });
});

describe("formErrors / canSave", () => {
  it("正例: 必須がそろっていれば保存できる", () => {
    expect(formErrors(csvForm())).toEqual([]);
    expect(canSave(csvForm())).toBe(true);
  });

  it("有効にして何も入れていなければ、backend と同じ名前の不備が並ぶ", () => {
    const e = formErrors({ ...empty, enabled: true });
    expect(e).toEqual(
      expect.arrayContaining([
        "source-required",
        "targetDay-required",
        "times-required",
        "pacs-ae-required",
        "retrieve-required",
        "timeout-required",
      ]),
    );
    expect(canSave({ ...empty, enabled: true })).toBe(false);
  });

  it("MWL を選ぶと MWL サーバーが、CSV を選ぶと CSV の項目が必須になる", () => {
    expect(formErrors(csvForm({ source: "mwl" }))).toEqual(["mwl-ae-required"]);
    expect(formErrors(csvForm({ csvFolder: "", csvCharset: "", csvColPatientId: "" }))).toEqual([
      "csv-folder-required",
      "csv-charset-required",
      "csv-col-id-required",
    ]);
  });

  it("負例: 無効のままでも、数と時刻の形式の誤りは保存させない", () => {
    expect(formErrors({ ...empty, years: "0", maxStudies: "x", timeoutSec: "-1", times: "99:99" })).toEqual([
      "times-invalid",
      "years-invalid",
      "maxStudies-invalid",
      "timeout-invalid",
    ]);
  });
});

describe("コード → 文言のキー", () => {
  it("既知のコードは専用の文言、未知は汎用", () => {
    expect(errorKey("csv-no-id-column")).toBe("prefetch.err.csv-no-id-column");
    expect(errorKey("pacs-find-failed")).toBe("prefetch.err.pacs-find-failed");
    expect(errorKey("something-new")).toBe("prefetch.err.unknown");
    expect(errorKey(null)).toBe("prefetch.err.unknown");
  });
  it("config: は設定の不備にまとめ、コードを取り出せる", () => {
    expect(errorKey("config:source-required,times-required")).toBe("prefetch.err.config");
    expect(configCodes("config:source-required,times-required")).toEqual(["source-required", "times-required"]);
    expect(configCodes("csv-empty")).toEqual([]);
  });
  it("実行の結果と契機", () => {
    expect(runStatusKey("INTERRUPTED")).toBe("prefetch.run.INTERRUPTED");
    expect(runStatusKey("???")).toBe("prefetch.run.unknown");
    expect(triggerKey("SCHEDULE")).toBe("prefetch.trigger.schedule");
    expect(triggerKey("x")).toBe("prefetch.trigger.unknown");
  });
});
