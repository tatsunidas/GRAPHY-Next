import { describe, expect, it } from "vitest";
import { chooseInstance, orderShots } from "./xaShots";

const inst = (sop: string, n: number | null) => ({ sopInstanceUid: sop, instanceNumber: n });

describe("orderShots（ビューアのショットと同じ並び）", () => {
  it("InstanceNumber の昇順（8, 7 → 7, 8）", () => {
    expect(orderShots([inst("b", 8), inst("a", 7)]).map((s) => s.instanceNumber)).toEqual([7, 8]);
  });
  it("InstanceNumber が同じなら SOPInstanceUID の昇順", () => {
    expect(orderShots([inst("2.5", 3), inst("2.1", 3)]).map((s) => s.sopInstanceUid)).toEqual(["2.1", "2.5"]);
  });
  it("番号が無いものは 0 として扱う（バックエンドと同じ）", () => {
    expect(orderShots([inst("a", 1), inst("b", null)]).map((s) => s.sopInstanceUid)).toEqual(["b", "a"]);
  });
  it("入力を変えない", () => {
    const src = [inst("b", 8), inst("a", 7)];
    orderShots(src);
    expect(src.map((s) => s.sopInstanceUid)).toEqual(["b", "a"]);
  });
});

describe("chooseInstance", () => {
  const shots = orderShots([inst("b", 8), inst("a", 7)]);
  it("指定が無ければ先頭のショット", () => {
    expect(chooseInstance(shots)?.sopInstanceUid).toBe("a");
  });
  it("指定した SOP のインスタンス", () => {
    expect(chooseInstance(shots, "b")?.sopInstanceUid).toBe("b");
  });
  it("★負例: シリーズに無い SOP は null（先頭に替えない）", () => {
    expect(chooseInstance(shots, "zzz")).toBeNull();
  });
  it("インスタンスが無ければ null", () => {
    expect(chooseInstance([])).toBeNull();
  });
});
