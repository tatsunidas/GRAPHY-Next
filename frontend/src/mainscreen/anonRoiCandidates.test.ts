/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchRoiDocument = vi.fn();
const fetchSeriesLayout = vi.fn();

vi.mock("../viewer/roiPersistenceApi", () => ({ fetchRoiDocument: (k: string) => fetchRoiDocument(k) }));
vi.mock("../api", () => ({ fetchSeriesLayout: (a: string, b: string) => fetchSeriesLayout(a, b) }));

const { loadAnonRoiCandidates } = await import("./anonRoiCandidates");

const STUDY = {
  studyInstanceUid: "1.2.study",
  patientId: "D97258/11053", // 🔴 `/` を含む実データ。patientKey はクエリで渡る前提。
  patientName: "TEST",
  studyDate: null,
  studyDescription: null,
  modality: "CT",
  numberOfInstances: 3,
};

const SERIES = [
  { seriesInstanceUid: "1.2.series", modality: "CT", seriesNumber: 3, seriesDescription: "AXIAL", numberOfInstances: 3 },
] as never[];

/** 軸平行アキシャル、1 mm 等方、IPP は原点。画素 (x,y) ⇔ world (x, y, 0)。 */
const LAYOUT = {
  nZ: 1, nC: 1, nT: 1,
  cDimension: null, tDimension: null,
  cells: [{ c: 0, z: 0, t: 0, sopInstanceUid: "1.2.sop" }],
  imageOrientationPatient: [1, 0, 0, 0, 1, 0],
  pixelSpacingRow: 1,
  pixelSpacingCol: 1,
  imageWidth: 512,
  imageHeight: 512,
  zSpatial: [{ z: 0, imagePositionPatient: [0, 0, 0] }],
  frameOfReferenceUID: "1.2.for",
};

/** 保存形の ROI（world = 患者 LPS mm）。 */
function savedRoi(over: Record<string, unknown> = {}) {
  return {
    roiUid: "roi-1",
    tool: "RectangleROI",
    sopInstanceUid: "1.2.sop",
    seriesUid: "1.2.series",
    points: [
      [10, 10, 0],
      [20, 10, 0],
      [20, 20, 0],
      [10, 20, 0],
    ],
    label: "右上ラベル",
    ...over,
  };
}

function docWith(rois: unknown[]) {
  return { patientKey: STUDY.patientId, json: JSON.stringify({ schema: 1, rois }), roiCount: rois.length, updatedAt: null, version: 1 };
}

beforeEach(() => {
  fetchRoiDocument.mockReset();
  fetchSeriesLayout.mockReset();
  fetchSeriesLayout.mockResolvedValue(LAYOUT);
});

describe("loadAnonRoiCandidates", () => {
  it("閉じた面 ROI を画素座標の多角形にする", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi()]));
    const { candidates, skipped } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(skipped).toEqual([]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].label).toBe("右上ラベル");
    expect(candidates[0].seriesLabel).toBe("#3 AXIAL");
    expect(candidates[0].polygon.xs).toEqual([10, 20, 20, 10]);
    expect(candidates[0].polygon.ys).toEqual([10, 10, 20, 20]);
    // 適用先は SOP で指定する（index は並び順が変われば別スライスを塗る）。
    expect(candidates[0].polygon.sopInstanceUids).toEqual(["1.2.sop"]);
  });

  it("患者鍵は PatientID（`/` を含んでも素通し。クエリで渡る前提）", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi()]));
    await loadAnonRoiCandidates(STUDY, SERIES);
    expect(fetchRoiDocument).toHaveBeenCalledWith("D97258/11053");
  });

  it("🔴 線・点・角度は候補にしない（面積が無いので 1 画素も塗れない）", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([
      savedRoi({ roiUid: "a", tool: "Length" }),
      savedRoi({ roiUid: "b", tool: "Probe" }),
      savedRoi({ roiUid: "c", tool: "Angle" }),
    ]));
    const { candidates, skipped } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates).toEqual([]);
    expect(skipped.map((s) => s.reason)).toEqual(["notClosedArea", "notClosedArea", "notClosedArea"]);
  });

  it("開いた輪郭も候補にしない", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([
      savedRoi({ tool: "GraphyPolygonROI", isOpenContour: true, polyline: savedRoi().points }),
    ]));
    const { candidates, skipped } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates).toEqual([]);
    expect(skipped[0].reason).toBe("notClosedArea");
  });

  it("🔴 楕円は 4 ハンドルではなく多角形に開く（bbox に潰さない）", async () => {
    // 軸平行 bbox に潰すと、回した楕円で長軸方向が塗り足りなくなる。
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi({ tool: "EllipticalROI" })]));
    const { candidates } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates[0].polygon.xs.length).toBeGreaterThan(100);
  });

  it("別スタディのシリーズに属する ROI は黙って除く（保存は患者単位なので普通に混ざる）", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi({ seriesUid: "9.9.other" })]));
    const { candidates, skipped } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates).toEqual([]);
    expect(skipped).toEqual([]);
  });

  it("マルチフレームはフレーム番号も適用先に載せる（XA で全フレームを塗らない）", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi({ frame: 4 })]));
    const { candidates } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates[0].polygon.frames).toEqual([4]);
  });

  it("幾何が引けないシリーズ（XA）は world/画素間隔のフォールバックで拾う", async () => {
    fetchSeriesLayout.mockResolvedValue({
      ...LAYOUT,
      imageOrientationPatient: null,
      zSpatial: null,
      pixelSpacingRow: 2,
      pixelSpacingCol: 2,
    });
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi()]));
    const { candidates } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates[0].polygon.xs).toEqual([5, 10, 10, 5]);
  });

  it("🔴 SOP がそのシリーズに無い ROI は候補にしない（幾何なしフォールバックで別の場所を塗らない）", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi({ sopInstanceUid: "9.9.not-in-this-series" })]));
    const { candidates, skipped } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates).toEqual([]);
    expect(skipped[0].reason).toBe("noGeometry");
  });

  it("🚨 実データの保存には seriesUid が無い —— scope から引く（実機で 0 件になった）", async () => {
    // `roiRestore.collectRoisForPatient` は `ct` をわざと渡さないので `seriesUid` は空。
    // ROI ごとに作成時で固定される `scope` が本当の出どころ。
    fetchRoiDocument.mockResolvedValue(docWith([
      savedRoi({ seriesUid: undefined, scope: { studyUid: "1.2.study", seriesUid: "1.2.series", z: 0, c: 0, t: 0 } }),
    ]));
    const { candidates } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].seriesUid).toBe("1.2.series");
  });

  it("seriesUid も scope も無ければ候補にしない（当てにいかない）", async () => {
    fetchRoiDocument.mockResolvedValue(docWith([savedRoi({ seriesUid: undefined })]));
    const { candidates, skipped } = await loadAnonRoiCandidates(STUDY, SERIES);
    expect(candidates).toEqual([]);
    expect(skipped[0].reason).toBe("noSeries");
  });

  it("ROI が 1 件も保存されていなければ空", async () => {
    fetchRoiDocument.mockResolvedValue({ patientKey: "x", json: null, roiCount: 0, updatedAt: null, version: null });
    expect(await loadAnonRoiCandidates(STUDY, SERIES)).toEqual({ candidates: [], skipped: [] });
  });
});
