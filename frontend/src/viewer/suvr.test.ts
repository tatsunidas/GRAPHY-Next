import { describe, expect, it } from "vitest";
import { measureCandidate, referenceCandidates, suvrScale, type RefCandidate } from "./suvr";
import type { RoiPanelModel } from "./roiRows";

describe("suvrScale", () => {
  it("scale = 1 ÷ 参照の平均（未校正）。参照領域の平均が 1 になる", () => {
    const r = suvrScale(500) as { scale: number };
    expect(r.scale).toBeCloseTo(1 / 500, 15);
    expect(500 * r.scale).toBeCloseTo(1, 12);
  });
  it("SUV を先に掛けてあっても同じ SUVR になる（乗数が打ち消し合う）", () => {
    const modalityRef = 500; // Bq/mL
    const s = 3e-4; // 先に掛けた SUV 乗数
    const direct = suvrScale(modalityRef) as { scale: number };
    const viaSuv = suvrScale(modalityRef * s, s) as { scale: number }; // 統計は校正込み（SUV）で返る
    expect(Math.abs(viaSuv.scale / direct.scale - 1)).toBeLessThan(1e-12);
    // 目的 2000 Bq/mL は、どちらでも SUVR 4.0
    expect(2000 * viaSuv.scale).toBeCloseTo(4, 12);
  });
  it("参照の平均が 0 以下・非有限はエラー（負例）", () => {
    for (const v of [0, -1, NaN, Infinity]) expect(suvrScale(v)).toEqual({ error: "refNotPositive" });
  });
  it("今の乗数が 0 以下なら無いものとして 1 を使う", () => {
    expect((suvrScale(2, 0) as { scale: number }).scale).toBe(0.5);
  });
});

const row = (o: Record<string, unknown>) => o as never;
const model: RoiPanelModel = {
  rois: [
    row({ rowKind: "shape", key: "a", uid: "a", tool: "RectangleROI", kind: "area", seriesUid: "S1", groupId: "g1", groupName: "小脳" }),
    row({ rowKind: "shape", key: "b", uid: "b", tool: "EllipticalROI", kind: "area", seriesUid: "S1", groupId: "g1", groupName: "小脳" }),
    row({ rowKind: "shape", key: "c", uid: "c", tool: "RectangleROI", kind: "area", seriesUid: "S2" }), // 別シリーズ
    row({ rowKind: "shape", key: "l", uid: "l", tool: "OpenFreehandROI", kind: "line", seriesUid: "S1" }), // 線
    row({ rowKind: "shape", key: "p", uid: "p", tool: "ProbeTool", kind: "point", seriesUid: "S1" }), // 点
    row({ rowKind: "sphere", key: "sp", id: "sp", seriesUid: "S1" }), // 球（画素を持たない）
    row({ rowKind: "painted", key: "m#1", maskId: "m", segIndex: 1, name: "VOI", single: true, seriesUid: "S1" }),
    row({ rowKind: "painted", key: "m2#2", maskId: "m2", segIndex: 2, name: "VOI 2", single: false, seriesUid: "S1" }),
  ],
  measures: [],
};

describe("referenceCandidates", () => {
  const cands = referenceCandidates(model, "S1", (u) => `ROI ${u}`);
  it("この PET シリーズの面の ROI・VOI・グループだけが候補。別シリーズ・線・点・球は外れる", () => {
    expect(cands.map((c) => c.key).sort()).toEqual(["a", "b", "g:g1", "m#1", "m2#2"].sort());
    expect(cands.find((c) => c.key === "c")).toBeUndefined();
  });
  it("グループは 2 つのメンバーを持つ。単一 segment の VOI は segmentIndex が未指定（マスク全体）", () => {
    expect(cands.find((c) => c.key === "g:g1")!.members.map((m) => m.key)).toEqual(["a", "b"]);
    expect(cands.find((c) => c.key === "m#1")!.members[0].segmentIndex).toBeUndefined();
    expect(cands.find((c) => c.key === "m2#2")!.members[0].segmentIndex).toBe(2);
  });
});

describe("measureCandidate", () => {
  const one: RefCandidate = { key: "a", label: "a", group: false, members: [{ key: "a", label: "a", kind: "shape", uid: "a" }] };
  const grp: RefCandidate = {
    key: "g:1", label: "g", group: true,
    members: [{ key: "a", label: "a", kind: "shape", uid: "a" }, { key: "b", label: "b", kind: "shape", uid: "b" }],
  };
  it("単独は平均・n・単位をそのまま", () => {
    const m = measureCandidate(one, () => ({ n: 100, mean: 500, sd: 0, unit: "BQML" }));
    expect(m).toMatchObject({ mean: 500, n: 100, unit: "BQML" });
    expect(m.reason).toBeUndefined();
  });
  it("グループは画素数で重み付けした合算の平均", () => {
    const vals: Record<string, { n: number; mean: number; sd: number; unit: string }> = {
      a: { n: 100, mean: 400, sd: 0, unit: "BQML" },
      b: { n: 300, mean: 600, sd: 0, unit: "BQML" },
    };
    expect(measureCandidate(grp, (k) => vals[k]).mean).toBeCloseTo(550, 9);
  });
  it("読めないメンバー・単位混在・平均 0 以下は理由つき（値は出さない）", () => {
    expect(measureCandidate(one, () => ({ missing: "refNoPixels" })).reason).toBe("refNoPixels");
    expect(measureCandidate(one, () => undefined).reason).toBe("refNoPixels");
    const mixed = measureCandidate(grp, (k) => ({ n: 10, mean: 5, sd: 0, unit: k === "a" ? "BQML" : "HU" }));
    expect(mixed.reason).toBe("refMixedUnits");
    expect(mixed.mean).toBeUndefined();
    expect(measureCandidate(one, () => ({ n: 10, mean: 0, sd: 0, unit: "BQML" })).reason).toBe("refNotPositive");
    expect(measureCandidate(one, () => ({ n: 10, mean: -3, sd: 0, unit: "BQML" })).reason).toBe("refNotPositive");
  });
});
