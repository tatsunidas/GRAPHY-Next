/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 再構成 → プラグインへ渡す血管モデル（A7 の H11）の変換。
 *
 * <p>🔴 ここが静かに間違えると、外部モジュールは「もっともらしいが別物の血管」で計算し、
 * 返ってきた値は本体の絵にきれいに乗る。**測れていない点を埋めない**ことと、
 * **未校正を校正済みとして渡さない**ことを固定する。
 */
import { describe, expect, it } from "vitest";
import { buildQca3dVesselModel, diametersForPoints } from "./xaVesselModelBuild";
import type { CrossSectionProfile, Recon3DResult } from "./xaRecon3d";
import type { XaQcaRun } from "./xaRecon3dStore";

function section(d: number) {
  return {
    diameterAMm: d,
    diameterBMm: d,
    areaMm2: (Math.PI / 4) * d * d,
    equivalentDiameterMm: d,
    measurementAngleDeg: 90,
  };
}

function makeProfile(over: Partial<CrossSectionProfile> = {}): CrossSectionProfile {
  return {
    sections: [section(3), null, section(2)],
    minEquivalentDiameterMm: 2,
    minIndex: 2,
    minAreaMm2: Math.PI,
    medianMeasurementAngleDeg: 90,
    unavailable: null,
    ...over,
  };
}

function makeRun(id: string, over: Partial<XaQcaRun> = {}): XaQcaRun {
  return {
    imageId: `img#${id}`,
    runKey: `key-${id}`,
    studyUid: "1.2.3",
    seriesUid: `1.2.3.${id}`,
    sopInstanceUid: `1.2.3.${id}.1`,
    frameIndex: 0,
    label: `view ${id}`,
    geometry: { primaryAngleDeg: 30, secondaryAngleDeg: 0 } as never,
    centerline: [],
    diameters: [],
    diameterPathIndices: [],
    unit: "mm",
    diameterMethod: "densitometric",
    edited: false,
    calibrationSource: "user-catheter",
    calibrationTier: "calibrated",
    at: 1,
    ...over,
  };
}

function makeResult(over: Partial<Recon3DResult> = {}): Recon3DResult {
  return {
    points: [
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ],
    residualMm: [0, 0, 0],
    matchReprojectionPx: 1,
    anchorReprojectionPx: 0.7,
    anchorCount: 2,
    separationDeg: 60,
    lengthMm: 2,
    match: {} as never,
    foreshortening: { a: { visibleFraction: 0.9 } as never, b: null },
    warnings: [],
    acceptable: true,
    ...over,
  };
}

const ARGS = {
  runA: makeRun("a"),
  runB: makeRun("b"),
  result: makeResult(),
  profile: makeProfile(),
  refinement: null,
  diameterMethod: "densitometric" as const,
  separationDeg: 62,
  label: "3D QCA",
};

