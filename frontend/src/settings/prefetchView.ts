/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 環境設定 ＞ 事前取得の表示用の純関数（画面から切り離してテストする）。検査は backend の PrefetchConfig と同じ規則。

import { formatDicomDate } from "../i18n/dateFormat";

export type PrefetchSource = "" | "mwl" | "csv";
export type PrefetchTargetDay = "" | "today" | "tomorrow" | "both";
export type PrefetchCharset = "" | "UTF-8" | "Shift_JIS";
export type PrefetchRetrieve = "" | "move" | "get";

export interface PrefetchRun {
  id: number;
  slotKey: string;
  trigger: string;
  startedAt: number;
  finishedAt: number | null;
  status: string;
  targetDays: string | null;
  patients: number;
  found: number;
  retrieved: number;
  existing: number;
  failed: number;
  pending: number;
  error: string | null;
}

/** backend の状態（`GET /api/prefetch/status`）。 */
export interface PrefetchStatus {
  enabled: boolean;
  valid: boolean;
  errors: string[];
  running: boolean;
  runs: PrefetchRun[];
}

/** 入力欄の文字列（空は未入力）。 */
export interface PrefetchForm {
  enabled: boolean;
  source: PrefetchSource;
  targetDay: PrefetchTargetDay;
  times: string;
  catchUp: boolean;
  mwlAe: string;
  mwlStation: string;
  mwlModality: string;
  csvFolder: string;
  csvCharset: PrefetchCharset;
  csvColPatientId: string;
  csvColDate: string;
  pacsAe: string;
  retrieve: PrefetchRetrieve;
  years: string;
  modalities: string;
  maxStudies: string;
  timeoutSec: string;
}

const K = {
  enabled: "prefetch.enabled",
  source: "prefetch.source",
  targetDay: "prefetch.targetDay",
  times: "prefetch.times",
  catchUp: "prefetch.catchUpOnStartup",
  mwlAe: "prefetch.mwl.ae",
  mwlStation: "prefetch.mwl.station",
  mwlModality: "prefetch.mwl.modality",
  csvFolder: "prefetch.csv.folder",
  csvCharset: "prefetch.csv.charset",
  csvColPatientId: "prefetch.csv.colPatientId",
  csvColDate: "prefetch.csv.colDate",
  pacsAe: "prefetch.pacs.ae",
  retrieve: "prefetch.retrieve",
  years: "prefetch.years",
  modalities: "prefetch.modalities",
  maxStudies: "prefetch.maxStudies",
  timeoutSec: "prefetch.timeoutSec",
} as const;

export function formFromSettings(s: Record<string, string>): PrefetchForm {
  const g = (k: string) => (s[k] ?? "").trim();
  return {
    enabled: g(K.enabled) === "true",
    source: (["mwl", "csv"].includes(g(K.source)) ? g(K.source) : "") as PrefetchSource,
    targetDay: (["today", "tomorrow", "both"].includes(g(K.targetDay)) ? g(K.targetDay) : "") as PrefetchTargetDay,
    times: g(K.times),
    catchUp: g(K.catchUp) === "true",
    mwlAe: g(K.mwlAe),
    mwlStation: g(K.mwlStation),
    mwlModality: g(K.mwlModality),
    csvFolder: g(K.csvFolder),
    csvCharset: (["UTF-8", "Shift_JIS"].includes(g(K.csvCharset)) ? g(K.csvCharset) : "") as PrefetchCharset,
    csvColPatientId: g(K.csvColPatientId),
    csvColDate: g(K.csvColDate),
    pacsAe: g(K.pacsAe),
    retrieve: (["move", "get"].includes(g(K.retrieve)) ? g(K.retrieve) : "") as PrefetchRetrieve,
    years: g(K.years),
    modalities: g(K.modalities),
    maxStudies: g(K.maxStudies),
    timeoutSec: g(K.timeoutSec),
  };
}

/** 保存する値。空欄は空文字（backend は空を「未設定」として読む）。 */
export function toSettings(f: PrefetchForm): Record<string, string> {
  return {
    [K.enabled]: f.enabled ? "true" : "false",
    [K.source]: f.source,
    [K.targetDay]: f.targetDay,
    [K.times]: f.times.trim(),
    [K.catchUp]: f.catchUp ? "true" : "false",
    [K.mwlAe]: f.mwlAe.trim(),
    [K.mwlStation]: f.mwlStation.trim(),
    [K.mwlModality]: f.mwlModality.trim(),
    [K.csvFolder]: f.csvFolder.trim(),
    [K.csvCharset]: f.csvCharset,
    [K.csvColPatientId]: f.csvColPatientId.trim(),
    [K.csvColDate]: f.csvColDate.trim(),
    [K.pacsAe]: f.pacsAe.trim(),
    [K.retrieve]: f.retrieve,
    [K.years]: f.years.trim(),
    [K.modalities]: f.modalities.trim(),
    [K.maxStudies]: f.maxStudies.trim(),
    [K.timeoutSec]: f.timeoutSec.trim(),
  };
}

