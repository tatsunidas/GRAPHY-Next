/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * IPP の無い画像の ROI の復元は、画像（world の基準）が確定してから行う（`roiRestore.restoreRoisIntoStack`）。
 *
 * <p>🚨 守りたいのは 2 点: ①仮の画素間隔（1）を基準にして換算しない（開き直すたびに座標が「1 ÷ 間隔」倍になった）、
 * ②復元待ちの ROI を保存の収集が「削除された」と判定して消さない。
 */
import * as core from "@cornerstonejs/core";
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedRoi } from "./roiPersistence";

// 開いているスタックの SOP 判定（openStackSops）を差し替える。ほかは実物。
const engines: Array<{ getViewports: () => Array<{ getImageIds: () => string[] }> }> = [];
vi.mock("@cornerstonejs/core", async (importOriginal) => {
  const orig = await importOriginal<typeof import("@cornerstonejs/core")>();
  return { ...orig, getRenderingEngines: () => engines };
});

const putMock = vi.fn();
vi.mock("./roiPersistenceApi", () => ({
  fetchRoiDocument: vi.fn(),
  saveRoiDocument: (...a: unknown[]) => putMock(...a),
}));

import {
  cancelDeferredRestore,
  collectRoisForPatient,
  deferredRoisOf,
  registerLoaderSpacing,
  resetConfirmedBasis,
  resolveWorldBasis,
  restoreRoisIntoStack,
  worldSpacingOf,
} from "./roiRestore";
import { fetchRoiDocument } from "./roiPersistenceApi";
import { getLoadedRois, registerRoiCollector, resetRoiSaveState, saveRoiNow } from "./roiSaveStore";
import { buildSaveFile } from "./roiPersistence";

const PK = "patient-1";
const idOf = (sop: string, frame?: number) =>
  `wadouri:http://localhost:1/api/instances/${sop}/file${frame === undefined ? "" : `&frame=${frame}`}`;
const IMG_A = idOf("sop-a");
const IMG_B = idOf("sop-b");

const roi = (uid: string, sop: string, ws?: [number, number], frame?: number): SavedRoi => ({
  roiUid: uid,
  tool: "Length",
  sopInstanceUid: sop,
  ...(frame !== undefined ? { frame } : {}),
  ...(ws ? { worldSpacing: ws } : {}),
  points: [[10, 5, 0], [30, 5, 0]],
});

/** キャッシュ上の画像（rowPixelSpacing / columnPixelSpacing だけ持つ）。 */
const cached = new Map<string, { rowPixelSpacing: number; columnPixelSpacing: number }>();
/** annotation state の代用。 */
const store = new Map<string, Record<string, unknown>>();
const loads: string[] = [];
let loadImpl: (id: string) => Promise<unknown>;
const viewport = { element: {} as HTMLElement, getCamera: () => ({}), getViewReference: () => ({}) };

function openStack(ids: string[]) {
  engines.length = 0;
  engines.push({ getViewports: () => [{ getImageIds: () => ids }] });
}

