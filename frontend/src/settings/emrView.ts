/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 環境設定 ＞ 電子カルテ連携の表示用の純関数（画面から切り離してテストする）。検査は backend の EmrConfig と同じ規則。

export type EmrFormat = "" | "csv" | "bat" | "auto";
export type EmrCharset = "" | "UTF-8" | "Shift_JIS";
export type EmrRetrieve = "" | "move" | "get";

/** backend の取り込みの状態（`EmrPrefetchService.FetchState`）。 */
export interface EmrFetch {
  /** idle / finding / retrieving / done / not-found / error */
  state: string;
  patientId: string | null;
  found: number;
  retrieved: number;
  latestStudyUid: string | null;
  latestReady: boolean;
  error: string | null;
}

/** backend の状態（`GET /api/emr/status`）。 */
export interface EmrStatus {
  enabled: boolean;
  valid: boolean;
  errors: string[];
  autoOpen: boolean;
  /** state: disabled / invalid / missing / error / ok */
  file: { state: string; error: string | null; lastReadAt: number | null };
  patient: { id: string; seq: number; changedAt: number } | null;
  fetch: EmrFetch;
}

export interface EmrCheck {
  ok: boolean;
  error: string | null;
  /** 先頭と末尾の数文字だけ（全文は返らない）。 */
  hint: string | null;
}

/** 入力欄の文字列（空は未入力）。 */
export interface EmrForm {
  enabled: boolean;
  path: string;
  format: EmrFormat;
  charset: EmrCharset;
  csvColumn: string;
  csvHeader: boolean;
  batVar: string;
  autoOpen: boolean;
  pacsAe: string;
  retrieve: EmrRetrieve;
  years: string;
  timeoutSec: string;
}

const K = {
  enabled: "emr.watch.enabled",
  path: "emr.watch.path",
  format: "emr.watch.format",
  charset: "emr.watch.charset",
  csvColumn: "emr.watch.csv.column",
  csvHeader: "emr.watch.csv.header",
  batVar: "emr.watch.bat.var",
  autoOpen: "emr.watch.autoOpen",
  pacsAe: "emr.watch.pacs.ae",
  retrieve: "emr.watch.retrieve",
  years: "emr.watch.years",
  timeoutSec: "emr.watch.timeoutSec",
} as const;

export function formFromSettings(s: Record<string, string>): EmrForm {
  const g = (k: string) => (s[k] ?? "").trim();
  return {
    enabled: g(K.enabled) === "true",
    path: g(K.path),
    format: (["csv", "bat", "auto"].includes(g(K.format)) ? g(K.format) : "") as EmrFormat,
    charset: (["UTF-8", "Shift_JIS"].includes(g(K.charset)) ? g(K.charset) : "") as EmrCharset,
    csvColumn: g(K.csvColumn),
    csvHeader: g(K.csvHeader) !== "false", // 既定は見出しあり
    batVar: g(K.batVar),
    autoOpen: g(K.autoOpen) === "true",
    pacsAe: g(K.pacsAe),
    retrieve: (["move", "get"].includes(g(K.retrieve)) ? g(K.retrieve) : "") as EmrRetrieve,
    years: g(K.years),
    timeoutSec: g(K.timeoutSec),
  };
}

/** 保存する値。空欄は空文字（backend は空を「未設定」として読む）。 */
export function toSettings(f: EmrForm): Record<string, string> {
  return {
    [K.enabled]: f.enabled ? "true" : "false",
    [K.path]: f.path.trim(),
    [K.format]: f.format,
    [K.charset]: f.charset,
    [K.csvColumn]: f.csvColumn.trim(),
    [K.csvHeader]: f.csvHeader ? "true" : "false",
    [K.batVar]: f.batVar.trim(),
    [K.autoOpen]: f.autoOpen ? "true" : "false",
    [K.pacsAe]: f.pacsAe.trim(),
    [K.retrieve]: f.retrieve,
    [K.years]: f.years.trim(),
    [K.timeoutSec]: f.timeoutSec.trim(),
  };
}

function badInt(v: string): boolean {
  const s = v.trim();
  return s !== "" && !(/^\d+$/.test(s) && Number(s) >= 1);
}

