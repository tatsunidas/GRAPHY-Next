import { describe, expect, it } from "vitest";
import { pixelIntensityRelationshipOf } from "./xaPixelIntensity";

const ds = (v: string | undefined) => ({ string: (tag: string) => (tag === "x00281040" ? v : "別のタグの値") });

describe("pixelIntensityRelationshipOf", () => {
  it("LIN / LOG をそのまま返す（大文字小文字は変えない）", () => {
    expect(pixelIntensityRelationshipOf(ds("LIN"))).toBe("LIN");
    expect(pixelIntensityRelationshipOf(ds("LOG"))).toBe("LOG");
    expect(pixelIntensityRelationshipOf(ds("lin"))).toBe("lin");
  });
  it("DICOM の文字列の前後の空白（パディング）を除く", () => {
    expect(pixelIntensityRelationshipOf(ds("LIN "))).toBe("LIN");
    expect(pixelIntensityRelationshipOf(ds("  LOG"))).toBe("LOG");
  });
  it("★負例: タグが無い・空・空白だけなら null（LIN/LOG に推測で埋めない）", () => {
    expect(pixelIntensityRelationshipOf(ds(undefined))).toBeNull();
    expect(pixelIntensityRelationshipOf(ds(""))).toBeNull();
    expect(pixelIntensityRelationshipOf(ds("   "))).toBeNull();
  });
  it("別のタグの値を拾わない（0028,1040 だけを見る）", () => {
    expect(pixelIntensityRelationshipOf({ string: () => undefined })).toBeNull();
  });
});
