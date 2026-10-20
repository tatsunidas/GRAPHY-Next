/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { formatTag, lockReason, parseTagNumber, valueError } from "./tagEditRules";

// backend の TagEditRulesTest と同じ例（画面とサーバーで決まりが食い違わないこと）
describe("tagEditRules", () => {
  it("編集できないタグには理由がある", () => {
    expect(lockReason(0x0020000e, "UI")).toBe("uid");
    expect(lockReason(0x00020010, "UI")).toBe("meta");
    expect(lockReason(0x00280010, "US")).toBe("pixel");
    expect(lockReason(0x7fe00010, "OW")).toBe("pixel");
    expect(lockReason(0x00200032, "DS")).toBe("geometry");
    expect(lockReason(0x00280030, "DS")).toBe("geometry");
    expect(lockReason(0x00100010, "PN")).toBe("patient");
    expect(lockReason(0x00081140, "SQ")).toBe("sequence");
    expect(lockReason(0x04000561, "SQ")).toBe("audit");
    expect(lockReason(0x00091001, "OB")).toBe("binary");
    expect(lockReason(0x00091001, "")).toBe("binary");
    expect(lockReason(0x00090010, "LO")).toBe("privateCreator");
    expect(lockReason(0x00080000, "UL")).toBe("structure");
    expect(lockReason(0x0008103e, "LO", 2)).toBe("sequence");
  });

  it("編集できるタグ", () => {
    expect(lockReason(0x0008103e, "LO")).toBeNull();
    expect(lockReason(0x00080020, "DA")).toBeNull();
    expect(lockReason(0x00080060, "CS")).toBeNull();
    expect(lockReason(0x00091001, "LO")).toBeNull();
  });

  it("タグ番号の読み書き", () => {
    expect(parseTagNumber("(0008,103E)")).toBe(0x0008103e);
    expect(parseTagNumber("7FE00010")).toBe(0x7fe00010);
    expect(parseTagNumber("SeriesDescription")).toBe(-1);
    expect(formatTag(0x7fe00010)).toBe("(7FE0,0010)");
  });

  it("値の形_正例", () => {
    for (const [vr, v] of [
      ["DA", "20240229"], ["TM", "235959.123456"], ["TM", "07"], ["DT", "20260101120000.5+0900"],
      ["DS", "-1.5e3\\2"], ["IS", "+12"], ["CS", "ORIGINAL\\PRIMARY"], ["LO", "Chest 1.0 mm"],
      ["PN", "Yamada^Taro=山田^太郎"], ["LT", "a\\b\nc"], ["US", "65535"], ["FD", "0.25"], ["AS", "045Y"], ["LO", ""],
    ]) {
      expect(valueError(vr, v), `${vr} ${v}`).toBeNull();
    }
  });

  it("値の形_負例", () => {
    for (const [vr, v, reason] of [
      ["DA", "20261345", "format"], ["DA", "20250229", "format"], ["DA", "2026-01-01", "format"], ["TM", "245959", "format"],
      ["DT", "20261301", "format"], ["DS", "abc", "format"], ["DS", "1.00000000000000001", "tooLong"],
      ["IS", "2147483648", "outOfRange"], ["CS", "original", "badChars"], ["CS", "ABCDEFGHIJKLMNOPQ", "tooLong"],
      ["SH", "12345678901234567", "tooLong"], ["LO", "x".repeat(65), "tooLong"], ["LO", "a\nb", "badChars"],
      ["PN", "a=b=c=d", "format"], ["US", "65536", "outOfRange"], ["FD", "NaN", "format"], ["FL", "1f", "format"],
      ["AS", "45Y", "format"],
    ]) {
      expect(valueError(vr, v), `${vr} ${v}`).toBe(reason);
    }
  });
});
