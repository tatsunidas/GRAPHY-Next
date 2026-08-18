/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA の登録簿（`xaRecon3dStore`）の同期。
 *
 * <p>🔴 ここを守りたい理由は 1 つ: **分岐部（A6b）は同じフレームから 3 区間を解析する**。
 * 鍵が imageId のままだと「6 本登録したはずが 2 本／4 本しか残らない」という形で壊れ、
 * しかも**壊れたことが数値に出ない**（3D の結果は出てしまい、別の区間の中心線を合成する）。
 * 登録・受信・削除の 3 箇所すべてが `runKey` で揃っていることを検査する。
 *
 * <p>ウィンドウ跨ぎは、`vi.resetModules()` で**モジュールを 2 つ読み込んで**再現する
 * （同一プロセス内の別インスタンス＝別ウィンドウ。BroadcastChannel は Node にもある）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

type Store = typeof import("./xaRecon3dStore");

const GEOMETRY = {
  primaryAngleDeg: 30,
  secondaryAngleDeg: 0,
  sourceToDetectorMm: 1000,
  sourceToPatientMm: 750,
  pixelSpacingMm: [0.2, 0.2] as [number, number],
  imageSize: [512, 512] as [number, number],
};

function makeRun(store: Store, imageId: string, start: [number, number], end: [number, number], at = 1) {
  return {
    imageId,
    runKey: store.qcaRunKey(imageId, start, end),
    studyUid: "1.2.3",
    seriesUid: "1.2.3.4",
    sopInstanceUid: "1.2.3.4.5",
    frameIndex: 0,
    label: `${imageId} ${start}-${end}`,
    geometry: GEOMETRY as never,
    centerline: [start, end] as [number, number][],
    diameters: [3, 3],
    diameterPathIndices: [0, 1],
    unit: "mm" as const,
    diameterMethod: "densitometric" as const,
    edited: false,
    at,
  };
}

/**
 * 別ウィンドウ相当のインスタンスを 1 つ読み込む。
 *
 * <p>⚠️ 開いたぶんは必ず `afterEach` で閉じる。閉じないと**前のテストのウィンドウが
 * 問い合わせに答えて**、後のテストに前の登録が混ざる（このファイルを書いていて実際に踏んだ）。
 */
const opened: Store[] = [];

async function openWindow(): Promise<Store> {
  vi.resetModules();
  const s = (await import("./xaRecon3dStore")) as Store;
  opened.push(s);
  return s;
}

async function twoWindows(): Promise<[Store, Store]> {
  return [await openWindow(), await openWindow()];
}

/** BroadcastChannel の配送はマイクロタスクではないので実時間で待つ。 */
function settle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 20));
}

describe("xaRecon3dStore", () => {
  afterEach(async () => {
    for (const s of opened.splice(0)) s.closeQcaRunChannel();
    await settle();
  });

  it("同じ imageId でも解析区間が違えば別の登録として残る", async () => {
    const store = await openWindow();
    store.registerQcaRun(makeRun(store, "img#1", [10, 10], [60, 60]));
    store.registerQcaRun(makeRun(store, "img#1", [60, 60], [120, 30]));
    store.registerQcaRun(makeRun(store, "img#1", [60, 60], [120, 90]));
    expect(store.listQcaRuns()).toHaveLength(3);
  });

  it("同じ区間を解析し直したときだけ置き換わる", async () => {
    const store = await openWindow();
    store.registerQcaRun(makeRun(store, "img#1", [10, 10], [60, 60], 1));
    store.registerQcaRun(makeRun(store, "img#1", [10, 10], [60, 60], 2));
    const runs = store.listQcaRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].at).toBe(2);
  });

  it("端点は丸めて鍵にする（同じ計測を選び直しただけで増えない）", async () => {
    const store = await openWindow();
    expect(store.qcaRunKey("img#1", [10.4, 10.2], [60.1, 59.8])).toBe(
      store.qcaRunKey("img#1", [10, 10], [60, 60]),
    );
  });

  it("🔴 ウィンドウを跨いでも同じフレームの 3 区間が潰れない", async () => {
    const [a, b] = await twoWindows();
    b.ensureQcaRunChannel(); // 受け側（メインウィンドウ相当の中継役）
    a.registerQcaRun(makeRun(a, "img#1", [10, 10], [60, 60]));
    a.registerQcaRun(makeRun(a, "img#1", [60, 60], [120, 30]));
    a.registerQcaRun(makeRun(a, "img#1", [60, 60], [120, 90]));
    await settle();
    // 受け側の突き合わせが imageId だと、ここが 1 になる（実機で 6→4 になった原因）。
    expect(b.listQcaRuns()).toHaveLength(3);
  });

  it("後から開いたウィンドウは問い合わせで過去の登録を拾える", async () => {
    const [a, b] = await twoWindows();
    a.registerQcaRun(makeRun(a, "img#1", [10, 10], [60, 60]));
    a.registerQcaRun(makeRun(a, "img#1", [60, 60], [120, 30]));
    await settle();
    b.ensureQcaRunChannel(); // 後から参加 → request を投げる
    await settle();
    expect(b.listQcaRuns()).toHaveLength(2);
  });

  it("削除は他ウィンドウにも伝わる（引き直すとき登録簿に残さない）", async () => {
    const [a, b] = await twoWindows();
    b.ensureQcaRunChannel();
    const run = makeRun(a, "img#1", [10, 10], [60, 60]);
    a.registerQcaRun(run);
    await settle();
    expect(b.listQcaRuns()).toHaveLength(1);
    a.removeQcaRun(run.runKey);
    await settle();
    expect(a.listQcaRuns()).toHaveLength(0);
    expect(b.listQcaRuns()).toHaveLength(0);
  });
});