describe("diametersForPoints", () => {
  it("測れなかった点は null のまま（前後から補間しない）", () => {
    expect(diametersForPoints(3, makeProfile())).toEqual([3, null, 2]);
  });

  it("未校正なら全点 null（px の径を mm として渡さない）", () => {
    expect(diametersForPoints(3, makeProfile({ unavailable: "uncalibrated" }))).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("プロファイルが無ければ全点 null", () => {
    expect(diametersForPoints(2, null)).toEqual([null, null]);
  });

  it("プロファイルが短くても点数ぶん返す（長さがずれても添字はずらさない）", () => {
    expect(diametersForPoints(4, makeProfile())).toEqual([3, null, 2, null]);
  });
});

describe("buildQca3dVesselModel", () => {
  it("受け入れられない結果は渡さない（表示しないものを外へ出さない）", () => {
    expect(buildQca3dVesselModel({ ...ARGS, result: makeResult({ acceptable: false }) })).toBeNull();
  });

  it("点が 2 つ未満なら渡さない", () => {
    expect(buildQca3dVesselModel({ ...ARGS, result: makeResult({ points: [[0, 0, 0]] }) })).toBeNull();
  });

  it("中心線・径・トポロジが 1 区間として入る", () => {
    const m = buildQca3dVesselModel(ARGS)!;
    expect(m.kind).toBe("xa-qca3d");
    expect(m.segments).toHaveLength(1);
    expect(m.segments[0].id).toBe("main");
    expect(m.segments[0].parentId).toBeNull();
    expect(m.segments[0].points).toHaveLength(3);
    expect(m.segments[0].diameterMm).toEqual([3, null, 2]);
  });

  it("runId は方向の組で決まり、順番に依らない（選び直しで別物にならない）", () => {
    const a = buildQca3dVesselModel(ARGS)!;
    const b = buildQca3dVesselModel({ ...ARGS, runA: ARGS.runB, runB: ARGS.runA })!;
    expect(a.runId).toBe(b.runId);
  });

  it("校正の出自と縮退区分を落とさない（近似を実測として渡さない）", () => {
    const m = buildQca3dVesselModel({
      ...ARGS,
      runB: makeRun("b", { calibrationSource: "geometric-sid-sod", calibrationTier: "approximate" }),
    })!;
    expect(m.calibration.sources).toEqual(["user-catheter", "geometric-sid-sod"]);
    expect(m.calibration.tiers).toEqual(["calibrated", "approximate"]);
  });

  it("出自が読めない方向は unknown（uncalibrated と書き分ける）", () => {
    const m = buildQca3dVesselModel({
      ...ARGS,
      runB: makeRun("b", { calibrationSource: undefined, calibrationTier: undefined }),
    })!;
    expect(m.calibration.sources[1]).toBe("unknown");
    expect(m.calibration.tiers[1]).toBe("uncalibrated");
  });

  it("未校正のプロファイルは diameterCalibrated=false（FFR の入力にならないと言える）", () => {
    const m = buildQca3dVesselModel({
      ...ARGS,
      profile: makeProfile({ unavailable: "uncalibrated" }),
    })!;
    expect(m.calibration.diameterCalibrated).toBe(false);
    expect(m.segments[0].diameterMm.every((d) => d === null)).toBe(true);
  });

  it("角度補正の有無と短縮・再投影誤差を運ぶ（信用度の判断材料）", () => {
    const m = buildQca3dVesselModel(ARGS)!;
    expect(m.provenance.angleCorrected).toBe(false);
    expect(m.provenance.visibleFractions).toEqual([0.9, null]);
    expect(m.provenance.anchorReprojectionPx).toBeCloseTo(0.7, 6);
    expect(m.provenance.separationDeg).toBe(62);
  });

  it("SOP が片方無くても落ちない（null は詰める）", () => {
    const m = buildQca3dVesselModel({ ...ARGS, runB: makeRun("b", { sopInstanceUid: null }) })!;
    expect(m.provenance.sopUids).toEqual(["1.2.3.a.1"]);
  });
});

describe("H62 安定した鍵と向き（G9）", () => {
  /** 本体の URL（ポート）だけが違う 2 回の起動を作る。 */
  function runsAt(port: number) {
    const img = (sop: string) => `wadouri:http://127.0.0.1:${port}/api/instances/${sop}/frames/3/file`;
    return {
      runA: makeRun("a", { runKey: `${img("1.2.3.a.1")}#10,20-110,220`, frameIndex: 3 }),
      runB: makeRun("b", { runKey: `${img("1.2.3.b.1")}#15,25-115,225`, frameIndex: 7 }),
    };
  }

  it("🔴 起動し直して本体のポートが変わっても stableKey は変わらない（runId は変わる）", () => {
    const m1 = buildQca3dVesselModel({ ...ARGS, ...runsAt(8080) })!;
    const m2 = buildQca3dVesselModel({ ...ARGS, ...runsAt(51234) })!;
    expect(m1.runId).not.toBe(m2.runId);
    expect(m1.stableKey).toBe(m2.stableKey);
    expect(m1.stableKey).toBe("xa-qca3d:1.2.3.a.1@3#10,20-110,220|1.2.3.b.1@7#15,25-115,225");
  });

  it("方向 A・B を入れ替えても同じ鍵", () => {
    const { runA, runB } = runsAt(8080);
    const m1 = buildQca3dVesselModel({ ...ARGS, runA, runB })!;
    const m2 = buildQca3dVesselModel({ ...ARGS, runA: runB, runB: runA })!;
    expect(m1.stableKey).toBe(m2.stableKey);
  });

  it("同じフレームでも解析区間が違えば別の鍵（分岐部で区間を取り違えない）", () => {
    const { runA, runB } = runsAt(8080);
    const other = { ...runA, runKey: runA.runKey.replace("#10,20-110,220", "#300,20-400,220") };
    const m1 = buildQca3dVesselModel({ ...ARGS, runA, runB })!;
    const m2 = buildQca3dVesselModel({ ...ARGS, runA: other, runB })!;
    expect(m1.stableKey).not.toBe(m2.stableKey);
  });

  it("SOPInstanceUID が取れない方向があれば null（保存できないと正直に言う）", () => {
    const { runA, runB } = runsAt(8080);
    const m = buildQca3dVesselModel({ ...ARGS, runA: { ...runA, sopInstanceUid: null }, runB })!;
    expect(m.stableKey).toBeNull();
  });

  it("フレーム番号を provenance に残す", () => {
    const m = buildQca3dVesselModel({ ...ARGS, ...runsAt(8080) })!;
    expect(m.provenance.frameIndices).toEqual([3, 7]);
  });

  it("🔴 近位端を選んでいなければ向きは null（描いた順を近位→遠位と推測しない）", () => {
    const m = buildQca3dVesselModel(ARGS)!;
    expect(m.orientation).toEqual({ proximalFirst: null, source: null });
    expect(m.segments[0].points[0]).toEqual([0, 0, 0]);
  });

  it("始点が近位なら点順はそのまま、利用者が確かめたと記録する", () => {
    const m = buildQca3dVesselModel({ ...ARGS, proximalEnd: "start" })!;
    expect(m.orientation).toEqual({ proximalFirst: true, source: "user" });
    expect(m.segments[0].points.map((p) => p[0])).toEqual([0, 1, 2]);
    expect(m.segments[0].diameterMm).toEqual([3, null, 2]);
  });

  it("🔴 終点が近位なら点と径を**一緒に**逆順にする（狭窄の位置がずれない）", () => {
    const m = buildQca3dVesselModel({ ...ARGS, proximalEnd: "end" })!;
    expect(m.orientation).toEqual({ proximalFirst: true, source: "user" });
    expect(m.segments[0].points.map((p) => p[0])).toEqual([2, 1, 0]);
    expect(m.segments[0].diameterMm).toEqual([2, null, 3]);
  });

  it("向きを反転しても鍵は変わらない（同じ 2 区間の再構成）", () => {
    const a = buildQca3dVesselModel({ ...ARGS, ...runsAt(8080), proximalEnd: "start" })!;
    const b = buildQca3dVesselModel({ ...ARGS, ...runsAt(8080), proximalEnd: "end" })!;
    expect(a.stableKey).toBe(b.stableKey);
    expect(a.runId).toBe(b.runId);
  });

  it("元の再構成結果の点列を書き換えない（ダイアログの表示が反転しない）", () => {
    const result = makeResult();
    buildQca3dVesselModel({ ...ARGS, result, proximalEnd: "end" });
    expect(result.points[0]).toEqual([0, 0, 0]);
  });
});
