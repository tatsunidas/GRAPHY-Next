/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイル検索の期間プリセット（`fw/mobile-ui-design.md` M2）。
 *
 * <p>デスクトップの `SearchPanel` は `<input type="date">` を 2 つ並べるが、狭幅では
 * 2 つの日付ピッカーを操作させるのは重い。参照用途（カンファレンス／患者説明／出先での確認）では
 * 「直近◯日」で足りるので、プリセットのボタン列にする。
 */

/** `Date` → DICOM の `YYYYMMDD`（backend の `studyDateFrom/To` の形式）。ローカル時刻で解釈する。 */
export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export type DateRangeKey = "today" | "week" | "month" | "year" | "all";

export const DATE_RANGE_KEYS: DateRangeKey[] = ["today", "week", "month", "year", "all"];

/** プリセットの i18n キー。 */
export const DATE_RANGE_LABEL_KEY: Record<DateRangeKey, string> = {
  today: "mobile.range.today",
  week: "mobile.range.week",
  month: "mobile.range.month",
  year: "mobile.range.year",
  all: "mobile.range.all",
};

/**
 * 各プリセットが遡る日数（今日を 1 日目として数える）。
 *
 * <p>⚠️ **`setMonth` / `setFullYear` による暦計算は使わない。** 7/31 の 1 か月前は「6/31」＝
 * 存在しない日付なので JS は 7/1 へ**繰り上げる**。つまり期間が**狭くなり**、6 月末の検査を
 * 取りこぼす。検索条件は広めに外す方が害が小さいので、日数で引いて月＝31 日・年＝366 日にする。
 */
const RANGE_DAYS: Record<Exclude<DateRangeKey, "all">, number> = {
  today: 1,
  week: 7,
  month: 31,
  year: 366,
};

/**
 * プリセット → `{ from, to }`（DICOM `YYYYMMDD`）。
 *
 * <p>`to` は常に「今日」。未来日の検査は無いので上限を切っても取りこぼさない。
 * `all` の下限 `19000101` はデスクトップ（`SearchPanel` のデモ用初期値）と揃えてある。
 *
 * @param today 基準日。テストから固定日を渡せるようにしてある。
 */
export function dateRangeFilter(key: DateRangeKey, today: Date): { from: string; to: string } {
  const to = ymd(today);
  if (key === "all") return { from: "19000101", to };
  const from = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  from.setDate(from.getDate() - (RANGE_DAYS[key] - 1));
  return { from: ymd(from), to };
}
