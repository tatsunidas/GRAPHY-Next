import { describe, expect, it } from "vitest";
import { measureDistanceMm, mergeMeasures, sanitizeMeasure3d, type Measure3d } from "./roiMeasure3d";

const m = (id: string, over: Partial<Measure3d> = {}): Measure3d => ({ id, a: [0, 0, 0], b: [3, 4, 0], ...over });

describe("measureDistanceMm", () => {
  it("3-4-5 は 5 mm、端点を動かすと距離が連動する", () => {
    expect(measureDistanceMm(m("a"))).toBe(5);
    expect(measureDistanceMm({ a: [0, 0, 0], b: [0, 0, 12] })).toBe(12);
  });
});

describe("sanitizeMeasure3d", () => {
  it("正常な定規は残り、任意項目も保たれる", () => {
    expect(sanitizeMeasure3d({ id: "x", a: [1, 2, 3], b: [4, 5, 6], label: "L", visible: false, seriesUid: "s" })).toEqual({
      id: "x", a: [1, 2, 3], b: [4, 5, 6], label: "L", visible: false, seriesUid: "s",
    });
  });
  it("壊れた要素は null（id 欠落・端点欠落・NaN・長さ違い）", () => {
    expect(sanitizeMeasure3d(null)).toBeNull();
    expect(sanitizeMeasure3d({ a: [0, 0, 0], b: [1, 1, 1] })).toBeNull();
    expect(sanitizeMeasure3d({ id: "x", a: [0, 0, 0] })).toBeNull();
    expect(sanitizeMeasure3d({ id: "x", a: [0, NaN, 0], b: [1, 1, 1] })).toBeNull();
    expect(sanitizeMeasure3d({ id: "x", a: [0, 0], b: [1, 1, 1] })).toBeNull();
  });
});

describe("mergeMeasures", () => {
  it("同じ id は updatedAt の新しい方、同時刻と未記録はローカル", () => {
    const r = m("a", { label: "remote", updatedAt: "2026-01-02" });
    const l = m("a", { label: "local", updatedAt: "2026-01-01" });
    expect(mergeMeasures([r], [l], new Set())[0].label).toBe("remote");
    expect(mergeMeasures([{ ...r, updatedAt: "2026-01-01" }], [l], new Set())[0].label).toBe("local");
    expect(mergeMeasures([m("a", { label: "r" })], [m("a", { label: "l" })], new Set())[0].label).toBe("l");
  });
  it("和集合・墓標の id は除く・id 順", () => {
    const out = mergeMeasures([m("c"), m("a")], [m("b"), m("d")], new Set(["d"]));
    expect(out.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
