/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  SAVED_SEARCH_NAME_MAX,
  SAVED_SEARCH_PREFIX,
  buildSavedSearch,
  extractSavedSearches,
  resolveFilters,
  sameFilters,
  type SavedDateMode,
} from "./savedSearch";
import type { StudyFilters } from "../api";

const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 10, 30);
const FULL: StudyFilters = {
  patientId: "P001",
  patientName: "YAMADA",
  modality: "CT,MR",
  accessionNumber: "ACC9",
  missingPatientInfo: true,
  studyDateFrom: "20260101",
  studyDateTo: "20260131",
};

function roundTrip(mode: SavedDateMode, filters: StudyFilters, now = at(2026, 10, 26)) {
  const b = buildSavedSearch("研究A", mode, filters, now, "id1");
  if (!b.ok) throw new Error("build failed");
  const { items, dropped } = extractSavedSearches({ [b.key]: b.value });
  expect(dropped).toBe(0);
  expect(items).toHaveLength(1);
  return items[0];
}

describe("保存した検索: 保存と復元", () => {
  it("absolute: 往復で条件がすべて一致する", () => {
    const s = roundTrip("absolute", FULL);
    expect(s.name).toBe("研究A");
    expect(resolveFilters(s, at(2030, 5, 5))).toEqual(FULL);
  });

  it("全期間（日付なし）を absolute で保存しても復元で日付が付かない", () => {
    const s = roundTrip("absolute", { patientId: "P001" });
    expect(resolveFilters(s, at(2026, 10, 26))).toEqual({ patientId: "P001" });
  });

  it("キーは search.saved.<id>", () => {
    const b = buildSavedSearch("x", "absolute", {}, at(2026, 1, 1), "abc");
    expect(b.ok && b.key).toBe(`${SAVED_SEARCH_PREFIX}abc`);
  });

  it("内部用の条件（studyInstanceUid）は残さない", () => {
    const s = roundTrip("absolute", { ...FULL, studyInstanceUid: "1.2.3" });
    expect(resolveFilters(s, at(2026, 10, 26)).studyInstanceUid).toBeUndefined();
  });
});

describe("保存した検索: 相対日付は呼び出した日が基準", () => {
  it("今日 / 直近7日 / 直近30日（保存時の日付は残らない）", () => {
    const base = at(2026, 10, 26);
    for (const [mode, from] of [["today", "20261026"], ["last7", "20261020"], ["last30", "20260927"]] as const) {
      const s = roundTrip(mode, FULL, base);
      expect(s.filters.studyDateFrom).toBeUndefined();
      expect(resolveFilters(s, base)).toMatchObject({ studyDateFrom: from, studyDateTo: "20261026" });
    }
  });

  it("翌日に開くと翌日が基準になる", () => {
    const s = roundTrip("last7", {}, at(2026, 10, 26));
    expect(resolveFilters(s, at(2026, 10, 27))).toMatchObject({ studyDateFrom: "20261021", studyDateTo: "20261027" });
  });

  it("月末・年末・うるう日をまたぐ", () => {
    expect(resolveFilters(roundTrip("last7", {}), at(2026, 3, 3))).toMatchObject({ studyDateFrom: "20260225" });
    expect(resolveFilters(roundTrip("last7", {}), at(2028, 3, 3))).toMatchObject({ studyDateFrom: "20280226" }); // 2028 はうるう年
    expect(resolveFilters(roundTrip("last7", {}), at(2027, 1, 3))).toMatchObject({ studyDateFrom: "20261228" });
    expect(resolveFilters(roundTrip("last30", {}), at(2027, 1, 3))).toMatchObject({ studyDateFrom: "20261205" });
  });
});

describe("保存した検索: 保存の拒否と読めない値", () => {
  it("名前が空・空白だけ・101 字は保存しない", () => {
    for (const name of ["", "   ", "あ".repeat(SAVED_SEARCH_NAME_MAX + 1)]) {
      expect(buildSavedSearch(name, "absolute", {}, at(2026, 1, 1), "i")).toEqual({ ok: false, error: "name" });
    }
    expect(buildSavedSearch("あ".repeat(SAVED_SEARCH_NAME_MAX), "absolute", {}, at(2026, 1, 1), "i").ok).toBe(true);
  });

  it("値が 4000 字を超えるときは保存しない", () => {
    const r = buildSavedSearch("長い", "absolute", { patientName: "x".repeat(4000) }, at(2026, 1, 1), "i");
    expect(r).toEqual({ ok: false, error: "tooLong" });
  });

  it("壊れた JSON・版違い・名前なし・日付の扱い不明は捨てて件数に出す。空文字（削除済み）は数えない", () => {
    const ok = buildSavedSearch("正常", "absolute", {}, at(2026, 1, 1), "ok");
    if (!ok.ok) throw new Error();
    const { items, dropped } = extractSavedSearches({
      [ok.key]: ok.value,
      "search.saved.broken": "{{{",
      "search.saved.ver": JSON.stringify({ v: 2, name: "n", dateMode: "absolute", filters: {} }),
      "search.saved.noname": JSON.stringify({ v: 1, name: " ", dateMode: "absolute", filters: {} }),
      "search.saved.mode": JSON.stringify({ v: 1, name: "n", dateMode: "yesterday", filters: {} }),
      "search.saved.nofilters": JSON.stringify({ v: 1, name: "n", dateMode: "absolute" }),
      "search.saved.deleted": "",
      "other.key": "{{{",
    });
    expect(items.map((s) => s.id)).toEqual(["ok"]);
    expect(dropped).toBe(5);
  });

  it("名前順に並ぶ", () => {
    const mk = (id: string, name: string) => {
      const b = buildSavedSearch(name, "absolute", {}, at(2026, 1, 1), id);
      if (!b.ok) throw new Error();
      return [b.key, b.value] as const;
    };
    const { items } = extractSavedSearches(Object.fromEntries([mk("1", "b"), mk("2", "a")]));
    expect(items.map((s) => s.name)).toEqual(["a", "b"]);
  });
});

describe("保存した検索: いまの入力欄と食い違っていないか（sameFilters）", () => {
  it("同じ中身なら、キーの順が違っても同じ。空文字と未設定も同じ", () => {
    expect(sameFilters({ patientId: "P1", modality: "CT" }, { modality: "CT", patientId: "P1" })).toBe(true);
    expect(sameFilters({ patientId: "P1", patientName: "" }, { patientId: "P1" })).toBe(true);
    expect(sameFilters({}, {})).toBe(true);
  });

  it("負例: 値が違う・項目が増減する・日付が違うと別（クリアも別）", () => {
    expect(sameFilters({ patientId: "P1" }, { patientId: "P2" })).toBe(false);
    expect(sameFilters({ patientId: "P1" }, {})).toBe(false); // 「クリア」したあと
    expect(sameFilters({ patientId: "P1" }, { patientId: "P1", accessionNumber: "A" })).toBe(false);
    expect(sameFilters({ modality: "CT" }, { modality: "CT,MR" })).toBe(false);
    expect(sameFilters({ missingPatientInfo: true }, {})).toBe(false);
    expect(sameFilters({ studyDateFrom: "20260101" }, { studyDateFrom: "20260102" })).toBe(false);
  });

  it("呼び出した直後の条件は、保存した検索と同じ（選んだ瞬間に選択が外れない）", () => {
    for (const mode of ["absolute", "today", "last7", "last30"] as const) {
      const s = roundTrip(mode, FULL);
      expect(sameFilters(resolveFilters(s, at(2026, 10, 26)), resolveFilters(s, at(2026, 10, 26)))).toBe(true);
    }
  });
});
