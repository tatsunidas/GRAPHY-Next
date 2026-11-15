/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H73 `registerVesselModel` の検査。外部（プラグイン）から来る値を入口で止めること。
 *
 * <p>🔴 守りたいのは 2 つ: 壊れた入力は**黙って落とさず理由つきで拒否**する（登録されない）。
 * 未校正のモデルに**径の値が入っていたら拒否**する（px が mm の顔で FFR の入力に入る事故）。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_VESSEL_MODEL_POINTS,
  getVesselModel,
  listVesselModels,
  registerPluginVesselModel,
  validateVesselModelInput,
  type CtVesselModelInput,
  type VesselModelInput,
  type XaVesselModelInput,
} from "./pluginVesselApi";
import { closeVesselModelChannel } from "../viewer/xaVesselModelStore";

const PRODUCER = { id: "angio-quant", name: "Angio Quant", version: "0.3.0" };

function makeInput(over: Partial<XaVesselModelInput> = {}): XaVesselModelInput {
  return {
    runKey: "case1",
    stableKey: "plugin:1.2.3.4.1@0|1.2.3.5.1@0",
    orientation: { proximalFirst: true, source: "user" },
    kind: "xa-qca3d",
    label: "3D QCA — A / B",
    segments: [
      {
        id: "main",
        points: [
          [0, 0, 0],
          [1, 0, 0],
          [2, 0, 0],
        ],
        diameterMm: [3, null, 3],
        parentId: null,
      },
    ],
    calibration: { diameterCalibrated: true, sources: ["geometry", "geometry"], tiers: ["approximate", "approximate"], diameterMethod: "half-max" },
    provenance: {
      studyUid: "1.2.3",
      seriesUids: ["1.2.3.4", "1.2.3.5"],
      sopUids: ["1.2.3.4.1", "1.2.3.5.1"],
      angles: [
        [45, 15],
        [-40, 30],
      ],
      angleCorrected: true,
      visibleFractions: [0.9, null],
      anchorReprojectionPx: 1.4,
      separationDeg: 72,
      frameIndices: [34, 34],
    },
    ...over,
  };
}

afterEach(() => closeVesselModelChannel());

