/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { en } from "../i18n/en";
import { ja } from "../i18n/ja";
import {
  barView, canSave, errorKey, fetchErrorKey, formErrors, formFromSettings, toSettings,
  type EmrForm, type EmrStatus,
} from "./emrView";

const base: EmrForm = {
  enabled: true, path: "C:\\emr\\pid.csv", format: "csv", charset: "Shift_JIS", csvColumn: "患者ID", csvHeader: true,
  batVar: "", autoOpen: true, pacsAe: "PACS", retrieve: "move", years: "", timeoutSec: "120",
};

const status = (over: Partial<EmrStatus> = {}, fetch: Partial<EmrStatus["fetch"]> = {}): EmrStatus => ({
  enabled: true, valid: true, errors: [], autoOpen: true,
  file: { state: "ok", error: null, lastReadAt: 1 },
  patient: { id: "P1", seq: 1, changedAt: 1 },
  fetch: { state: "idle", patientId: null, found: 0, retrieved: 0, latestStudyUid: null, latestReady: false, error: null, ...fetch },
  ...over,
});

describe("設定の入出力", () => {
  it("保存した値を、そのまま画面の入力に戻せる（往復）", () => {
    expect(formFromSettings(toSettings(base))).toEqual(base);
    expect(formFromSettings(toSettings({ ...base, format: "bat", batVar: "PID", csvColumn: "", years: "3" })))
      .toMatchObject({ format: "bat", batVar: "PID", years: "3" });
  });
  it("何も保存していなければ、無効・選択なし（取得元に既定値を置かない）。CSV の見出しだけは「あり」が既定", () => {
    const f = formFromSettings({});
    expect(f).toMatchObject({ enabled: false, format: "", charset: "", pacsAe: "", retrieve: "", timeoutSec: "", autoOpen: false, csvHeader: true });
  });
  it("未知の値は「未選択」に落とす（黙って別の意味にしない）", () => {
    const f = formFromSettings({ "emr.watch.format": "xml", "emr.watch.charset": "EUC", "emr.watch.retrieve": "store" });
    expect(f).toMatchObject({ format: "", charset: "", retrieve: "" });
  });
});

describe("入力の不備（backend の EmrConfig と同じ規則）", () => {
  it("有効にしないときは、数の形式だけを見る", () => {
    expect(formErrors({ ...base, enabled: false, path: "", pacsAe: "" })).toEqual([]);
    expect(formErrors({ ...base, enabled: false, years: "0" })).toEqual(["years-invalid"]);
  });
  it("有効にしたら、必須が空のままでは保存できない", () => {
    const e = formErrors({ ...base, path: "", format: "", charset: "", pacsAe: "", retrieve: "", timeoutSec: "" });
    expect(e).toEqual(expect.arrayContaining(["path-required", "format-required", "charset-required", "pacs-ae-required", "retrieve-required", "timeout-required"]));
    expect(canSave({ ...base, pacsAe: "" })).toBe(false);
    expect(canSave(base)).toBe(true);
  });
  it("csv なら列、bat なら変数名が要る。auto はどちらか 1 つ", () => {
    expect(formErrors({ ...base, csvColumn: "" })).toContain("csv-column-required");
    expect(formErrors({ ...base, format: "bat", batVar: "" })).toContain("bat-var-required");
    expect(formErrors({ ...base, format: "auto", csvColumn: "", batVar: "" })).toContain("column-or-var-required");
    expect(formErrors({ ...base, format: "auto", csvColumn: "", batVar: "PID" })).toEqual([]);
  });
});

describe("状態バー", () => {
  it("無効・状態が取れないときは出さない", () => {
    expect(barView(null).visible).toBe(false);
    expect(barView(status({ enabled: false })).visible).toBe(false);
  });
  it("設定の不備・ファイルの異常は error。患者 ID は文言にも変数にも入らない", () => {
    expect(barView(status({ valid: false }))).toMatchObject({ visible: true, tone: "error", key: "emr.bar.invalid" });
    expect(barView(status({ file: { state: "missing", error: "file-missing", lastReadAt: null } }))).toMatchObject({ tone: "error", key: "emr.bar.file" });
    const v = barView(status({}, { state: "retrieving", patientId: "SECRET-ID", found: 5, retrieved: 2 }));
    expect(v).toMatchObject({ key: "emr.bar.retrieving", vars: { done: 2, total: 5 } });
    expect(JSON.stringify(v)).not.toContain("SECRET-ID");
  });
  it("取り込みの進み具合ごとの表示", () => {
    expect(barView(status({}, { state: "finding" })).key).toBe("emr.bar.finding");
    expect(barView(status({}, { state: "done", found: 3 }))).toMatchObject({ key: "emr.bar.done", tone: "ok" });
    expect(barView(status({}, { state: "not-found" }))).toMatchObject({ key: "emr.bar.notFound", tone: "warn" });
    expect(barView(status({}, { state: "error" }))).toMatchObject({ key: "emr.bar.error", tone: "error" });
    expect(barView(status({ patient: null })).key).toBe("emr.bar.waiting");
    expect(barView(status()).key).toBe("emr.bar.watching");
  });
});

describe("文言のキーが ja・en の両方にある", () => {
  it("異常のコード・状態・バー", () => {
    const keys = new Set<string>();
    for (const c of ["file-missing", "id-invalid", "pacs-ae-required", "years-invalid", "????", null]) keys.add(errorKey(c));
    for (const c of ["config", "pacs-ae-not-found", "find-failed:DROPPED", "find-failed:STATUS_ERROR", "find-failed:SERVICE_REFUSED",
      "find-failed:ASSOCIATION_REJECTED", "find-failed:UNREACHABLE", "find-failed:TIMEOUT", "find-failed:???", "find-failed",
      "latest-retrieve-failed", "latest-no-instances", "unexpected", "zzz", null]) keys.add(fetchErrorKey(c).key);
    for (const st of ["disabled", "invalid", "missing", "error", "ok"]) keys.add(`emr.status.file.${st}`);
    for (const st of ["idle", "finding", "retrieving", "done", "not-found", "error"]) keys.add(`emr.status.fetch.${st}`);
    for (const f of [{ state: "finding" }, { state: "retrieving" }, { state: "done" }, { state: "not-found" }, { state: "error" }, { state: "idle" }]) {
      keys.add(barView(status({}, f)).key);
    }
    keys.add(barView(status({ valid: false })).key);
    keys.add(barView(status({ patient: null })).key);
    for (const k of ["emr.open.button", "emr.open.hint", "emr.open.noPatient", "emr.open.none", "emr.open.timeout", "emr.open.failed", "emr.bar.label", "settings.cat.emr"]) keys.add(k);
    for (const k of keys) {
      expect(ja[k], `ja に無い: ${k}`).toBeTruthy();
      expect(en[k], `en に無い: ${k}`).toBeTruthy();
    }
  });
});
