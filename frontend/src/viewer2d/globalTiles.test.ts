import { describe, expect, it } from "vitest";
import { parseViewMode } from "./viewMode";
import { PATIENT_PALETTE, assignPatientColors, patientInitial } from "./patientColor";
import { placeNear, reconcileOrder, swapOrder } from "./globalOrder";
import { defaultTargets, spansPatients } from "./tileScope";

describe("parseViewMode", () => {
  it("未保存・不正値は既定の全患者", () => {
    expect(parseViewMode(null)).toBe("global");
    expect(parseViewMode(undefined)).toBe("global");
    expect(parseViewMode("")).toBe("global");
    expect(parseViewMode("nonsense")).toBe("global");
  });
  it("tabs だけがタブ", () => {
    expect(parseViewMode("tabs")).toBe("tabs");
    expect(parseViewMode("global")).toBe("global");
  });
});

describe("assignPatientColors", () => {
  it("出現順に重ならない番号を割り当てる", () => {
    const m = assignPatientColors(new Map(), ["a", "b", "c"]);
    expect([m.get("a"), m.get("b"), m.get("c")]).toEqual([0, 1, 2]);
  });
  it("表示中の患者の色は、他の患者が増減しても変わらない", () => {
    const m1 = assignPatientColors(new Map(), ["a", "b", "c"]);
    const m2 = assignPatientColors(m1, ["a", "c"]); // b を閉じた
    expect(m2.get("a")).toBe(0);
    expect(m2.get("c")).toBe(2);
    const m3 = assignPatientColors(m2, ["a", "c", "d"]); // 空いた 1 番を d が使う
    expect(m3.get("d")).toBe(1);
    expect(m3.get("a")).toBe(0);
    expect(m3.get("c")).toBe(2);
  });
  it("パレットを超えたら使い回すが、出現順の先頭は変えない", () => {
    const keys = Array.from({ length: PATIENT_PALETTE.length + 2 }, (_, i) => `p${i}`);
    const m = assignPatientColors(new Map(), keys);
    expect(m.get("p0")).toBe(0);
    expect(m.get(`p${PATIENT_PALETTE.length}`)).toBeLessThan(PATIENT_PALETTE.length);
    // 先頭 N 人は全員違う色
    expect(new Set(keys.slice(0, PATIENT_PALETTE.length).map((k) => m.get(k))).size).toBe(PATIENT_PALETTE.length);
  });
  it("パレットの solid は互いに異なり、同期の青・選択の橙とは別の色", () => {
    expect(new Set(PATIENT_PALETTE.map((c) => c.solid)).size).toBe(PATIENT_PALETTE.length);
    for (const c of PATIENT_PALETTE) {
      expect(c.solid.toLowerCase()).not.toBe("#0b5cad");
      expect(c.solid.toLowerCase()).not.toBe("#ff9800");
    }
  });
});

describe("patientInitial", () => {
  it("名前、無ければ ID の頭文字（大文字）", () => {
    expect(patientInitial("yamada", "X1")).toBe("Y");
    expect(patientInitial("", "d97258/11053")).toBe("D");
    expect(patientInitial("山田", null)).toBe("山");
  });
  it("取れなければ ?", () => {
    expect(patientInitial("", "")).toBe("?");
    expect(patientInitial(null, undefined)).toBe("?");
  });
});

describe("globalOrder", () => {
  it("reconcileOrder: 無いタイルを外し、新しいタイルを末尾に足す", () => {
    expect(reconcileOrder(["a", "b", "c"], ["a", "c", "d"])).toEqual(["a", "c", "d"]);
    expect(reconcileOrder(["c", "a"], ["a", "b", "c"])).toEqual(["c", "a", "b"]);
    expect(reconcileOrder([], ["x", "y"])).toEqual(["x", "y"]);
  });
  it("swapOrder: 入れ替える。無い・同じなら変えない", () => {
    expect(swapOrder(["a", "b", "c"], "a", "c")).toEqual(["c", "b", "a"]);
    expect(swapOrder(["a", "b"], "a", "a")).toEqual(["a", "b"]);
    expect(swapOrder(["a", "b"], "a", "zz")).toEqual(["a", "b"]);
  });
  it("placeNear: 前・後ろに置く。既にあれば元の位置から外す", () => {
    expect(placeNear(["a", "b", "c"], "x", "b", true)).toEqual(["a", "x", "b", "c"]);
    expect(placeNear(["a", "b", "c"], "x", "b", false)).toEqual(["a", "b", "x", "c"]);
    expect(placeNear(["a", "b", "c"], "a", "c", false)).toEqual(["b", "c", "a"]);
    expect(placeNear(["a", "b"], "x", "nope", true)).toEqual(["a", "b", "x"]);
  });
});

describe("defaultTargets", () => {
  const tiles = [
    { id: "t1", patientKey: "P1" },
    { id: "t2", patientKey: "P1" },
    { id: "t3", patientKey: "P2" },
  ];
  it("患者タブでは従来どおり全タイル", () => {
    expect(defaultTargets(tiles, "t3", false)).toEqual({ ids: ["t1", "t2", "t3"], ambiguous: false });
  });
  it("全患者モードで患者が 1 人なら全タイル", () => {
    expect(defaultTargets(tiles.slice(0, 2), null, true)).toEqual({ ids: ["t1", "t2"], ambiguous: false });
  });
  it("全患者モードで複数患者なら、最後に触ったタイルの患者のタイルだけ（一斉に効かせない）", () => {
    expect(defaultTargets(tiles, "t3", true)).toEqual({ ids: ["t3"], ambiguous: false });
    expect(defaultTargets(tiles, "t2", true)).toEqual({ ids: ["t1", "t2"], ambiguous: false });
  });
  it("全患者モードで複数患者かつ最後に触ったタイルが不明なら、対象なし（曖昧）", () => {
    expect(defaultTargets(tiles, null, true)).toEqual({ ids: [], ambiguous: true });
    expect(defaultTargets(tiles, "gone", true)).toEqual({ ids: [], ambiguous: true });
  });
});

describe("spansPatients", () => {
  it("2 人以上にまたがるか", () => {
    expect(spansPatients(["P1", "P1"])).toBe(false);
    expect(spansPatients(["P1", "P2"])).toBe(true);
    expect(spansPatients([])).toBe(false);
  });
});
