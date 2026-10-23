import { describe, expect, it } from "vitest";
import { isUsCine } from "./cineKind";

describe("isUsCine", () => {
  const US = { sopClassUid: "1.2.840.10008.5.1.4.1.1.3.1" };
  const XA = { sopClassUid: "1.2.840.10008.5.1.4.1.1.12.1" };
  it("shot 軸の US は US のシネ", () => {
    expect(isUsCine("shot", [US])).toBe(true);
  });
  it("XA は US のシネではない（XA の操作を出す）", () => {
    expect(isUsCine("shot", [XA])).toBe(false);
  });
  it("IVUS（pullback 軸）は US のシネではない", () => {
    expect(isUsCine("pullback", [US])).toBe(false);
  });
  it("通常の Z スタックの US は対象外", () => {
    expect(isUsCine("slice", [US])).toBe(false);
    expect(isUsCine(undefined, [US])).toBe(false);
  });
  it("SOP クラスが無い・空なら false", () => {
    expect(isUsCine("shot", [{ sopClassUid: null }, {}])).toBe(false);
    expect(isUsCine("shot", [])).toBe(false);
  });
});
