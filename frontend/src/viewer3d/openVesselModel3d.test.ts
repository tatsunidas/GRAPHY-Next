/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H12 の送信で 3D 画面を開く入口の検査。守りたいのは 3 つ:
 * 開くときは**モデルの点列と runId** を渡すこと（色が前後逆に乗らない）、
 * モデルが無い・点が足りない・失敗した送信では**開かない**こと（木は区間ごとに開く）（黙って別のものを見せない）。
 */
import { describe, expect, it } from "vitest";
import type { VesselModel, XaVesselModel } from "../viewer/xaVesselModelStore";
import { openAfterAnalysisPut, openVesselModel3d, openVesselModel3dFromPlugin, type OpenVesselModel3dDeps } from "./openVesselModel3d";

function model(over: Partial<XaVesselModel> = {}): XaVesselModel {
  return {
    runId: "run-1",
    stableKey: null,
    orientation: { proximalFirst: true, source: "user" },
    kind: "xa-qca3d",
    label: "3D QCA — A / B",
    segments: [{ id: "main", points: [[0, 0, 0], [1, 2, 3], [2, 4, 6]], diameterMm: [3, 2, 3], parentId: null }],
    calibration: { diameterCalibrated: true, sources: ["geometry", "geometry"], tiers: ["approximate", "approximate"], diameterMethod: "densitometric" },
    provenance: {
      studyUid: "1.2.3", seriesUids: ["1.2.3.4", "1.2.3.5"], sopUids: ["1.2.3.4.1", "1.2.3.5.1"],
      angles: [[45, 15], [-40, 30]], angleCorrected: true, visibleFractions: [0.9, 0.9], anchorReprojectionPx: 1, separationDeg: 72, frameIndices: [1, 1],
    },
    at: 0,
    ...over,
  } as XaVesselModel;
}

function harness(models: VesselModel[]) {
  const calls = { ctx: [] as unknown[], opened: 0 };
  const deps: OpenVesselModel3dDeps = {
    getModel: (id) => models.find((m) => m.runId === id) ?? null,
    writeContext: (c) => void calls.ctx.push(c),
    openWindow: () => void (calls.opened += 1),
  };
  return { calls, deps };
}

