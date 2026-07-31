/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { DATE_RANGE_KEYS, DATE_RANGE_LABEL_KEY, dateRangeFilter, ymd } from "./dateRange";

// ローカル時刻で解釈するので、new Date(y, m, d) で作る（ISO 文字列だと UTC 解釈でずれる）。
const day = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe("ymd", () => {
  it("DICOM の YYYYMMDD にする（0 埋め）", () => {
    expect(ymd(day(2026, 7, 31))).toBe("20260731");
    expect(ymd(day(2026, 1, 5))).toBe("20260105");
  });
});

describe("dateRangeFilter", () => {
  const today = day(2026, 7, 31);

  it("today は当日のみ", () => {
    expect(dateRangeFilter("today", today)).toEqual({ from: "20260731", to: "20260731" });
  });

  it("week は今日を含めて 7 日間", () => {
    expect(dateRangeFilter("week", today)).toEqual({ from: "20260725", to: "20260731" });
  });

  it("month は 31 日・year は 366 日ぶん遡る（暦計算は使わない）", () => {
    expect(dateRangeFilter("month", today)).toEqual({ from: "20260701", to: "20260731" });
    expect(dateRangeFilter("year", today)).toEqual({ from: "20250731", to: "20260731" });
  });

  it("all はデスクトップ（SearchPanel のデモ既定）と同じ下限", () => {
    expect(dateRangeFilter("all", today)).toEqual({ from: "19000101", to: "20260731" });
  });

  it("🚨 月末起点でも期間が狭まらない（setMonth の繰り上げ回帰防止）", () => {
    // 3/31 に setMonth(-1) を使うと「2/31」→ 3/2 or 3/3 へ繰り上がり、2 月の検査を取りこぼす。
    const r = dateRangeFilter("month", day(2026, 3, 31));
    expect(r.from).toBe("20260301");
    expect(r.from < "20260302").toBe(true);
  });

  it("年をまたいでも連続している", () => {
    expect(dateRangeFilter("week", day(2026, 1, 2))).toEqual({ from: "20251227", to: "20260102" });
  });

  it("うるう日でも例外を投げない", () => {
    expect(() => dateRangeFilter("year", day(2024, 2, 29))).not.toThrow();
    expect(dateRangeFilter("today", day(2024, 2, 29)).from).toBe("20240229");
  });

  it("すべてのプリセットに i18n キーがあり、from <= to になる", () => {
    for (const k of DATE_RANGE_KEYS) {
      expect(DATE_RANGE_LABEL_KEY[k]).toMatch(/^mobile\.range\./);
      const { from, to } = dateRangeFilter(k, today);
      expect(from <= to).toBe(true);
    }
  });
});
