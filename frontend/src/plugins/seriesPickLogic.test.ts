import { describe, expect, it } from "vitest";
import type { Series } from "../api";
import { isEligible, normalizeOptions, pickKey, studyState, toResult, toggleSeries, toggleStudy } from "./seriesPickLogic";

const s = (uid: string, modality: string | null): Series => ({
  seriesInstanceUid: uid,
  modality,
  seriesNumber: 1,
  seriesDescription: null,
  sopClassUid: null,
  numberOfInstances: 10,
});
const CT1 = s("1.1", "CT");
const CT2 = s("1.2", "CT");
const MR1 = s("1.3", "MR");
const NONE = s("1.4", null);
const ALL = [CT1, CT2, MR1, NONE];

describe("選べるシリーズの制限", () => {
  it("制限なしは全部選べる。制限があるときは、その種類だけ（種類が分からないものは選べない）", () => {
    expect(ALL.map((x) => isEligible(x, []))).toEqual([true, true, true, true]);
    expect(ALL.map((x) => isEligible(x, ["CT"]))).toEqual([true, true, false, false]);
    expect(isEligible(s("x", "ct"), ["CT"])).toBe(true); // 大文字小文字は問わない
  });
});

describe("スタディの三状態とチェック", () => {
  it("選べるシリーズが 0 件なら none（チェックできない）", () => {
    expect(studyState("S", [MR1], new Set(), ["CT"])).toBe("none");
    expect(toggleStudy("S", [MR1], new Set(), ["CT"], true).size).toBe(0);
  });

  it("none → some → all の判定は、選べるシリーズだけを数える", () => {
    expect(studyState("S", ALL, new Set(), ["CT"])).toBe("none");
    expect(studyState("S", ALL, new Set([pickKey("S", "1.1")]), ["CT"])).toBe("some");
    expect(studyState("S", ALL, new Set([pickKey("S", "1.1"), pickKey("S", "1.2")]), ["CT"])).toBe("all");
    // 制限外（MR）を選んでいても、CT が全部なら all（制限外は判定に入れない）
    expect(studyState("S", ALL, new Set([pickKey("S", "1.1"), pickKey("S", "1.2"), pickKey("S", "1.3")]), ["CT"])).toBe("all");
  });

  it("🔴 スタディのチェックは選べるものだけを足し、制限外は入らない。全部選べていれば外す", () => {
    const on = toggleStudy("S", ALL, new Set(), ["CT"], true);
    expect([...on]).toEqual([pickKey("S", "1.1"), pickKey("S", "1.2")]);
    expect(toggleStudy("S", ALL, on, ["CT"], true).size).toBe(0);
    // 一部だけ選んでいるときは、残りを足す（外さない）
    const some = toggleStudy("S", ALL, new Set([pickKey("S", "1.1")]), ["CT"], true);
    expect(some.size).toBe(2);
  });

  it("他のスタディの選択は動かさない", () => {
    const other = new Set([pickKey("T", "9.9")]);
    const on = toggleStudy("S", ALL, other, [], true);
    expect(on.has(pickKey("T", "9.9"))).toBe(true);
    const off = toggleStudy("S", ALL, on, [], true);
    expect([...off]).toEqual([pickKey("T", "9.9")]);
  });
});

describe("シリーズ 1 つのチェック", () => {
  it("制限外は動かない（選べない）", () => {
    expect(toggleSeries("S", MR1, new Set(), ["CT"], true).size).toBe(0);
    expect(toggleSeries("S", CT1, new Set(), ["CT"], true).has(pickKey("S", "1.1"))).toBe(true);
  });
  it("もう一度押すと外れる。選んだ順を保つ", () => {
    let sel = toggleSeries("S", CT2, new Set(), [], true);
    sel = toggleSeries("S", CT1, sel, [], true);
    expect(toResult(sel).map((r) => r.seriesUid)).toEqual(["1.2", "1.1"]);
    sel = toggleSeries("S", CT2, sel, [], true);
    expect(toResult(sel).map((r) => r.seriesUid)).toEqual(["1.1"]);
  });
  it("multiple:false は常に 1 件に置き換える（スタディのチェックも 1 件）", () => {
    let sel = toggleSeries("S", CT1, new Set(), [], false);
    sel = toggleSeries("S", CT2, sel, [], false);
    expect(toResult(sel)).toEqual([{ studyUid: "S", seriesUid: "1.2" }]);
    expect(toggleStudy("S", ALL, new Set(), [], false).size).toBe(1);
  });
});

describe("プラグインへ返す形", () => {
  it("🔴 キーは studyUid・seriesUid だけ（患者名・記述などを含めない）", () => {
    const r = toResult(new Set([pickKey("1.2.3", "1.2.3.4")]));
    expect(r).toEqual([{ studyUid: "1.2.3", seriesUid: "1.2.3.4" }]);
    expect(Object.keys(r[0]).sort()).toEqual(["seriesUid", "studyUid"]);
    expect(toResult(new Set())).toEqual([]);
  });
});

describe("プラグインから来た設定を整える", () => {
  it("タイトルは 120 字に切り、種類は英大文字だけを重複なしで残す", () => {
    expect(normalizeOptions({ title: "x".repeat(300) }).title).toHaveLength(120);
    expect(normalizeOptions({ modalities: ["ct", " MR ", "CT", "<b>", "", 5, "A".repeat(40)] }).modalities).toEqual(["CT", "MR"]);
    expect(normalizeOptions(undefined)).toEqual({ title: "", modalities: [], multiple: true });
    expect(normalizeOptions({ multiple: false }).multiple).toBe(false);
    expect(normalizeOptions({ title: 5, modalities: "CT" })).toEqual({ title: "", modalities: [], multiple: true });
  });
});
