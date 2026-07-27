import { describe, expect, it } from "vitest";
import { parseIidLaunch } from "./iid";

describe("parseIidLaunch", () => {
  it("studyUID があれば解釈する", () => {
    expect(parseIidLaunch("?studyUID=1.2.3")).toEqual({
      studyUID: "1.2.3",
      seriesUID: undefined,
      requestType: undefined,
    });
  });

  it("先頭の ? が無くても解釈する", () => {
    expect(parseIidLaunch("studyUID=1.2.3")?.studyUID).toBe("1.2.3");
  });

  it("キー名の揺れを吸収する（IHE 標準 / 別名 / 大文字始まり）", () => {
    expect(parseIidLaunch("?studyInstanceUID=1.2.3")?.studyUID).toBe("1.2.3");
    expect(parseIidLaunch("?StudyInstanceUID=1.2.3")?.studyUID).toBe("1.2.3");
    expect(parseIidLaunch("?studyUID=1.2&seriesInstanceUID=9.9")?.seriesUID).toBe("9.9");
    expect(parseIidLaunch("?studyUID=1.2&SeriesInstanceUID=9.9")?.seriesUID).toBe("9.9");
  });

  it("studyUID が無ければ null（起動導線に乗せない）", () => {
    expect(parseIidLaunch("?requestType=STUDY")).toBeNull();
    expect(parseIidLaunch("")).toBeNull();
    expect(parseIidLaunch("?studyUID=")).toBeNull();
  });

  it("値の前後の空白は落とす", () => {
    expect(parseIidLaunch("?studyUID=%201.2.3%20")?.studyUID).toBe("1.2.3");
  });

  it("空白のみの値は未指定として扱う", () => {
    expect(parseIidLaunch("?studyUID=%20%20")).toBeNull();
  });

  it("requestType と seriesUID を保持する", () => {
    expect(parseIidLaunch("?requestType=SERIES&studyUID=1.2&seriesUID=3.4")).toEqual({
      studyUID: "1.2",
      seriesUID: "3.4",
      requestType: "SERIES",
    });
  });
});