describe("openVesselModel3d", () => {
  it("正例: モデルの runId と点列をコンテキストに書き、3D 画面を 1 回開く", () => {
    const { calls, deps } = harness([model()]);
    expect(openVesselModel3d("run-1", deps)).toBe(true);
    expect(calls.opened).toBe(1);
    expect(calls.ctx).toEqual([
      { kind: "xa-qca3d", name: "3D QCA — A / B", runId: "run-1", centerlineLps: [[0, 0, 0], [1, 2, 3], [2, 4, 6]] },
    ]);
  });

  it("負例: 登録簿に無い runId では、書かず・開かず false", () => {
    const { calls, deps } = harness([model()]);
    expect(openVesselModel3d("no-such-run", deps)).toBe(false);
    expect(calls).toEqual({ ctx: [], opened: 0 });
  });

  const TREE = [
    { id: "trunk", name: "RCA prox", points: [[0, 0, 0], [0, 0, 10], [0, 0, 20]] as [number, number, number][], diameterMm: [4, 4, 4], parentId: null },
    { id: "b1", points: [[0, 0, 20], [5, 0, 30]] as [number, number, number][], diameterMm: [3, 3], parentId: "trunk" },
    { id: "b2", name: "PDA", points: [[0, 0, 20], [-5, 0, 30]] as [number, number, number][], diameterMm: [3, 3], parentId: "trunk" },
  ];

  it("分岐部の XA は区間ごとの点列を segments に書いて開く（先頭区間のコピーを centerlineLps に残す）", () => {
    const { calls, deps } = harness([model({ kind: "xa-bifurcation3d", segments: TREE })]);
    expect(openVesselModel3d("run-1", deps)).toBe(true);
    expect(calls.opened).toBe(1);
    const ctx = calls.ctx[0] as { kind: string; centerlineLps: number[][]; segments: { id: string; name?: string; points: number[][] }[] };
    expect(ctx.kind).toBe("xa-bifurcation3d");
    expect(ctx.segments.map((x) => x.id)).toEqual(["trunk", "b1", "b2"]);
    expect(ctx.segments.map((x) => x.name)).toEqual(["RCA prox", undefined, "PDA"]);
    expect(ctx.segments[2].points).toEqual([[0, 0, 20], [-5, 0, 30]]);
    expect(ctx.centerlineLps).toEqual([[0, 0, 0], [0, 0, 10], [0, 0, 20]]);
  });

  it("CT 由来のモデル（ct-vessel）も木として開く", () => {
    const m = { ...model({ segments: TREE }), kind: "ct-vessel" } as unknown as VesselModel;
    const { calls, deps } = harness([m]);
    expect(openVesselModel3d("run-1", deps)).toBe(true);
    expect((calls.ctx[0] as { kind: string }).kind).toBe("ct-vessel");
    expect((calls.ctx[0] as { segments: unknown[] }).segments).toHaveLength(3);
  });

  it("木の渡す点列も元の配列のコピー（開いた後にモデルが変わっても動かない）", () => {
    const m = model({ kind: "xa-bifurcation3d", segments: TREE.map((x) => ({ ...x, points: x.points.map((q) => [...q] as [number, number, number]) })) });
    const { calls, deps } = harness([m]);
    openVesselModel3d("run-1", deps);
    m.segments[1].points[0][0] = 99;
    expect((calls.ctx[0] as { segments: { points: number[][] }[] }).segments[1].points[0][0]).toBe(0);
  });

  it("負例: どれか 1 区間でも 2 点未満なら開かない（他の区間が十分でも）", () => {
    const bad = TREE.map((x, i) => (i === 2 ? { ...x, points: [[0, 0, 0]] as [number, number, number][], diameterMm: [3] } : x));
    const { calls, deps } = harness([model({ kind: "xa-bifurcation3d", segments: bad })]);
    expect(openVesselModel3d("run-1", deps)).toBe(false);
    expect(calls).toEqual({ ctx: [], opened: 0 });
    const r = openVesselModel3dFromPlugin("run-1", deps);
    expect(r.ok === false && r.error).toMatch(/segment b2 has fewer than 2/);
  });

  it("負例: 中心線が 2 点未満なら開かない", () => {
    const { calls, deps } = harness([model({ segments: [{ id: "main", points: [[0, 0, 0]], diameterMm: [3], parentId: null }] })]);
    expect(openVesselModel3d("run-1", deps)).toBe(false);
    expect(calls.opened).toBe(0);
  });

  it("渡す点列は元の配列のコピー（開いた後にモデルが変わっても 3D 側の引数は動かない）", () => {
    const m = model();
    const { calls, deps } = harness([m]);
    openVesselModel3d("run-1", deps);
    m.segments[0].points[0][0] = 99;
    expect((calls.ctx[0] as { centerlineLps: number[][] }).centerlineLps[0][0]).toBe(0);
  });
});

describe("openAfterAnalysisPut", () => {
  it("正例: 送信が成功したら開き、戻り値はそのまま返す", () => {
    const { calls, deps } = harness([model()]);
    const r = { ok: true as const };
    expect(openAfterAnalysisPut(r, "run-1", deps)).toBe(r);
    expect(calls.opened).toBe(1);
  });

  it("負例: 送信が失敗（ok: false）なら開かず、戻り値（理由）はそのまま返す", () => {
    const { calls, deps } = harness([model()]);
    const r = { ok: false as const, error: "壊れた入力" };
    expect(openAfterAnalysisPut(r, "run-1", deps)).toBe(r);
    expect(calls).toEqual({ ctx: [], opened: 0 });
  });
});

describe("openVesselModel3dFromPlugin（H74）", () => {
  it("正例: 登録したモデルを開き、ok: true。色は乗せない（コンテキストは中心線と runId だけ）", () => {
    const { calls, deps } = harness([model()]);
    expect(openVesselModel3dFromPlugin("run-1", deps)).toEqual({ ok: true });
    expect(calls.opened).toBe(1);
    expect(calls.ctx).toHaveLength(1);
  });

  it("負例: 登録簿に無い runId は、開かず・理由つき", () => {
    const { calls, deps } = harness([model()]);
    const r = openVesselModel3dFromPlugin("no-such-run", deps);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(/no vessel model/);
    expect(calls).toEqual({ ctx: [], opened: 0 });
  });

  it("負例: 中心線が 2 点未満は、開かず・理由つき", () => {
    const { calls, deps } = harness([model({ segments: [{ id: "main", points: [[0, 0, 0]], diameterMm: [3], parentId: null }] })]);
    const r = openVesselModel3dFromPlugin("run-1", deps);
    expect(r.ok === false && r.error).toMatch(/fewer than 2/);
    expect(calls.opened).toBe(0);
  });
});
