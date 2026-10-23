import { describe, expect, it } from "vitest";
import type { Series } from "./api";
import { seriesHeadingName } from "./seriesHeading";

const base: Series = {
  seriesInstanceUid: "1.2.3",
  modality: "XA",
  seriesNumber: 101,
  seriesDescription: "DA Image Converted",
  sopClassUid: null,
  numberOfInstances: 2,
};

describe("seriesHeadingName", () => {
  it("未選択なら null", () => {
    expect(seriesHeadingName(null)).toBeNull();
  });
  it("説明があれば説明", () => {
    expect(seriesHeadingName(base)).toBe("DA Image Converted");
  });
  it("説明が空白だけならシリーズ番号", () => {
    expect(seriesHeadingName({ ...base, seriesDescription: "  " })).toBe("#101");
  });
  it("説明もシリーズ番号も無ければ null", () => {
    expect(seriesHeadingName({ ...base, seriesDescription: null, seriesNumber: null })).toBeNull();
  });
});