/** 入力の不備のコード（backend の EmrConfig.errors と同じ名前）。有効にしないときは数の形式だけ見る。 */
export function formErrors(f: EmrForm): string[] {
  const e: string[] = [];
  if (badInt(f.years)) e.push("years-invalid");
  if (badInt(f.timeoutSec)) e.push("timeout-invalid");
  if (!f.enabled) return e;
  if (!f.path.trim()) e.push("path-required");
  if (f.format === "") e.push("format-required");
  if (f.charset === "") e.push("charset-required");
  if (f.format === "csv" && !f.csvColumn.trim()) e.push("csv-column-required");
  if (f.format === "bat" && !f.batVar.trim()) e.push("bat-var-required");
  if (f.format === "auto" && !f.csvColumn.trim() && !f.batVar.trim()) e.push("column-or-var-required");
  if (!f.pacsAe.trim()) e.push("pacs-ae-required");
  if (f.retrieve === "") e.push("retrieve-required");
  if (f.timeoutSec.trim() === "") e.push("timeout-required");
  return e;
}

export function canSave(f: EmrForm): boolean {
  return formErrors(f).length === 0;
}

const KNOWN_FILE_ERRORS = new Set([
  "file-missing", "path-unreadable", "read-failed", "not-a-file", "extension-not-allowed", "file-too-large",
  "decode-failed", "empty", "column-not-found", "csv-column-required", "csv-column-needs-number",
  "bat-var-required", "var-not-found", "id-empty", "id-invalid", "path-required",
]);
const KNOWN_FORM_ERRORS = new Set([
  "years-invalid", "timeout-invalid", "path-required", "format-required", "charset-required", "csv-column-required",
  "bat-var-required", "column-or-var-required", "pacs-ae-required", "retrieve-required", "timeout-required",
]);
const KNOWN_FETCH_ERRORS = new Set([
  "config", "pacs-ae-not-found", "find-failed", "unexpected", "latest-retrieve-failed", "latest-no-instances",
]);

/** ファイル・設定の異常のコード → i18n キー（未知のコードは汎用の文言）。 */
export function errorKey(code: string | null | undefined): string {
  if (!code) return "emr.err.unknown";
  if (KNOWN_FILE_ERRORS.has(code) || KNOWN_FORM_ERRORS.has(code)) return `emr.err.${code}`;
  return "emr.err.unknown";
}

/** 取り込みの異常のコード → i18n キー。`find-failed:DROPPED` のような分類つきは、分類ごとの文言。 */
export function fetchErrorKey(code: string | null | undefined): { key: string; vars?: Record<string, string> } {
  if (!code) return { key: "emr.fetchErr.unknown" };
  if (code.startsWith("find-failed:")) {
    const kind = code.slice("find-failed:".length);
    const known = ["SERVICE_REFUSED", "DROPPED", "STATUS_ERROR", "ASSOCIATION_REJECTED", "UNREACHABLE", "TIMEOUT"];
    return { key: known.includes(kind) ? `emr.fetchErr.find.${kind}` : "emr.fetchErr.find-failed" };
  }
  return { key: KNOWN_FETCH_ERRORS.has(code) ? `emr.fetchErr.${code}` : "emr.fetchErr.unknown" };
}

export type BarTone = "ok" | "warn" | "error" | "muted";

export interface EmrBar {
  visible: boolean;
  tone: BarTone;
  key: string;
  vars: Record<string, string | number>;
}

/**
 * 状態バーの「電子カルテ」欄。有効なときだけ visible。患者 ID は出さない（画面の隅に常に出ると、
 * 横から見えてしまう）。取り込みの進み具合と、読めない・つながらない理由を出す。
 */
export function barView(s: EmrStatus | null): EmrBar {
  const hidden: EmrBar = { visible: false, tone: "muted", key: "", vars: {} };
  if (!s || !s.enabled) return hidden;
  if (!s.valid) return { visible: true, tone: "error", key: "emr.bar.invalid", vars: {} };
  if (s.file.state === "missing" || s.file.state === "error") {
    return { visible: true, tone: "error", key: "emr.bar.file", vars: {} };
  }
  const f = s.fetch;
  switch (f.state) {
    case "finding":
      return { visible: true, tone: "muted", key: "emr.bar.finding", vars: {} };
    case "retrieving":
      return { visible: true, tone: "muted", key: "emr.bar.retrieving", vars: { done: f.retrieved, total: f.found } };
    case "done":
      return { visible: true, tone: "ok", key: "emr.bar.done", vars: { total: f.found } };
    case "not-found":
      return { visible: true, tone: "warn", key: "emr.bar.notFound", vars: {} };
    case "error":
      return { visible: true, tone: "error", key: "emr.bar.error", vars: {} };
    default:
      return { visible: true, tone: "muted", key: s.patient ? "emr.bar.watching" : "emr.bar.waiting", vars: {} };
  }
}
