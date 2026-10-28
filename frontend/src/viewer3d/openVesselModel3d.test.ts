/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H12 の送信で 3D 画面を開く入口の検査。守りたいのは 3 つ:
 * 開くときは**モデルの点列と runId** を渡すこと（色が前後逆に乗らない）、
 * モデルが無い・分岐部・失敗した送信では**開かない**こと（黙って別のものを見せない）。
 */
import { describe, expect, it } from "vitest";
import type { XaVesselModel } from "../viewer/xaVesselModelStore";
import { openAfterAnalysisPut, openVesselModel3d, type OpenVesselModel3dDeps } from "./openVesselModel3d";

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

function harness(models: XaVesselModel[]) {
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

  it("負例: 分岐部のモデルでは開かない（先頭区間だけに色が乗って他の枝が値なしに見えるため）", () => {
    const { calls, deps } = harness([model({ kind: "xa-bifurcation3d" })]);
    expect(openVesselModel3d("run-1", deps)).toBe(false);
    expect(calls).toEqual({ ctx: [], opened: 0 });
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
