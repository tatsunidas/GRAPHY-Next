import { describe, expect, it } from "vitest";
import { buildTransientLayout } from "./transientLayout";

const ids = (tag: string, n: number) => Array.from({ length: n }, (_, z) => `graphy-plugin-volume:${tag}#${z}`);

describe("buildTransientLayout", () => {
  it("マップを C に並べ、Z は全マップで同じ長さ", () => {
    const l = buildTransientLayout([
      { name: "ADC", imageIds: ids("a", 4) },
      { name: "cDWI", imageIds: ids("b", 4) },
    ]);
    expect([l.nZ, l.nC, l.nT]).toEqual([4, 2, 1]);
    expect(l.cLabels).toEqual(["ADC", "cDWI"]);
    expect(l.zStack(0, 0)).toEqual(ids("a", 4));
    expect(l.zStack(1, 0)).toEqual(ids("b", 4));
    expect(l.stackAxis).toBe("z");
  });

  it("範囲外の C は端のマップに丸める（黙って別の長さを返さない）", () => {
    const l = buildTransientLayout([{ name: "ADC", imageIds: ids("a", 2) }]);
    expect(l.zStack(5, 0)).toEqual(ids("a", 2));
    expect(l.zStack(-1, 0)).toEqual(ids("a", 2));
  });

  it("幾何は渡されたものをそのまま使い、無ければ null / undefined", () => {
    const withGeo = buildTransientLayout([{ name: "A", imageIds: ids("a", 2) }], {
      ippAt: (z) => [0, 0, z * 5],
      normal: [0, 0, 1],
    });
    expect(withGeo.ippAt?.(1)).toEqual([0, 0, 5]);
    expect(withGeo.normal).toEqual([0, 0, 1]);
    const without = buildTransientLayout([{ name: "A", imageIds: ids("a", 2) }]);
    expect(without.ippAt).toBeUndefined();
    expect(without.normal).toBeNull();
  });

  it("負例: マップが無い・スライスが無い・スライス数が違うと拒否する", () => {
    expect(() => buildTransientLayout([])).toThrow();
    expect(() => buildTransientLayout([{ name: "A", imageIds: [] }])).toThrow();
    expect(() =>
      buildTransientLayout([
        { name: "ADC", imageIds: ids("a", 4) },
        { name: "cDWI", imageIds: ids("b", 3) },
      ]),
    ).toThrow(/cDWI/);
  });
});