function badInt(v: string): boolean {
  const s = v.trim();
  return s !== "" && !(/^\d+$/.test(s) && Number(s) >= 1);
}

/** 実行時刻の並び（カンマか空白区切りの H:mm／HH:mm）。1 つでも不正なら null。 */
export function parseTimes(v: string): string[] | null {
  const out: string[] = [];
  for (const t of v.split(/[,\s]+/)) {
    if (!t) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(t);
    if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
    const hhmm = `${m[1].padStart(2, "0")}:${m[2]}`;
    if (!out.includes(hhmm)) out.push(hhmm);
  }
  return out.sort();
}

/** 入力の不備のコード（backend の PrefetchConfig.errors と同じ名前）。有効にしないときは数と時刻の形式だけ見る。 */
export function formErrors(f: PrefetchForm): string[] {
  const e: string[] = [];
  const times = parseTimes(f.times);
  if (times === null) e.push("times-invalid");
  if (badInt(f.years)) e.push("years-invalid");
  if (badInt(f.maxStudies)) e.push("maxStudies-invalid");
  if (badInt(f.timeoutSec)) e.push("timeout-invalid");
  if (!f.enabled) return e;
  if (f.source === "") e.push("source-required");
  if (f.targetDay === "") e.push("targetDay-required");
  if (times !== null && times.length === 0) e.push("times-required");
  if (f.source === "mwl" && !f.mwlAe.trim()) e.push("mwl-ae-required");
  if (f.source === "csv") {
    if (!f.csvFolder.trim()) e.push("csv-folder-required");
    if (f.csvCharset === "") e.push("csv-charset-required");
    if (!f.csvColPatientId.trim()) e.push("csv-col-id-required");
  }
  if (!f.pacsAe.trim()) e.push("pacs-ae-required");
  if (f.retrieve === "") e.push("retrieve-required");
  if (f.timeoutSec.trim() === "") e.push("timeout-required");
  return e;
}

export function canSave(f: PrefetchForm): boolean {
  return formErrors(f).length === 0;
}

const KNOWN_ERRORS = new Set([
  "times-invalid", "years-invalid", "maxStudies-invalid", "timeout-invalid",
  "source-required", "targetDay-required", "times-required", "mwl-ae-required", "csv-folder-required",
  "csv-charset-required", "csv-col-id-required", "pacs-ae-required", "retrieve-required", "timeout-required",
  "disabled", "pacs-ae-not-found", "mwl-ae-not-found", "mwl-failed", "pacs-find-failed",
  "csv-folder-unreadable", "csv-not-found", "csv-charset-mismatch", "csv-unreadable",
  "csv-empty", "csv-no-id-column", "csv-no-date-column", "csv-bad-id", "csv-bad-date",
  "running", "no-instances",
]);

/** 異常・失敗のコード → i18n キー。`config:a,b` は設定の不備（詳細は別に出す）。未知のコードは汎用の文言。 */
export function errorKey(code: string | null | undefined): string {
  if (!code) return "prefetch.err.unknown";
  if (code.startsWith("config:")) return "prefetch.err.config";
  return KNOWN_ERRORS.has(code) ? `prefetch.err.${code}` : "prefetch.err.unknown";
}

/** 実行の記録の `config:a,b` から設定の不備のコードを取り出す。 */
export function configCodes(code: string | null | undefined): string[] {
  return code && code.startsWith("config:") ? code.slice("config:".length).split(",").filter(Boolean) : [];
}

export function runStatusKey(status: string): string {
  switch (status) {
    case "COMPLETE":
    case "INTERRUPTED":
    case "ERROR":
    case "RUNNING":
      return `prefetch.run.${status}`;
    default:
      return "prefetch.run.unknown";
  }
}

export function runStatusColor(status: string): string {
  switch (status) {
    case "COMPLETE":
      return "#1a7f37";
    case "INTERRUPTED":
      return "#8a5a00";
    case "ERROR":
      return "#b00020";
    default:
      return "#445";
  }
}

export function triggerKey(trigger: string): string {
  return trigger === "SCHEDULE" ? "prefetch.trigger.schedule" : trigger === "MANUAL" ? "prefetch.trigger.manual" : "prefetch.trigger.unknown";
}


/** 予約一覧の確認結果（`POST /api/prefetch/preview-schedule`）。 */
export interface PrefetchPreview {
  days: Record<string, number>;
  error: string | null;
}

/** `YYYYMMDD,YYYYMMDD` → 設定の日付書式で `…, …`。 */
export function formatDays(v: string | null | undefined): string {
  if (!v) return "";
  return v.split(",").map((d) => formatDicomDate(d)).join(", ");
}