describe("registerVesselModel（H73）", () => {
  it("正例: 登録すると、一覧と取得に出る。runId・出自は host が入れる", () => {
    const r = registerPluginVesselModel(makeInput(), PRODUCER);
    expect(r).toEqual({ ok: true, runId: "plugin:angio-quant:case1" });
    expect(listVesselModels().map((m) => m.runId)).toContain("plugin:angio-quant:case1");
    const m = getVesselModel("plugin:angio-quant:case1")!;
    expect(m.producer).toEqual({ pluginId: "angio-quant", pluginName: "Angio Quant", version: "0.3.0" });
    // 測れなかった点（null）は null のまま（0 で埋めない）
    expect(m.segments[0].diameterMm).toEqual([3, null, 3]);
  });

  it("プラグインが producer を名乗っても無視され、host の値が入る", () => {
    const input = { ...makeInput(), producer: { pluginId: "evil", pluginName: "x", version: "9" } } as unknown as XaVesselModelInput;
    registerPluginVesselModel(input, PRODUCER);
    expect(getVesselModel("plugin:angio-quant:case1")!.producer!.pluginId).toBe("angio-quant");
  });

  it("同じ runKey で登録し直すと置き換わる（1 件のまま）", () => {
    registerPluginVesselModel(makeInput(), PRODUCER);
    registerPluginVesselModel(makeInput({ label: "再解析" }), PRODUCER);
    const mine = listVesselModels().filter((m) => m.runId === "plugin:angio-quant:case1");
    expect(mine).toHaveLength(1);
    expect(mine[0].label).toBe("再解析");
  });

  it("登録後に入力を書き換えても、登録済みのモデルは変わらない（参照を持ち回らない）", () => {
    const input = makeInput();
    registerPluginVesselModel(input, PRODUCER);
    input.segments[0].points[0][0] = 999;
    input.segments[0].diameterMm[0] = 999;
    const m = getVesselModel("plugin:angio-quant:case1")!;
    expect(m.segments[0].points[0][0]).toBe(0);
    expect(m.segments[0].diameterMm[0]).toBe(3);
  });

  describe("負例: 壊れた入力は理由つきで拒否され、登録されない", () => {
    const bad: [string, XaVesselModelInput | null | undefined, RegExp][] = [
      ["null", null, /model is required/],
      ["runKey が空", makeInput({ runKey: "" }), /runKey/],
      ["未知の kind", makeInput({ kind: "ffr" as never }), /unknown kind/],
      ["label が空", makeInput({ label: "  " }), /label/],
      ["セグメントが無い", makeInput({ segments: [] }), /segments/],
      ["点が NaN", makeInput({ segments: [{ id: "main", points: [[0, 0, 0], [NaN, 0, 0]], diameterMm: [1, 1], parentId: null }] }), /finite/],
      ["点が 1 つ", makeInput({ segments: [{ id: "main", points: [[0, 0, 0]], diameterMm: [1], parentId: null }] }), /at least 2/],
      ["径の数が点と違う", makeInput({ segments: [{ id: "main", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [1], parentId: null }] }), /one entry per point/],
      ["径が 0（埋めた値）", makeInput({ segments: [{ id: "main", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [0, 1], parentId: null }] }), /null or a positive/],
      ["未校正なのに径が入っている", makeInput({ calibration: { diameterCalibrated: false, sources: [], tiers: ["uncalibrated"], diameterMethod: null } }), /all null/],
      ["区間 id の重複", makeInput({ segments: [
        { id: "a", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [1, 1], parentId: null },
        { id: "a", points: [[1, 0, 0], [2, 0, 0]], diameterMm: [1, 1], parentId: null },
      ] }), /duplicate/],
      ["parentId が存在しない", makeInput({ segments: [{ id: "a", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [1, 1], parentId: "zzz" }] }), /parentId/],
      ["再投影誤差が NaN", makeInput({ provenance: { ...makeInput().provenance, anchorReprojectionPx: NaN } }), /anchorReprojectionPx/],
      ["フレーム番号が負", makeInput({ provenance: { ...makeInput().provenance, frameIndices: [-1, 0] } }), /frameIndices/],
      ["未知の径の測り方", makeInput({ calibration: { ...makeInput().calibration, diameterMethod: "guess" as never } }), /diameterMethod/],
    ];
    for (const [name, input, re] of bad) {
      it(name, () => {
        const before = listVesselModels().length;
        expect(validateVesselModelInput(input)).toMatch(re);
        const r = registerPluginVesselModel(input as XaVesselModelInput, PRODUCER);
        expect(r.ok).toBe(false);
        expect(listVesselModels().length).toBe(before);
      });
    }

    it("総点数が上限を超える", () => {
      const n = MAX_VESSEL_MODEL_POINTS + 1;
      const input = makeInput({
        segments: [{ id: "main", points: Array.from({ length: n }, (_, i) => [i, 0, 0] as [number, number, number]), diameterMm: Array(n).fill(null), parentId: null }],
      });
      expect(validateVesselModelInput(input)).toMatch(/too many points/);
    });
  });

  it("未校正で全点 null なら通る（px の値を持たない）", () => {
    const input = makeInput({
      segments: [{ id: "main", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [null, null], parentId: null }],
      calibration: { diameterCalibrated: false, sources: [], tiers: ["uncalibrated"], diameterMethod: null },
    });
    expect(registerPluginVesselModel(input, PRODUCER).ok).toBe(true);
  });
});

// ---- CT 由来（ct-vessel）----
function ctInput(over: Partial<CtVesselModelInput> = {}): CtVesselModelInput {
  const seg = (id: string, parentId: string | null, z0: number) => ({
    id,
    name: id === "trunk" ? "RCA prox" : undefined,
    points: [[0, 0, z0], [0, 0, z0 + 10], [1, 0, z0 + 20]] as [number, number, number][],
    diameterMm: [4, 3.5, null] as (number | null)[],
    parentId,
  });
  return {
    runKey: "ct1",
    stableKey: null,
    orientation: { proximalFirst: true, source: "user" },
    kind: "ct-vessel",
    label: "CT 冠動脈",
    segments: [seg("trunk", null, 0), seg("b1", "trunk", 20), seg("b2", "trunk", 20)],
    calibration: { diameterCalibrated: true, sources: ["geometry"], tiers: ["calibrated"], diameterMethod: "mask-equivalent-area" },
    provenance: {
      studyUid: "1.2.3",
      seriesUid: "1.2.3.4",
      frameOfReferenceUid: "1.2.3.9",
      voxelSpacingMm: [0.4, 0.4, 0.5],
      maskOrigin: { type: "plugin" },
    },
    ...over,
  } as CtVesselModelInput;
}

