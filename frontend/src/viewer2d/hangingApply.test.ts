import { describe, expect, it } from "vitest";
import { canApplyHanging, orderAfterApply, planHanging, restoreSnapshot, takeSnapshot, type HangingPatient } from "./hangingApply";
import { parseHangingProtocol, type HangingProtocol } from "./hangingProtocol";

function protocol(extra: Record<string, unknown> = {}): HangingProtocol {
  const r = parseHangingProtocol({
    id: "p", name: "P", version: 1,
    slots: [{ series: { descriptionContains: "t1" } }, { series: { descriptionContains: "t2" } }, { series: { descriptionContains: "dwi" } }],
    grid: { rows: 1, cols: 3 }, gridPortrait: { rows: 3, cols: 1 },
    ...extra,
  });
  if (!r.ok) throw new Error(r.errors.join(","));
  return r.protocol;
}
const s = (uid: string, num: number, desc: string, modality = "MR", sopClassUid: string | null = null) =>
  ({ seriesInstanceUid: uid, seriesNumber: num, seriesDescription: desc, modality, sopClassUid });
const study = { modality: "MR", modalities: ["MR"], studyDescription: "Brain" };

describe("planHanging", () => {
  it("スロットの順に並べ、欠けたスロットを詰めて添字を返す", () => {
    const r = planHanging(protocol(), study, [s("b", 2, "T2"), s("a", 5, "T1")], { portrait: false });
    expect(r).toMatchObject({ ok: true, rows: 1, cols: 3, unfilledSlots: [2], nonImageCount: 0 });
    expect(r.ok && r.series.map((x) => x.seriesInstanceUid)).toEqual(["a", "b"]);
  });

  it("縦長の窓では gridPortrait", () => {
    expect(planHanging(protocol(), study, [s("a", 1, "T1")], { portrait: true })).toMatchObject({ rows: 3, cols: 1 });
  });

  it("画像でないシリーズは並べる前に外す（番号が先でもスロットを取らない）", () => {
    // 1.2.840.10008.5.1.4.1.1.104.1 = Encapsulated PDF
    const pdf = s("pdf", 1, "T1 report", "DOC", "1.2.840.10008.5.1.4.1.1.104.1");
    const r = planHanging(protocol(), study, [pdf, s("a", 2, "T1")], { portrait: false });
    expect(r.nonImageCount).toBe(1);
    expect(r.ok && r.series.map((x) => x.seriesInstanceUid)).toEqual(["a"]);
  });

  it("合うシリーズが無いときと、match に合わないときは理由を分ける", () => {
    expect(planHanging(protocol(), study, [s("x", 1, "localizer")], { portrait: false })).toMatchObject({ ok: false, reason: "no-series" });
    expect(planHanging(protocol({ match: { modality: ["CT"] } }), study, [s("a", 1, "T1")], { portrait: false }))
      .toMatchObject({ ok: false, reason: "no-match" });
  });
});

describe("canApplyHanging", () => {
  it("全患者の表示は患者が 1 人のときだけ。患者タブは人数を問わない", () => {
    expect(canApplyHanging(true, 1)).toBe(true);
    expect(canApplyHanging(true, 2)).toBe(false);
    expect(canApplyHanging(false, 2)).toBe(true);
    expect(canApplyHanging(false, 0)).toBe(false);
  });
});

type T = { id: string; transient?: object; mark?: number };
const patient = (tiles: T[]): HangingPatient<T> => ({ patientKey: "k", tiles, gridRows: 2, gridCols: 4, soloTileId: "b" });
const view = { order: ["z", "b", "a"], grid: { rows: 5, cols: 6, solo: null } };

describe("takeSnapshot / restoreSnapshot", () => {
  it("タイルの順・行×列・単独表示・全患者の表示を戻す", () => {
    const before = patient([{ id: "a", mark: 1 }, { id: "b", mark: 2 }]);
    const snap = takeSnapshot(before, view);
    const after = { ...patient([{ id: "c" }]), gridRows: 1, gridCols: 1, soloTileId: null };
    expect(restoreSnapshot(after, snap)).toEqual(before);
    expect(snap.global).toEqual(view);
  });

  it("適用の前の一時タイルは写さない。後で開いた一時タイルは閉じずに残す", () => {
    const snap = takeSnapshot({ ...patient([{ id: "a" }, { id: "t0", transient: {} }]), soloTileId: "t0" }, view);
    expect(snap.tiles.map((x) => x.id)).toEqual(["a"]);
    expect(snap.soloTileId).toBeNull();
    const r = restoreSnapshot(patient([{ id: "c" }, { id: "t1", transient: {} }]), snap);
    expect(r.tiles.map((x) => x.id)).toEqual(["a", "t1"]);
  });

  it("写した表示順は、元の配列を後から書き換えても変わらない", () => {
    const order = ["a"];
    const snap = takeSnapshot(patient([{ id: "a" }]), { ...view, order });
    order.push("q");
    expect(snap.global.order).toEqual(["a"]);
  });
});

describe("orderAfterApply", () => {
  it("他の患者の順は保ち、置き換えた患者は新しい順で末尾に置く（残るタイルも新しい順に従う）", () => {
    expect(orderAfterApply(["x", "a", "y", "b"], ["a", "b"], ["c", "a"])).toEqual(["x", "y", "c", "a"]);
  });
});