beforeEach(() => {
  cached.clear();
  store.clear();
  loads.length = 0;
  engines.length = 0;
  putMock.mockReset();
  resetConfirmedBasis();
  resetRoiSaveState();
  // 本物の loaderSpacingFor と同じ性質: 画像があればその間隔、無ければ仮の 1。
  registerLoaderSpacing((id) => {
    const img = cached.get(id);
    return img ? { row: img.rowPixelSpacing, col: img.columnPixelSpacing } : { row: 1, col: 1 };
  });
  vi.spyOn(core.cache, "getImage").mockImplementation(((id: string) => cached.get(id)) as never);
  loadImpl = async (id) => {
    cached.set(id, { rowPixelSpacing: 0.1, columnPixelSpacing: 0.1 });
    return {};
  };
  vi.spyOn(core.imageLoader, "loadAndCacheImage").mockImplementation(((id: string) => {
    loads.push(id);
    return loadImpl(id);
  }) as never);
  const st = csAnnotation.state as unknown as Record<"getAnnotation" | "addAnnotation" | "getAllAnnotations", (...a: never[]) => unknown>;
  vi.spyOn(st, "getAnnotation").mockImplementation(((uid: string) => store.get(uid)) as never);
  vi.spyOn(st, "addAnnotation").mockImplementation(((a: { annotationUID: string }) => {
    store.set(a.annotationUID, a as unknown as Record<string, unknown>);
  }) as never);
  vi.spyOn(st, "getAllAnnotations").mockImplementation((() => [...store.values()]) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 保留中の Promise（画像の読み込み・then の連鎖）を流す。 */
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const owner = () => ({});
const restore = (saved: SavedRoi[], ids: string[], o: object, onRestored = vi.fn()) => ({
  n: restoreRoisIntoStack(saved, ids, viewport, PK, "S", { owner: o, onRestored }),
  onRestored,
});
const pointsOf = (uid: string) => ((store.get(uid)?.data as { handles: { points: number[][] } }).handles.points);

describe("基準が未確定の間は復元しない（仮の 1 で換算しない）", () => {
  it("画像が未読み込みなら annotation に足さず復元待ちにし、その画像だけ読み込みを要求する", async () => {
    const o = owner();
    const { n } = restore([roi("r1", "sop-a", [0.1, 0.1]), roi("r2", "sop-b")], [IMG_A, IMG_B], o);
    // 同期で足されたのは worldSpacing を持たない r2 だけ。r1 は待ち。
    expect(n).toBe(1);
    expect(store.has("r1")).toBe(false);
    expect(store.has("r2")).toBe(true);
    expect(deferredRoisOf(PK).map((r) => r.roiUid)).toEqual(["r1"]);
    await flush();
    expect(loads).toEqual([IMG_A]); // ROI のある画像だけ。sop-b は読まない
    cancelDeferredRestore(o);
  });

  it("読み込み後は座標が 1 ビットも変わらず足され、再描画の通知が 1 回出る", async () => {
    const o = owner();
    const { onRestored } = restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o);
    await flush();
    expect(pointsOf("r1")).toEqual([[10, 5, 0], [30, 5, 0]]);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(deferredRoisOf(PK)).toEqual([]);
  });

  it("基準が違う（校正を変えて開き直した）なら、画素位置を保つように換算する", async () => {
    loadImpl = async (id) => {
      cached.set(id, { rowPixelSpacing: 0.2, columnPixelSpacing: 0.2 });
      return {};
    };
    const o = owner();
    restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o);
    await flush();
    expect(pointsOf("r1")).toEqual([[20, 10, 0], [60, 10, 0]]);
    cancelDeferredRestore(o);
  });

  it("キャッシュに画像が既にあれば、待たずに即時復元する", () => {
    cached.set(IMG_A, { rowPixelSpacing: 0.1, columnPixelSpacing: 0.1 });
    const o = owner();
    const { n } = restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o);
    expect(n).toBe(1);
    expect(loads).toEqual([]);
    expect(pointsOf("r1")).toEqual([[10, 5, 0], [30, 5, 0]]);
  });

  it("同じ SOP の別フレームがキャッシュにあれば、その基準で確定する（読み込みは要らない）", () => {
    const f1 = idOf("sop-a", 1);
    const f2 = idOf("sop-a", 2);
    cached.set(f1, { rowPixelSpacing: 0.1, columnPixelSpacing: 0.1 });
    const o = owner();
    const { n } = restore([roi("r1", "sop-a", [0.1, 0.1], 1)], [f1, f2], o);
    expect(n).toBe(1);
    const n2 = restoreRoisIntoStack([roi("r2", "sop-a", [0.1, 0.1], 1)], [f2, f1], viewport, PK, "S", { owner: o, onRestored: vi.fn() });
    expect(n2).toBe(1);
    expect(loads).toEqual([]);
    expect(resolveWorldBasis(f2, [f1])).toEqual({ known: true, basis: [0.1, 0.1] });
  });

  it("worldSpacing を持たない ROI（IPP あり・古い保存）は今までどおり即時で、読み込みも要求しない", () => {
    const o = owner();
    const { n } = restore([roi("r1", "sop-a")], [IMG_A], o);
    expect(n).toBe(1);
    expect(loads).toEqual([]);
    expect(deferredRoisOf(PK)).toEqual([]);
  });

  it("復元待ちを渡さない呼び出し（deferral 省略）は従来どおり即時に足す", () => {
    const n = restoreRoisIntoStack([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], viewport, PK, "S");
    expect(n).toBe(1);
  });
});

