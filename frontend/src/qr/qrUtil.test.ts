import { describe, expect, it } from "vitest";
import { ageAt, filtersToMatchKeys, fmtDate, storedStatusOf } from "./qrUtil";

describe("storedStatusOf", () => {
  it("期待件数が不明（0以下）なら保存の有無だけで判定する", () => {
    expect(storedStatusOf(5, 0)).toBe("full");
    expect(storedStatusOf(0, 0)).toBe("unknown");
    expect(storedStatusOf(0, -1)).toBe("unknown");
  });

  it("保存件数と期待件数を比べて判定する", () => {
    expect(storedStatusOf(0, 10)).toBe("none");
    expect(storedStatusOf(3, 10)).toBe("partial");
    expect(storedStatusOf(10, 10)).toBe("full");
    expect(storedStatusOf(12, 10)).toBe("full");
  });
});

describe("ageAt", () => {
  it("誕生日を過ぎていればその年の満年齢", () => {
    expect(ageAt("20260727", "19800101")).toBe(46);
  });

  it("誕生日前なら 1 引く", () => {
    expect(ageAt("20260727", "19801231")).toBe(45);
  });

  it("誕生日当日は加算済みとして扱う", () => {
    expect(ageAt("20260727", "19800727")).toBe(46);
  });

  it("区切り文字が入っていても解釈する", () => {
    expect(ageAt("2026-07-27", "1980-01-01")).toBe(46);
  });

  it("欠損・桁不足は null", () => {
    expect(ageAt(null, "19800101")).toBeNull();
    expect(ageAt("20260727", null)).toBeNull();
    expect(ageAt("2026", "19800101")).toBeNull();
  });

  it("負の年齢（生年月日が検査日より後）は null", () => {
    expect(ageAt("19700101", "19800101")).toBeNull();
  });
});

describe("fmtDate", () => {
  it("YYYYMMDD をハイフン区切りにする", () => {
    expect(fmtDate("20260727")).toBe("2026-07-27");
  });

  it("空・欠損は空文字", () => {
    expect(fmtDate("")).toBe("");
    expect(fmtDate(null)).toBe("");
    expect(fmtDate(undefined)).toBe("");
  });

  it("桁不足はそのまま返す", () => {
    expect(fmtDate("2026")).toBe("2026");
  });
});

describe("filtersToMatchKeys", () => {
  it("null は空オブジェクト", () => {
    expect(filtersToMatchKeys(null)).toEqual({});
  });

  it("患者 ID / 氏名は部分一致ワイルドカードを付ける", () => {
    expect(filtersToMatchKeys({ patientId: "abc", patientName: "YAMADA" })).toEqual({
      PatientID: "*abc*",
      PatientName: "*YAMADA*",
    });
  });

  it("モダリティは先頭の 1 値だけ使う（C-FIND は単一値マッチ）", () => {
    expect(filtersToMatchKeys({ modality: "CT,MR" }).ModalitiesInStudy).toBe("CT");
    expect(filtersToMatchKeys({ modality: " CT , MR " }).ModalitiesInStudy).toBe("CT");
  });

  it("アクセッション番号はワイルドカードを付けずそのまま", () => {
    expect(filtersToMatchKeys({ accessionNumber: "A1" }).AccessionNumber).toBe("A1");
  });

  it("日付は DICOM の範囲表記に変換する", () => {
    expect(
      filtersToMatchKeys({ studyDateFrom: "20260701", studyDateTo: "20260731" }).StudyDate,
    ).toBe("20260701-20260731");
    expect(filtersToMatchKeys({ studyDateFrom: "20260701" }).StudyDate).toBe("20260701-");
    expect(filtersToMatchKeys({ studyDateTo: "20260731" }).StudyDate).toBe("-20260731");
  });

  it("同日指定は範囲ではなく単日にする", () => {
    expect(
      filtersToMatchKeys({ studyDateFrom: "20260701", studyDateTo: "20260701" }).StudyDate,
    ).toBe("20260701");
  });

  it("日付未指定なら StudyDate キー自体を作らない", () => {
    expect(filtersToMatchKeys({ patientId: "abc" })).not.toHaveProperty("StudyDate");
  });
});
