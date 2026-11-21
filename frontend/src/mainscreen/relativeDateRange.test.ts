import { describe, expect, it } from "vitest";
import { makeRel, rollRel } from "./relativeDateRange";

describe("relativeDateRange", () => {
  it("今日・昨日・1 週間を基準日から作る", () => {
    const now = new Date(2026, 10, 22, 9);
    expect(makeRel(0, 0, now)).toMatchObject({ from: "20261122", to: "20261122" });
    expect(makeRel(-1, -1, now)).toMatchObject({ from: "20261121", to: "20261121" });
    expect(makeRel(-6, 0, now)).toMatchObject({ from: "20261116", to: "20261122" });
  });
  it("触っていなければ日付が変わったとき新しい今日へ（月またぎ）", () => {
    const rel = makeRel(-6, 0, new Date(2026, 10, 30, 23, 59));
    const next = rollRel(rel, { from: rel.from, to: rel.to }, new Date(2026, 11, 1, 0, 1));
    expect(next).toMatchObject({ from: "20261125", to: "20261201" });
  });
  it("同じ日のうちは null", () => {
    const rel = makeRel(0, 0, new Date(2026, 10, 22, 1));
    expect(rollRel(rel, { from: rel.from, to: rel.to }, new Date(2026, 10, 22, 23))).toBeNull();
  });
  it("負例: 手で変えた・期間なしのときは日付が変わっても追従しない", () => {
    const rel = makeRel(0, 0, new Date(2026, 10, 22));
    const later = new Date(2026, 10, 25);
    expect(rollRel(rel, { from: "20261101", to: rel.to }, later)).toBeNull();
    expect(rollRel(rel, { from: "", to: "" }, later)).toBeNull();
    expect(rollRel(null, { from: rel.from, to: rel.to }, later)).toBeNull();
  });
});
