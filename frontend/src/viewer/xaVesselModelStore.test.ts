/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 血管モデル登録簿（`xaVesselModelStore`）のウィンドウ跨ぎ同期。
 *
 * <p>🚨 A7 は **3 つのウィンドウ**が絡む: 解析ダイアログ（2D ビューア）でモデルが生まれ、
 * プラグインのウィンドウが値を書き戻し、`#geometry3d` のウィンドウがそれを色で描く。
 * `xaRecon3dStore` で踏んだのと同じ罠（後から開いたウィンドウが過去の登録を知らない）を
 * 繰り返さないよう、`request` → `sync` の往復まで検査する。
 *
 * <p>ウィンドウ跨ぎは `vi.resetModules()` でモジュールを 2 つ読み込んで再現する。
 * ⚠️ 開いたぶんは必ず閉じる（閉じないと前のテストのウィンドウが問い合わせに答える）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Store = typeof import("./xaVesselModelStore");

const opened: Store[] = [];

async function openWindow(): Promise<Store> {
  vi.resetModules();
  const s = (await import("./xaVesselModelStore")) as Store;
  opened.push(s);
  s.ensureVesselModelChannel();
  return s;
}

afterEach(() => {
  for (const s of opened.splice(0)) s.closeVesselModelChannel();
});

/** BroadcastChannel の配送はマイクロタスクを跨ぐので、少し待つ。 */
const settle = () => new Promise((r) => setTimeout(r, 20));

function makeModel(store: Store, runId: string, at = 1): import("./xaVesselModelStore").XaVesselModel {
  void store;
  return {
    runId,
    kind: "xa-qca3d",
    label: runId,
    segments: [{ id: "main", points: [[0, 0, 0], [1, 0, 0]], diameterMm: [3, 3], parentId: null }],
    calibration: {
      diameterCalibrated: true,
      sources: ["user-catheter", "user-catheter"],
      tiers: ["calibrated", "calibrated"],
      diameterMethod: "densitometric",
    },
    provenance: {
      studyUid: "1.2.3",
      seriesUids: ["1.2.3.4"],
      sopUids: ["1.2.3.4.1"],
      angles: [[30, 0]],
      angleCorrected: true,
      visibleFractions: [0.9],
      anchorReprojectionPx: 0.7,
      separationDeg: 60,
    },
    at,
  };
}

function makeAnalysis(runId: string, at = 1): import("./xaVesselModelStore").XaVesselAnalysis {
  return {
    runId,
    kind: "ffr",
    label: "FFR",
    range: [0.5, 1],
    perPoint: [{ segmentId: "main", index: 0, value: 0.9 }],
    source: { pluginId: "acme.ffr", pluginName: "ACME FFR", version: "1.0.0" },
    at,
  };
}

describe("vesselRunId", () => {
  it("方向の順番に依らない（選び直しで別の再構成にならない）", async () => {
    const s = await openWindow();
    expect(s.vesselRunId("xa-qca3d", ["b", "a"])).toBe(s.vesselRunId("xa-qca3d", ["a", "b"]));
  });

  it("種類が違えば別の鍵（単一血管と分岐部が混ざらない）", async () => {
    const s = await openWindow();
    expect(s.vesselRunId("xa-qca3d", ["a"])).not.toBe(s.vesselRunId("xa-bifurcation3d", ["a"]));
  });
});

describe("登録の置き換え", () => {
  it("同じ runId は置き換わる", async () => {
    const s = await openWindow();
    s.registerVesselModel(makeModel(s, "r1", 1));
    s.registerVesselModel(makeModel(s, "r1", 2));
    expect(s.listVesselModels()).toHaveLength(1);
    expect(s.getVesselModel("r1")?.at).toBe(2);
  });

  it("🔴 モデルを差し替えると、その runId の解析値は捨てられる", async () => {
    const s = await openWindow();
    s.registerVesselModel(makeModel(s, "r1", 1));
    s.putVesselAnalysis(makeAnalysis("r1"));
    expect(s.getVesselAnalysis("r1")).not.toBeNull();
    s.registerVesselModel(makeModel(s, "r1", 2));
    // 点数も形も変わりうる。古い値を残すと**別の血管の色**が乗る。
    expect(s.getVesselAnalysis("r1")).toBeNull();
  });

  it("別 runId の解析値は巻き添えにしない", async () => {
    const s = await openWindow();
    s.registerVesselModel(makeModel(s, "r1"));
    s.registerVesselModel(makeModel(s, "r2"));
    s.putVesselAnalysis(makeAnalysis("r2"));
    s.registerVesselModel(makeModel(s, "r1", 5));
    expect(s.getVesselAnalysis("r2")).not.toBeNull();
  });
});

describe("ウィンドウ跨ぎ", () => {
  it("登録は他のウィンドウへ届く", async () => {
    const a = await openWindow();
    const b = await openWindow();
    a.registerVesselModel(makeModel(a, "r1"));
    await settle();
    expect(b.getVesselModel("r1")?.label).toBe("r1");
  });

  it("解析値も届く（プラグインのウィンドウ → 3D のウィンドウ）", async () => {
    const a = await openWindow();
    const b = await openWindow();
    a.registerVesselModel(makeModel(a, "r1"));
    await settle();
    a.putVesselAnalysis(makeAnalysis("r1"));
    await settle();
    expect(b.getVesselAnalysis("r1")?.label).toBe("FFR");
  });

  it("🚨 後から開いたウィンドウが過去の登録を拾える（3D は解析のあとに開く）", async () => {
    const a = await openWindow();
    a.registerVesselModel(makeModel(a, "r1"));
    a.putVesselAnalysis(makeAnalysis("r1"));
    const late = await openWindow();
    await settle();
    expect(late.getVesselModel("r1")).not.toBeNull();
    expect(late.getVesselAnalysis("r1")).not.toBeNull();
  });

  it("古い時刻の登録は新しいものを上書きしない", async () => {
    const a = await openWindow();
    const b = await openWindow();
    b.registerVesselModel(makeModel(b, "r1", 10));
    await settle();
    a.registerVesselModel(makeModel(a, "r1", 5));
    await settle();
    expect(b.getVesselModel("r1")?.at).toBe(10);
  });
});
