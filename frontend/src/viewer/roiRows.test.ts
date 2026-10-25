/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import { buildRoiPanelModel, paintedRowKey, paintedRowName, type RoiRowEnv } from "./roiRows";

const ann = (uid: string, toolName: string, closed?: boolean) => ({
  annotationUID: uid,
  metadata: { toolName },
  data: closed === undefined ? {} : { contour: { closed } },
});

type Meta = ReturnType<RoiRowEnv["metaOf"]>;
const env = (metas: Record<string, Meta> = {}, hidden: string[] = []): RoiRowEnv => ({
  patientKey: "P1",
  metaOf: (id) => metas[id],
  isAnnotationVisible: (uid) => !hidden.includes(uid),
  isLocked: () => false,
  scopeText: (id) => `scope:${id}`,
  isSegmentVisible: (id, i) => !hidden.includes(`${id}#${i}`),
});

describe("buildRoiPanelModel", () => {
  it("形の ROI は ROI、計測は計測の区画に分かれる", () => {
    const m = buildRoiPanelModel(
      [ann("a", "RectangleROI"), ann("b", "Length"), ann("c", "Probe"), ann("d", "Bidirectional"), ann("e", "PlanarFreehandROI", false)],
      [], [], env(), () => [1],
    );
    expect(m.rois.map((r) => [r.key, r.rowKind === "shape" ? r.kind : r.rowKind])).toEqual([["a", "area"], ["e", "line"]]);
    expect(m.measures.map((r) => r.uid)).toEqual(["b", "c", "d"]);
  });

  it("種別不明のツールは落とさず計測の区画に出す", () => {
    const m = buildRoiPanelModel([ann("x", "ArrowAnnotate")], [], [], env(), () => [1]);
    expect(m.rois).toHaveLength(0);
    expect(m.measures.map((r) => [r.uid, r.kind])).toEqual([["x", null]]);
  });

  it("塗りの ROI は segment ごとに 1 行で、キーが一意", () => {
    const m = buildRoiPanelModel(
      [], [{ segmentationId: "s1", label: "Liver" }, { segmentationId: "s2" }], [],
      env({ s1: { segmentLabels: { "1": "Liver", "3": "Spleen" } } }),
      (id) => (id === "s1" ? [1, 2, 3] : [1]),
    );
    const painted = m.rois.filter((r) => r.rowKind === "painted");
    expect(painted).toHaveLength(4);
    expect(new Set(painted.map((r) => r.key)).size).toBe(4);
    expect(painted.map((r) => r.rowKind === "painted" && [r.maskId, r.segIndex, r.single, r.name])).toEqual([
      ["s1", 1, false, "Liver"],
      ["s1", 2, false, "Liver #2"],
      ["s1", 3, false, "Spleen"],
      ["s2", 1, true, "s2"],
    ]);
  });

  it("表示状態・スコープを行に載せる", () => {
    const m = buildRoiPanelModel(
      [ann("a", "CircleROI")], [{ segmentationId: "s1" }], [], env({}, ["a", "s1#2"]), () => [1, 2],
    );
    const [a, p1, p2] = m.rois;
    expect(a.rowKind === "shape" && [a.visible, a.scope]).toEqual([false, "scope:a"]);
    expect(p1.rowKind === "painted" && p1.visible).toBe(true);
    expect(p2.rowKind === "painted" && [p2.visible, p2.scope]).toEqual([false, "scope:s1"]);
  });

  it("球は ROI の行として出る（順序: 形 → 塗り → 球）", () => {
    const m = buildRoiPanelModel(
      [ann("a", "EllipticalROI")], [{ segmentationId: "s1" }], [{ id: "sphere3d-1" }], env(), () => [1],
    );
    expect(m.rois.map((r) => r.rowKind)).toEqual(["shape", "painted", "sphere"]);
  });

  it("他の患者のものは出さない（患者不明は出す）", () => {
    const m = buildRoiPanelModel(
      [ann("a", "RectangleROI"), ann("b", "RectangleROI"), ann("c", "Length")],
      [{ segmentationId: "s1" }, { segmentationId: "s2" }],
      [{ id: "sp1", patientKey: "P2" }, { id: "sp2" }],
      env({ a: { patientKey: "P2" }, b: { patientKey: "P1" }, c: { patientKey: "P2" }, s1: { patientKey: "P2" } }),
      () => [1],
    );
    expect(m.rois.map((r) => r.key)).toEqual(["b", "s2#1", "sp2"]);
    expect(m.measures).toHaveLength(0);
  });
});