describe("復元待ちの取り消しと重複", () => {
  it("タイルの破棄・スタックの切り替え（cancel）の後は、読み込みが終わっても足さず、持ち越しも外れる", async () => {
    const o = owner();
    restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o);
    cancelDeferredRestore(o);
    expect(deferredRoisOf(PK)).toEqual([]);
    await flush();
    expect(store.has("r1")).toBe(false);
  });

  it("既に annotation state にある UID は足さない（復元待ちの間に別経路で入った場合）", async () => {
    const o = owner();
    const { onRestored } = restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o);
    store.set("r1", { annotationUID: "r1", marker: "existing" });
    await flush();
    expect(store.get("r1")).toEqual({ annotationUID: "r1", marker: "existing" });
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("複数のタイルが同じシリーズを開くとき、同じ ROI は 1 度だけ足す。先のタイルが破棄されても後のタイルへ足す", async () => {
    const o1 = owner();
    const o2 = owner();
    const r1 = restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o1);
    const r2 = restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o2);
    cancelDeferredRestore(o1);
    await flush();
    expect(loads).toEqual([IMG_A]);
    expect(store.size).toBe(1);
    expect(r1.onRestored).not.toHaveBeenCalled();
    expect(r2.onRestored).toHaveBeenCalledTimes(1);
  });

  it("読み込みに失敗したら復元待ちのまま残る（消さない）", async () => {
    loadImpl = async () => {
      throw new Error("boom");
    };
    const o = owner();
    restore([roi("r1", "sop-a", [0.1, 0.1])], [IMG_A], o);
    await flush();
    expect(store.has("r1")).toBe(false);
    expect(deferredRoisOf(PK).map((r) => r.roiUid)).toEqual(["r1"]);
    cancelDeferredRestore(o);
  });
});

describe("collectRoisForPatient: 復元待ちの ROI を『削除された』と誤判定しない", () => {
  it("🔴 SOP が開いていて annotation が無くても、復元待ちの ROI は保存形のまま残る", () => {
    const saved = roi("r1", "sop-a", [0.1, 0.1]);
    openStack([IMG_A]);
    const o = owner();
    restore([saved], [IMG_A], o);
    // 負例の対照: 復元待ちでない（取り消した後の）同じ状況では、削除と判定されて消える。
    expect(collectRoisForPatient(PK, [saved])).toEqual([saved]);
    cancelDeferredRestore(o);
    expect(collectRoisForPatient(PK, [saved])).toEqual([]);
  });

  it("復元待ちの ROI の座標・worldSpacing は書き換えない", () => {
    const saved = roi("r1", "sop-a", [0.1, 0.1]);
    openStack([IMG_A]);
    const o = owner();
    restore([saved], [IMG_A], o);
    const out = collectRoisForPatient(PK, [saved]);
    expect(out[0].points).toEqual([[10, 5, 0], [30, 5, 0]]);
    expect(out[0].worldSpacing).toEqual([0.1, 0.1]);
    cancelDeferredRestore(o);
  });

  it("実際の保存（roiSaveStore）でも、復元待ちの間に保存が走って ROI が消えず、墓標も立たない", async () => {
    const saved = roi("r1", "sop-a", [0.1, 0.1]);
    const file = buildSaveFile([saved], [], "graphy-next", [], []);
    vi.mocked(fetchRoiDocument).mockResolvedValue({ version: 1, json: JSON.stringify(file) } as never);
    putMock.mockImplementation(async (_pk: string, json: string, _n: number, _v: unknown) => ({ version: 2, json }));
    openStack([IMG_A]);
    // 読み込みを止めておく＝復元待ちが続く間の保存を再現する。
    let release!: () => void;
    loadImpl = (id) =>
      new Promise((res) => {
        release = () => {
          cached.set(id, { rowPixelSpacing: 0.1, columnPixelSpacing: 0.1 });
          res({});
        };
      });
    const { loadRois } = await import("./roiSaveStore");
    await loadRois(PK);
    const unregister = registerRoiCollector(PK, () => collectRoisForPatient(PK, getLoadedRois(PK)));
    const o = owner();
    restore(getLoadedRois(PK), [IMG_A], o);
    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(true);
    const body = JSON.parse(putMock.mock.calls[0][1] as string) as { rois: SavedRoi[]; deleted?: unknown[] };
    expect(body.rois.map((r) => r.roiUid)).toEqual(["r1"]);
    expect(body.rois[0].points).toEqual([[10, 5, 0], [30, 5, 0]]);
    expect(body.rois[0].worldSpacing).toEqual([0.1, 0.1]);
    expect(body.deleted ?? []).toEqual([]);
    release();
    await flush();
    expect(pointsOf("r1")).toEqual([[10, 5, 0], [30, 5, 0]]);
    unregister();
    cancelDeferredRestore(o);
  });
});

