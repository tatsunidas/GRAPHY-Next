/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { createElement, useSyncExternalStore, type ReactElement } from "react";

/**
 * DICOM の日付（DA）・時刻（TM）の**表示**書式。値そのもの（タグビューア・CSV・検索条件・並び替え）は変えない。
 * 書式に合わない値は書き直さず、元の文字列のまま返す。
 */
export const DATE_FORMATS = ["YYYY-MM-DD", "YYYY/MM/DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD-Mon-YYYY"] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const TIME_FORMATS = ["24h", "12h"] as const;
export type TimeFormat = (typeof TIME_FORMATS)[number];

export const DEFAULT_DATE_FORMAT: DateFormat = "YYYY-MM-DD";
export const DEFAULT_TIME_FORMAT: TimeFormat = "24h";

export const DATE_FORMAT_KEY = "graphy.dateFormat";
export const TIME_FORMAT_KEY = "graphy.timeFormat";
const EVENT = "graphy:dateFormat";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback; // localStorage 不可でも既定で表示する
  }
}

export function getDateFormat(): DateFormat {
  return read(DATE_FORMAT_KEY, DATE_FORMATS, DEFAULT_DATE_FORMAT);
}
export function getTimeFormat(): TimeFormat {
  return read(TIME_FORMAT_KEY, TIME_FORMATS, DEFAULT_TIME_FORMAT);
}

export function setDateFormat(f: DateFormat): void {
  try {
    localStorage.setItem(DATE_FORMAT_KEY, f);
  } catch {
    // 保存できなくても、このウィンドウの表示は切り替える（読み出しは既定に戻る）
  }
  window.dispatchEvent(new Event(EVENT));
}
export function setTimeFormat(f: TimeFormat): void {
  try {
    localStorage.setItem(TIME_FORMAT_KEY, f);
  } catch {
    // 同上
  }
  window.dispatchEvent(new Event(EVENT));
}

/** 日付の形が曖昧（日と月が 12 以下で見分けにくい）か。 */
export function isAmbiguousDateFormat(f: DateFormat = getDateFormat()): boolean {
  return f === "DD/MM/YYYY" || f === "MM/DD/YYYY";
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d <= last;
}

/** DICOM DA（YYYYMMDD）を設定の書式で返す。形式に合わない値は元の文字列のまま。 */
export function formatDicomDate(da: string, fmt: DateFormat = getDateFormat()): string {
  if (!/^\d{8}$/.test(da)) return da;
  const y = da.slice(0, 4);
  const m = da.slice(4, 6);
  const d = da.slice(6, 8);
  if (!validDate(Number(y), Number(m), Number(d))) return da;
  switch (fmt) {
    case "YYYY/MM/DD":
      return `${y}/${m}/${d}`;
    case "DD/MM/YYYY":
      return `${d}/${m}/${y}`;
    case "MM/DD/YYYY":
      return `${m}/${d}/${y}`;
    case "DD-Mon-YYYY":
      return `${d}-${MONTHS[Number(m) - 1]}-${y}`;
    default:
      return `${y}-${m}-${d}`;
  }
}

/**
 * DICOM TM（HHMMSS[.ffffff]、HH・HHMM だけの短い値もある）を設定の書式で返す。秒以下の端数は切る。
 * ある桁だけを出し、足りない桁を 0 で埋めない。形式に合わない値は元の文字列のまま。
 */
export function formatDicomTime(tm: string, fmt: TimeFormat = getTimeFormat()): string {
  const m = /^(\d{2})(?:(\d{2})(?:(\d{2})(?:\.\d+)?)?)?$/.exec(tm);
  if (!m) return tm;
  const hh = Number(m[1]);
  if (hh > 23 || (m[2] !== undefined && Number(m[2]) > 59) || (m[3] !== undefined && Number(m[3]) > 60)) return tm;
  const rest = [m[2], m[3]].filter((x): x is string => x !== undefined).map((x) => `:${x}`).join("");
  if (fmt === "12h") {
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${h12}${rest} ${hh < 12 ? "AM" : "PM"}`;
  }
  return `${m[1]}${rest}`;
}

/** 日付の見本（設定画面の選択肢に出す）。 */
export function sampleDate(fmt: DateFormat, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return formatDicomDate(`${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`, fmt);
}
export function sampleTime(fmt: TimeFormat, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return formatDicomTime(`${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`, fmt);
}

/** アプリが出す時刻（Date 由来）を設定の書式で返す。読めない値は元の文字列のまま。 */
export function formatClockTime(
  v: Date | string | number,
  opts: { seconds?: boolean } = {},
  fmt: TimeFormat = getTimeFormat(),
): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return v instanceof Date ? "" : String(v); // "Invalid Date" とは書かない
  const p = (n: number) => String(n).padStart(2, "0");
  const tm = `${p(d.getHours())}${p(d.getMinutes())}${opts.seconds ? p(d.getSeconds()) : ""}`;
  return formatDicomTime(tm, fmt);
}

/** アプリが出す日時（Date 由来）を「日付 時刻」で返す。読めない値は元の文字列のまま。 */
export function formatDateTime(
  v: Date | string | number,
  opts: { seconds?: boolean } = {},
  dateFmt: DateFormat = getDateFormat(),
  timeFmt: TimeFormat = getTimeFormat(),
): string {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return v instanceof Date ? "" : String(v); // "Invalid Date" とは書かない
  const p = (n: number) => String(n).padStart(2, "0");
  const date = formatDicomDate(`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`, dateFmt);
  return `${date} ${formatClockTime(d, opts, timeFmt)}`;
}

function subscribe(cb: () => void): () => void {
  const handler = () => cb();
  window.addEventListener(EVENT, handler);
  window.addEventListener("storage", handler); // 別タブ・別ウィンドウの変更も拾う
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener("storage", handler);
  };
}

const snapshot = (): string => `${getDateFormat()}|${getTimeFormat()}`;

/** 書式の設定を購読する（変更で再描画）。値は使わなくてもよい（呼ぶだけで購読になる）。 */
export function useDateFormat(): { date: DateFormat; time: TimeFormat } {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [date, time] = s.split("|") as [DateFormat, TimeFormat];
  return { date, time };
}

/** 日付 1 つ。日と月を取り違えやすい書式のときだけ、ツールチップに YYYY-MM-DD を併記する。 */
export function DicomDate({ value }: { value: string | null | undefined }): ReactElement {
  const { date } = useDateFormat();
  const v = value ?? "";
  const text = formatDicomDate(v, date);
  const title = isAmbiguousDateFormat(date) && text !== v ? formatDicomDate(v, "YYYY-MM-DD") : undefined;
  return createElement("span", { title }, text);
}