describe("buildRoiPanelModel（全患者表示: shown）", () => {
  const shownEnv = (metas: Record<string, Meta>, shown: RoiRowEnv["shown"]): RoiRowEnv => ({ ...env(metas), shown });
  const A = { patientKey: "P1", scope: { seriesUid: "S1" } };
  const B = { patientKey: "P2", scope: { seriesUid: "S9" } };

  it("表示中の全患者の ROI が出て、行に患者・シリーズの印が付く", () => {
    const m = buildRoiPanelModel(
      [ann("a", "RectangleROI"), ann("b", "RectangleROI"), ann("c", "Length")],
      [], [], shownEnv({ a: A, b: B, c: B }, [{ patientKey: "P1", seriesUid: "S1" }, { patientKey: "P2", seriesUid: "S9" }]), () => [1],
    );
    expect(m.rois.map((r) => [r.key, r.patientKey, r.seriesUid])).toEqual([["a", "P1", "S1"], ["b", "P2", "S9"]]);
    expect(m.measures.map((r) => [r.uid, r.patientKey, r.seriesUid])).toEqual([["c", "P2", "S9"]]);
  });

  it("表示していないシリーズ・患者の ROI は出さない（負例）", () => {
    const m = buildRoiPanelModel(
      [ann("a", "RectangleROI"), ann("b", "RectangleROI"), ann("c", "RectangleROI")],
      [], [], shownEnv({ a: A, b: { patientKey: "P1", scope: { seriesUid: "OTHER" } }, c: B }, [{ patientKey: "P1", seriesUid: "S1" }]), () => [1],
    );
    expect(m.rois.map((r) => r.key)).toEqual(["a"]);
  });

  it("シリーズ不明の ROI は、患者が表示中なら出す。患者不明は常に出す", () => {
    const m = buildRoiPanelModel(
      [ann("a", "RectangleROI"), ann("b", "RectangleROI")],
      [], [], shownEnv({ a: { patientKey: "P1" } }, [{ patientKey: "P1", seriesUid: "S1" }]), () => [1],
    );
    expect(m.rois.map((r) => r.key)).toEqual(["a", "b"]);
  });

  it("塗り・球も表示中のシリーズで絞る", () => {
    const m = buildRoiPanelModel(
      [], [{ segmentationId: "s1" }, { segmentationId: "s2" }],
      [{ id: "sp1", patientKey: "P1", seriesUid: "S1" }, { id: "sp2", patientKey: "P1", seriesUid: "Z" }],
      shownEnv({ s1: A, s2: B }, [{ patientKey: "P1", seriesUid: "S1" }]), () => [1],
    );
    expect(m.rois.map((r) => r.key)).toEqual(["s1#1", "sp1"]);
  });
});

describe("buildRoiPanelModel（グループ）", () => {
  it("形の ROI・計測の行にグループの鍵と名前が載る", () => {
    const m = buildRoiPanelModel(
      [ann("a", "RectangleROI"), ann("b", "Length"), ann("c", "RectangleROI")],
      [], [],
      env({ a: { groupId: "g1", groupName: "病変 A" }, b: { groupId: "g1", groupName: "病変 A" } }),
      () => [1],
    );
    expect(m.rois.map((r) => r.rowKind === "shape" && [r.key, r.groupId, r.groupName])).toEqual([
      ["a", "g1", "病変 A"],
      ["c", undefined, undefined],
    ]);
    expect(m.measures.map((r) => [r.uid, r.groupId])).toEqual([["b", "g1"]]);
  });
});

describe("paintedRowName", () => {
  it("segment が 1 つなら属性編集の label を正とする", () => {
    expect(paintedRowName({ label: "Edited", segmentLabels: { "1": "Old" } }, "id", 1, true)).toBe("Edited");
    expect(paintedRowName({ segmentLabels: { "1": "Imported" } }, "id", 1, true)).toBe("Imported");
    expect(paintedRowName(undefined, "id", 1, true)).toBe("id");
  });
  it("複数なら segment 名、無ければ「<名前> #<番号>」", () => {
    expect(paintedRowName({ label: "M", segmentLabels: { "2": "Kidney" } }, "id", 2, false)).toBe("Kidney");
    expect(paintedRowName({ label: "M" }, "id", 3, false)).toBe("M #3");
  });
  it("キーは maskId#segIndex", () => {
    expect(paintedRowKey("graphy-seg-1", 4)).toBe("graphy-seg-1#4");
  });
});
