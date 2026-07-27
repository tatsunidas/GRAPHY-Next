import { describe, expect, it } from "vitest";
import { applySort, naturalCompare, sortIndicator } from "./tableSort";

interface Row {
  id: string;
  name: string;
  n: number | null;
}

const accessors = {
  name: (r: Row) => r.name,
  n: (r: Row) => r.n,
};

describe("naturalCompare", () => {
  it("数値は数値として比較する", () => {
    expect(naturalCompare(2, 10)).toBeLessThan(0);
    expect(naturalCompare(10, 2)).toBeGreaterThan(0);
    expect(naturalCompare(5, 5)).toBe(0);
  });

  it("数字混じりの文字列を自然順で比較する（PT2 < PT10）", () => {
    expect(naturalCompare("PT2", "PT10")).toBeLessThan(0);
    expect(naturalCompare("PT10", "PT2")).toBeGreaterThan(0);
  });

  it("大文字小文字を区別しない", () => {
    expect(naturalCompare("abc", "ABC")).toBe(0);
  });

  it("空値は常に後ろへ回す", () => {
    expect(naturalCompare("", "a")).toBeGreaterThan(0);
    expect(naturalCompare("a", null)).toBeLessThan(0);
    expect(naturalCompare(undefined, "")).toBe(0);
  });
});

describe("applySort", () => {
  const rows: Row[] = [
    { id: "a", name: "PT10", n: 2 },
    { id: "b", name: "", n: null },
    { id: "c", name: "PT2", n: 1 },
  ];

  it("sort が null なら元配列をそのまま返す", () => {
    expect(applySort(rows, null, accessors)).toBe(rows);
  });

  it("未知のキーなら元配列をそのまま返す", () => {
    expect(applySort(rows, { key: "unknown", dir: "asc" }, accessors)).toBe(rows);
  });

  it("元配列を破壊しない", () => {
    const before = rows.map((r) => r.id);
    applySort(rows, { key: "name", dir: "desc" }, accessors);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it("昇順は自然順で並べ、空値は末尾に置く", () => {
    const got = applySort(rows, { key: "name", dir: "asc" }, accessors);
    expect(got.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("降順でも空値は末尾のまま（方向に引きずられない）", () => {
    const got = applySort(rows, { key: "name", dir: "desc" }, accessors);
    expect(got.map((r) => r.id)).toEqual(["a", "c", "b"]);
  });

  it("数値列は数値順で並べる（文字列比較ではない）", () => {
    const nums: Row[] = [
      { id: "x", name: "", n: 10 },
      { id: "y", name: "", n: 2 },
    ];
    expect(applySort(nums, { key: "n", dir: "asc" }, accessors).map((r) => r.id)).toEqual([
      "y",
      "x",
    ]);
  });

  it("同値は元の順序を保つ（安定ソート）", () => {
    const dup: Row[] = [
      { id: "x", name: "same", n: 1 },
      { id: "y", name: "same", n: 1 },
      { id: "z", name: "same", n: 1 },
    ];
    const got = applySort(dup, { key: "name", dir: "desc" }, accessors);
    expect(got.map((r) => r.id)).toEqual(["x", "y", "z"]);
  });
});

describe("sortIndicator", () => {
  it("対象キーのときだけ方向マーカーを返す", () => {
    expect(sortIndicator({ key: "name", dir: "asc" }, "name")).toBe(" ▲");
    expect(sortIndicator({ key: "name", dir: "desc" }, "name")).toBe(" ▼");
    expect(sortIndicator({ key: "name", dir: "asc" }, "other")).toBe("");
    expect(sortIndicator(null, "name")).toBe("");
  });
});
