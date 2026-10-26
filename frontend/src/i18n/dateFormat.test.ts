import { describe, expect, it } from "vitest";
import { DATE_FORMATS, formatClockTime, formatDateTime, formatDicomDate, formatDicomTime, isAmbiguousDateFormat, sampleDate, sampleTime } from "./dateFormat";

describe("formatDicomDate", () => {
  it("5 書式で 20261018 を整える", () => {
    expect(DATE_FORMATS.map((f) => formatDicomDate("20261018", f))).toEqual([
      "2026-10-18", "2026/10/18", "18/10/2026", "10/18/2026", "18-Oct-2026",
    ]);
  });
  it("うるう日は通り、存在しない日付は元のまま", () => {
    expect(formatDicomDate("20240229", "DD/MM/YYYY")).toBe("29/02/2024");
    expect(formatDicomDate("20230229", "DD/MM/YYYY")).toBe("20230229");
  });
  it("形式に合わない値は書き直さず元の文字列のまま（負例）", () => {
    for (const bad of ["20261345", "2026", "2026-10-18", "", "20261018x", "00000000"]) {
      for (const f of DATE_FORMATS) expect(formatDicomDate(bad, f)).toBe(bad);
    }
  });
  it("既定の書式は YYYY-MM-DD（設定が無ければ今と同じ表示）", () => {
    expect(formatDicomDate("20261018")).toBe("2026-10-18");
  });
});

describe("formatDicomTime", () => {
  it("24 時間: 秒以下の端数は切る", () => {
    expect(formatDicomTime("143005", "24h")).toBe("14:30:05");
    expect(formatDicomTime("143005.123", "24h")).toBe("14:30:05");
  });
  it("12 時間: 0 時は 12 AM、正午は 12 PM", () => {
    expect(formatDicomTime("143005", "12h")).toBe("2:30:05 PM");
    expect(formatDicomTime("000000", "12h")).toBe("12:00:00 AM");
    expect(formatDicomTime("120000", "12h")).toBe("12:00:00 PM");
    expect(formatDicomTime("235959", "12h")).toBe("11:59:59 PM");
  });
  it("短い値は、ある桁だけ出し 0 で埋めない", () => {
    expect(formatDicomTime("1430", "24h")).toBe("14:30");
    expect(formatDicomTime("14", "24h")).toBe("14");
    expect(formatDicomTime("1430", "12h")).toBe("2:30 PM");
  });
  it("形式に合わない値は元のまま（負例）", () => {
    for (const bad of ["25", "246000", "1460", "", "14:30:05", "1", "143005."]) {
      expect(formatDicomTime(bad, "24h")).toBe(bad);
      expect(formatDicomTime(bad, "12h")).toBe(bad);
    }
  });
});

describe("見本・曖昧な書式", () => {
  it("見本は与えた日時で作る", () => {
    const d = new Date(2026, 9, 18, 14, 30, 5);
    expect(sampleDate("DD/MM/YYYY", d)).toBe("18/10/2026");
    expect(sampleTime("12h", d)).toBe("2:30:05 PM");
  });
  it("DD/MM と MM/DD だけが曖昧", () => {
    expect(DATE_FORMATS.filter((f) => isAmbiguousDateFormat(f))).toEqual(["DD/MM/YYYY", "MM/DD/YYYY"]);
  });
});

describe("formatDateTime / formatClockTime（アプリの日時）", () => {
  const d = new Date(2026, 9, 18, 14, 30, 5); // ローカル時刻 2026-10-18 14:30:05
  it("既定は YYYY-MM-DD HH:mm（秒は指定したときだけ）", () => {
    expect(formatDateTime(d, {}, "YYYY-MM-DD", "24h")).toBe("2026-10-18 14:30");
    expect(formatDateTime(d, { seconds: true }, "YYYY-MM-DD", "24h")).toBe("2026-10-18 14:30:05");
  });
  it("5 書式 × 12 時間", () => {
    const want = ["2026-10-18", "2026/10/18", "18/10/2026", "10/18/2026", "18-Oct-2026"];
    DATE_FORMATS.forEach((f, i) => expect(formatDateTime(d, { seconds: true }, f, "12h")).toBe(`${want[i]} 2:30:05 PM`));
  });
  it("0 時は 12 AM、12 時は 12 PM", () => {
    expect(formatClockTime(new Date(2026, 0, 1, 0, 0, 0), { seconds: true }, "12h")).toBe("12:00:00 AM");
    expect(formatClockTime(new Date(2026, 0, 1, 12, 0, 0), { seconds: true }, "12h")).toBe("12:00:00 PM");
  });
  it("ISO 文字列・ミリ秒の数値も受ける", () => {
    expect(formatDateTime(d.toISOString(), {}, "DD/MM/YYYY", "24h")).toBe("18/10/2026 14:30");
    expect(formatClockTime(d.getTime(), { seconds: true }, "24h")).toBe("14:30:05");
  });
  it("負例: 読めない値は元の文字列のまま（Invalid Date と書かない）", () => {
    expect(formatDateTime("not-a-date")).toBe("not-a-date");
    expect(formatDateTime(new Date(NaN))).not.toContain("Invalid");
    expect(formatClockTime("")).toBe("");
  });
});
