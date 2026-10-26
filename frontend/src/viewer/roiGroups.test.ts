/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { nextGroupNumber, planGroup, pooledInputsOf, pooledValueStats, sumAreaMm2, unresolvedMembers } from "./roiGroups";

describe("planGroup", () => {
  const owner: Record<string, string | undefined> = { a: "P1", b: "P1", c: "P2", d: undefined };
  const of = (u: string) => owner[u];
  const id = () => "gid";
  it("同一患者の 2 件以上ならグループにできる", () => {
    expect(planGroup(["a", "b"], of, id, "G 1")).toEqual({ ok: true, groupId: "gid", name: "G 1" });
  });
  it("1 件以下は不可", () => {
    expect(planGroup(["a"], of, id, "G")).toEqual({ ok: false, reason: "tooFew" });
    expect(planGroup([], of, id, "G")).toEqual({ ok: false, reason: "tooFew" });
  });
  it("🔴 患者をまたぐと不可（負例）", () => {
    expect(planGroup(["a", "c"], of, id, "G")).toEqual({ ok: false, reason: "crossPatient" });
  });
  it("患者不明は数えない", () => {
    expect(planGroup(["a", "d"], of, id, "G").ok).toBe(true);
  });
});

describe("unresolvedMembers", () => {
  const owner: Record<string, string | undefined> = { "a:1": undefined, "m:2": "P1", "m:3": undefined, "s:4": undefined, "s:5": "P1" };
  const of = (k: string) => owner[k];
  it("塗り・球で患者不明のものだけ返す", () => {
    expect(unresolvedMembers(["a:1", "m:2", "m:3", "s:4", "s:5"], of)).toEqual(["m:3", "s:4"]);
  });
  it("形・計測の患者不明は返さない（旧データを弾かない）", () => {
    expect(unresolvedMembers(["a:1", "m:2"], of)).toEqual([]);
  });
  it("全部解決済みなら空", () => {
    expect(unresolvedMembers(["m:2", "s:5"], of)).toEqual([]);
  });
});

describe("nextGroupNumber", () => {
  it("既存の最大 + 1、無ければ 1", () => {
    expect(nextGroupNumber(["グループ 1", "グループ 3", "病変"], "グループ")).toBe(4);
    expect(nextGroupNumber([], "グループ")).toBe(1);
    expect(nextGroupNumber([undefined, "グループ A"], "グループ")).toBe(1);
  });
  it("接頭辞の記号は文字として扱う", () => {
    expect(nextGroupNumber(["G(1) 2"], "G(1)")).toBe(3);
  });
});

describe("pooledValueStats（母 SD で厳密に合成）", () => {
  const direct = (xs: number[]) => {
    const n = xs.length;
    const mean = xs.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    return { n, mean, sd, unit: "HU" };
  };
  it("全画素を直接集計した値と一致する", () => {
    const a = [1, 2, 3, 4];
    const b = [10, 12, 20];
    const c = [-5];
    const pooled = pooledValueStats([direct(a), direct(b), direct(c)])!;
    const all = direct([...a, ...b, ...c]);
    expect(pooled.n).toBe(all.n);
    expect(pooled.mean).toBeCloseTo(all.mean, 10);
    expect(pooled.sd).toBeCloseTo(all.sd, 10);
  });
  it("🔴 ROI ごとの SD を単純平均する素朴な方法とは違う値になる（負例）", () => {
    const x = direct([0, 0, 0, 0]);
    const y = direct([10, 10, 10, 10]);
    const pooled = pooledValueStats([x, y])!;
    expect(pooled.sd).toBeCloseTo(5, 10);
    expect((x.sd + y.sd) / 2).toBe(0);
  });
  it("単位が混ざる・空・不正な n は null", () => {
    expect(pooledValueStats([])).toBeNull();
    expect(pooledValueStats([{ n: 3, mean: 1, sd: 1, unit: "HU" }, { n: 3, mean: 1, sd: 1, unit: "SUV" }])).toBeNull();
    expect(pooledValueStats([{ n: 0, mean: 1, sd: 1, unit: "HU" }])).toBeNull();
    expect(pooledValueStats([{ n: 3, mean: NaN, sd: 1, unit: "HU" }])).toBeNull();
  });
});

describe("sumAreaMm2", () => {
  it("値の無いものは足さず、件数で示す（0 で埋めない）", () => {
    expect(sumAreaMm2([10, undefined, 5.5])).toEqual({ sum: 15.5, counted: 2, missing: 1 });
    expect(sumAreaMm2([])).toEqual({ sum: 0, counted: 0, missing: 0 });
  });
});

describe("pooledInputsOf（合算に入れる値の選び方）", () => {
  const v = (n: number, mean: number) => ({ n, mean, sd: 1, unit: "HU" });
  it("形とマスクの両方を拾い、画素数が足される", () => {
    const items = pooledInputsOf([{ stats: { values: v(1634, 340) } }, { mask: { values: v(6684, 279) } }]);
    expect(items.map((i) => i.n)).toEqual([1634, 6684]);
    expect(pooledValueStats(items)!.n).toBe(8318);
  });
  it("マスクの行はマスクの値を優先する", () => {
    expect(pooledInputsOf([{ mask: { values: v(5, 1) }, stats: { values: v(9, 2) } }])).toEqual([{ n: 5, mean: 1, sd: 1, unit: "HU" }]);
  });
  it("値の無い行（空のマスク・未計測）は除き、全部無ければ空", () => {
    expect(pooledInputsOf([{ mask: {} }, { stats: {} }, {}])).toEqual([]);
    expect(pooledInputsOf([{ mask: {} }, { stats: { values: v(3, 1) } }])).toHaveLength(1);
  });
});
