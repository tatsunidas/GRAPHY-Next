/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { carryOverSpheres, selectRestorableSpheres, toSavedSphere } from "./sphereRestore";
import type { SavedSphere } from "./roiPersistence";
import type { Sphere3D } from "./sphere3dStore";

const saved = (uid: string, sop: string): SavedSphere => ({
  uid, studyUid: "st", seriesUid: "se", refSopInstanceUid: sop, center: [0, 0, 0], radiusMm: 3, c: "all", t: "all", color: "#fff", visible: true,
});
const store = (over: Partial<Sphere3D> = {}): Sphere3D => ({
  id: "sphere3d-1", uid: "u1", studyUid: "st", seriesUid: "se", refImageId: "img1", center: [1, 2, 3], radiusMm: 4,
  c: "all", t: 0, patientKey: "P", label: "Sphere", color: "#00e5ff", visible: true, ...over,
});

describe("toSavedSphere", () => {
  it("SOP とシリーズが分かる球は保存形になり、imageId・id は含まない", () => {
    const out = toSavedSphere(store({ groupId: "g", groupName: "G" }), (id) => (id === "img1" ? "SOP1" : null))!;
    expect(out).toMatchObject({ uid: "u1", refSopInstanceUid: "SOP1", seriesUid: "se", groupId: "g", groupName: "G", t: 0 });
    expect(out).not.toHaveProperty("refImageId");
    expect(out).not.toHaveProperty("id");
  });
  it("シリーズ不明・SOP 不明の球は復元できないので保存しない", () => {
    expect(toSavedSphere(store({ seriesUid: "" }), () => "SOP1")).toBeNull();
    expect(toSavedSphere(store(), () => null)).toBeNull();
  });
});

describe("carryOverSpheres（開いていないシリーズの球を消さない）", () => {
  it("参照 SOP が開いていない球は持ち越し、開いているのに無い球は落とす（削除）", () => {
    const live = [saved("live", "A")];
    const loaded = [saved("live", "A"), saved("hidden", "B"), saved("deleted", "A")];
    const out = carryOverSpheres(live, loaded, new Set(["A"]));
    expect(out.map((s) => s.uid)).toEqual(["live", "hidden"]);
  });
  it("現存の球は読み込み済みの同じ uid で上書きされない（重複しない）", () => {
    const live = [{ ...saved("x", "A"), radiusMm: 9 }];
    const out = carryOverSpheres(live, [saved("x", "B")], new Set());
    expect(out).toEqual(live);
  });
});

describe("selectRestorableSpheres", () => {
  it("スタックに参照 SOP がある球だけを戻し、同じ uid が既にあれば足さない", () => {
    const resolve = (sop: string) => (sop === "A" ? "imgA" : null);
    const out = selectRestorableSpheres([saved("a", "A"), saved("b", "B"), saved("c", "A")], resolve, new Set(["c"]));
    expect(out.map((o) => [o.sphere.uid, o.imageId])).toEqual([["a", "imgA"]]);
  });
});