describe("保存 → 復元 → 保存 → 復元の往復で座標が変わらない", () => {
  it("2 往復しても同じ値（IPP の無い画像・間隔 0.1）", async () => {
    let current: SavedRoi[] = [roi("r1", "sop-a", [0.1, 0.1])];
    for (let round = 0; round < 2; round++) {
      // 開き直し: キャッシュも annotation も空。
      cached.clear();
      store.clear();
      resetConfirmedBasis();
      openStack([IMG_A]);
      const o = owner();
      restore(current, [IMG_A], o);
      await flush();
      expect(pointsOf("r1")).toEqual([[10, 5, 0], [30, 5, 0]]);
      current = collectRoisForPatient(PK, current);
      expect(current).toHaveLength(1);
      expect(current[0].points).toEqual([[10, 5, 0], [30, 5, 0]]);
      expect(current[0].worldSpacing).toEqual([0.1, 0.1]);
      cancelDeferredRestore(o);
    }
  });
});

describe("worldSpacingOf（保存側）: 仮の値を基準として書かない", () => {
  it("画像もキャッシュの控えも無ければ null（仮の 1 を返さない）", () => {
    expect(worldSpacingOf(IMG_A)).toBeNull();
    expect(resolveWorldBasis(IMG_A)).toEqual({ known: false });
  });

  it("画像がキャッシュにあればその間隔。追い出された後は確定済みの控えを返し、仮の 1 を書かない", () => {
    cached.set(IMG_A, { rowPixelSpacing: 0.1, columnPixelSpacing: 0.3 });
    expect(worldSpacingOf(IMG_A)).toEqual([0.1, 0.3]);
    cached.clear();
    expect(worldSpacingOf(IMG_A)).toEqual([0.1, 0.3]);
  });

  it("IPP のある画像は null（換算不要）として確定する", () => {
    const provider = (type: string, id: string) =>
      type === "imagePlaneModule" && id === IMG_B ? { imagePositionPatient: [0, 0, 0] } : undefined;
    core.metaData.addProvider(provider as never, 9999);
    try {
      cached.set(IMG_B, { rowPixelSpacing: 0.7, columnPixelSpacing: 0.7 });
      expect(resolveWorldBasis(IMG_B)).toEqual({ known: true, basis: null });
      expect(worldSpacingOf(IMG_B)).toBeNull();
    } finally {
      core.metaData.removeProvider(provider as never);
    }
  });

  it("間隔の解決が未登録（テスト等）なら従来どおり null＝記録も換算もしない", () => {
    registerLoaderSpacing(null as never);
    expect(resolveWorldBasis(IMG_A)).toEqual({ known: true, basis: null });
    expect(worldSpacingOf(IMG_A)).toBeNull();
  });
});