describe("registerVesselModel（H73）— ct-vessel", () => {
  it("正例: 3 区間の木が登録され、点列・名前・出自が差分 0 で返る", () => {
    const r = registerPluginVesselModel(ctInput(), PRODUCER);
    expect(r).toEqual({ ok: true, runId: "plugin:angio-quant:ct1" });
    const m = getVesselModel("plugin:angio-quant:ct1")!;
    expect(m.kind).toBe("ct-vessel");
    expect(m.segments.map((x) => x.id)).toEqual(["trunk", "b1", "b2"]);
    expect(m.segments[0].name).toBe("RCA prox");
    expect(m.segments[1].name).toBeUndefined();
    expect(m.segments[1].parentId).toBe("trunk");
    expect(m.segments[0].diameterMm).toEqual([4, 3.5, null]);
    expect(m.provenance).toEqual(ctInput().provenance);
    expect(m.calibration.diameterMethod).toBe("mask-equivalent-area");
  });

  it("登録後に入力を書き換えても変わらない", () => {
    const input = ctInput();
    registerPluginVesselModel(input, PRODUCER);
    input.segments[1].points[0][2] = 999;
    (input.provenance as { voxelSpacingMm: number[] }).voxelSpacingMm[0] = 9;
    const m = getVesselModel("plugin:angio-quant:ct1")!;
    expect(m.segments[1].points[0][2]).toBe(20);
    expect((m.provenance as { voxelSpacingMm: number[] }).voxelSpacingMm[0]).toBe(0.4);
  });

  const pv = () => ctInput().provenance as unknown as Record<string, unknown>;
  const withPv = (o: Record<string, unknown>) => ctInput({ provenance: { ...pv(), ...o } as never });
  const bad: [string, VesselModelInput, RegExp][] = [
    ["seriesUid が無い", withPv({ seriesUid: undefined }), /seriesUid/],
    ["seriesUid が空", withPv({ seriesUid: "" }), /seriesUid/],
    ["studyUid が無い", withPv({ studyUid: undefined }), /studyUid/],
    ["frameOfReferenceUid が数値", withPv({ frameOfReferenceUid: 5 }), /frameOfReferenceUid/],
    ["voxelSpacingMm が 0 を含む", withPv({ voxelSpacingMm: [0.4, 0, 0.5] }), /voxelSpacingMm/],
    ["voxelSpacingMm が NaN", withPv({ voxelSpacingMm: [0.4, NaN, 0.5] }), /voxelSpacingMm/],
    ["voxelSpacingMm が 2 要素", withPv({ voxelSpacingMm: [0.4, 0.5] }), /voxelSpacingMm/],
    ["maskOrigin が無い", withPv({ maskOrigin: undefined }), /maskOrigin/],
    ["maskOrigin.type が未知", withPv({ maskOrigin: { type: "x" } }), /maskOrigin/],
    ["seg なのに sopInstanceUid が無い", withPv({ maskOrigin: { type: "seg" } }), /sopInstanceUid/],
    ["XA の provenance を CT の kind に", ctInput({ provenance: makeInput().provenance as never }), /seriesUid/],
    ["CT の provenance を XA の kind に", { ...makeInput(), provenance: ctInput().provenance } as unknown as VesselModelInput, /seriesUids/],
    ["未校正なのに径が数値", ctInput({ calibration: { diameterCalibrated: false, sources: [], tiers: ["uncalibrated"], diameterMethod: null } }), /all null/],
    ["parentId が自分自身", ctInput({ segments: [{ id: "a", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [1, 1], parentId: "a" }] }), /parentId/],
    ["parentId が未知", ctInput({ segments: [{ id: "a", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [1, 1], parentId: "zzz" }] }), /parentId/],
    ["name が長すぎる", ctInput({ segments: [{ id: "a", name: "x".repeat(101), points: [[0, 0, 0], [1, 0, 0]], diameterMm: [1, 1], parentId: null }] }), /name/],
    ["未知の径の測り方", ctInput({ calibration: { diameterCalibrated: true, sources: [], tiers: [], diameterMethod: "guess" as never } }), /diameterMethod/],
  ];
  for (const [name, input, re] of bad) {
    it(`負例: ${name}`, () => {
      const before = listVesselModels().length;
      expect(validateVesselModelInput(input)).toMatch(re);
      expect(registerPluginVesselModel(input, PRODUCER).ok).toBe(false);
      expect(listVesselModels().length).toBe(before);
    });
  }

  it("径の測り方 mask-min-width も通る", () => {
    const input = ctInput({ calibration: { diameterCalibrated: true, sources: [], tiers: [], diameterMethod: "mask-min-width" } });
    expect(validateVesselModelInput(input)).toBeNull();
  });
});
