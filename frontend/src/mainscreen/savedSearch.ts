/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 検索パネルの条件を名前付きで残す（保存した検索）。
 *
 * 置き場所は backend の設定ストア（`/api/settings`）に `search.saved.<id>` の 1 キー 1 件。
 * まとめて 1 キーの JSON にしないのは、値の列が 4000 文字までだから。設定ストアに削除 API が無いので、
 * 削除は空文字で上書きし、読む側は空を「無い」として扱う（`viewer/xaCalibrationPersistence.ts` と同じ）。
 *
 * 🚨 患者ID・氏名も条件に入る。設定ストアは全キーを API で読め（プラグインからも）、web ではサーバー共有。
 */
import type { StudyFilters } from "../api";

export const SAVED_SEARCH_PREFIX = "search.saved.";
export const SAVED_SEARCH_NAME_MAX = 100;
/** 設定ストアの値の列の長さ（`Setting.java` の `setting_value`）。 */
export const SAVED_SEARCH_VALUE_MAX = 4000;

/** absolute = 保存時の日付のまま。それ以外は呼び出した日を基準に日付を作る。 */
export type SavedDateMode = "absolute" | "today" | "last7" | "last30";
const DATE_MODES: readonly SavedDateMode[] = ["absolute", "today", "last7", "last30"];

export interface SavedSearch {
  id: string;
  name: string;
  dateMode: SavedDateMode;
  filters: StudyFilters;
  savedAt: string;
}

/** Date → "YYYYMMDD"（ローカル日付）。 */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}
export function addDays(base: Date, days: number): Date {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  d.setDate(d.getDate() + days);
  return d;
}

const STRING_KEYS = ["patientId", "patientName", "modality", "accessionNumber"] as const;
const DATE_KEYS = ["studyDateFrom", "studyDateTo"] as const;

/** 保存する条件だけを取り出す（`studyInstanceUid` などの内部用の条件は残さない）。 */
function pickFilters(src: StudyFilters, withDates: boolean): StudyFilters {
  const f: StudyFilters = {};
  for (const k of STRING_KEYS) {
    const v = src[k];
    if (typeof v === "string" && v !== "") f[k] = v;
  }
  if (src.missingPatientInfo === true) f.missingPatientInfo = true;
  if (withDates) {
    for (const k of DATE_KEYS) {
      const v = src[k];
      if (typeof v === "string" && v !== "") f[k] = v;
    }
  }
  return f;
}

export type BuildResult =
  | { ok: true; key: string; value: string; saved: SavedSearch }
  | { ok: false; error: "name" | "tooLong" };

/** 保存する 1 件を作る。名前が空・長すぎる、または値が 4000 字を超えるときは保存しない。 */
export function buildSavedSearch(
  name: string,
  dateMode: SavedDateMode,
  filters: StudyFilters,
  now: Date,
  id: string = crypto.randomUUID(),
): BuildResult {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > SAVED_SEARCH_NAME_MAX) return { ok: false, error: "name" };
  const saved: SavedSearch = {
    id,
    name: trimmed,
    dateMode,
    filters: pickFilters(filters, dateMode === "absolute"),
    savedAt: now.toISOString(),
  };
  const value = JSON.stringify({
    v: 1,
    name: saved.name,
    dateMode: saved.dateMode,
    filters: saved.filters,
    savedAt: saved.savedAt,
  });
  if (value.length > SAVED_SEARCH_VALUE_MAX) return { ok: false, error: "tooLong" };
  return { ok: true, key: SAVED_SEARCH_PREFIX + id, value, saved };
}

/** 設定ストアの全キーから保存した検索を取り出す。読めないものは捨てて、その件数を返す（空文字は削除済み）。 */
export function extractSavedSearches(map: Record<string, string>): { items: SavedSearch[]; dropped: number } {
  const items: SavedSearch[] = [];
  let dropped = 0;
  for (const [key, raw] of Object.entries(map)) {
    if (!key.startsWith(SAVED_SEARCH_PREFIX) || raw === "") continue;
    const id = key.slice(SAVED_SEARCH_PREFIX.length);
    const s = parse(id, raw);
    if (s) items.push(s);
    else dropped++;
  }
  items.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { items, dropped };
}

function parse(id: string, raw: string): SavedSearch | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== 1 || id === "") return null;
  if (typeof r.name !== "string" || r.name.trim() === "") return null;
  if (!DATE_MODES.includes(r.dateMode as SavedDateMode)) return null;
  if (typeof r.filters !== "object" || r.filters === null) return null;
  const dateMode = r.dateMode as SavedDateMode;
  return {
    id,
    name: r.name,
    dateMode,
    filters: pickFilters(r.filters as StudyFilters, dateMode === "absolute"),
    savedAt: typeof r.savedAt === "string" ? r.savedAt : "",
  };
}

/** 呼び出したときの条件にする。相対の日付は `now` を基準に作る（「今日」= 今日〜今日、直近 N 日 = 今日−(N−1)〜今日）。 */
export function resolveFilters(saved: SavedSearch, now: Date): StudyFilters {
  const f = pickFilters(saved.filters, saved.dateMode === "absolute");
  const span = saved.dateMode === "today" ? 0 : saved.dateMode === "last7" ? 6 : saved.dateMode === "last30" ? 29 : -1;
  if (span >= 0) {
    f.studyDateFrom = ymd(addDays(now, -span));
    f.studyDateTo = ymd(now);
  }
  return f;
}
