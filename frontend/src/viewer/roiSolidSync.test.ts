import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roi3dBox } from "./roi3dBox";

const store = vi.hoisted(() => ({
  saved: [] as Array<{ id: string; seriesUid?: string }>,
  calls: [] as Array<{ pk: string; seriesUid: string; ids: string[] }>,
}));

vi.mock("./roiSaveStore", () => ({
  loadRoisCached: async () => ({}),
  getSolidsForSeries: (_pk: string, seriesUid: string) => store.saved.filter((x) => x.seriesUid === seriesUid),
  setSolidsForSeries: async (pk: string, seriesUid: string, solids: Roi3dBox[]) => {
    store.calls.push({ pk, seriesUid, ids: solids.map((x) => x.id) });
    return { ok: true };
  },
}));

import { addRoi3d, clearRoi3d, listRoi3d, removeRoi3d } from "./roiLedger";
import { hydrateSolidsForSeries, resetSolidSync, startSolidAutosave } from "./roiSolidSync";

const mk = (id: string, seriesUid: string): Roi3dBox => ({ id, shape: "ellipsoid", center: [0, 0, 0], size: [2, 2, 2], seriesUid });

beforeEach(() => {
  vi.useFakeTimers();
  store.saved = [];
  store.calls = [];
  clearRoi3d();
  resetSolidSync();
});
afterEach(() => vi.useRealTimers());

describe("roiSolidSync", () => {
  it("保存済みの solid をシリーズ単位で台帳へ読む（他のシリーズは混ざらない）", async () => {
    store.saved = [mk("a", "S1"), mk("b", "S2")];
    await hydrateSolidsForSeries("P", "S1");
    expect(listRoi3d().map((x) => x.id)).toEqual(["a"]);
    await hydrateSolidsForSeries("P", "S2");
    expect(listRoi3d().map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(store.calls).toEqual([]); // 読んだだけでは保存しない
  });

  it("負例: 読み込み前のシリーズの編集は保存しない（保存済みを消したことにしない）", async () => {
    store.saved = [mk("a", "S1")];
    const stop = startSolidAutosave("P");
    addRoi3d(mk("x", "S2")); // S2 は未読込
    vi.advanceTimersByTime(900);
    await vi.runAllTimersAsync();
    expect(store.calls).toEqual([]);
    stop();
  });

  it("編集のあったシリーズだけを、全 solid（読み込み分＋新規）で保存する", async () => {
    store.saved = [mk("a", "S1"), mk("b", "S2")];
    await hydrateSolidsForSeries("P", "S1");
    await hydrateSolidsForSeries("P", "S2");
    const stop = startSolidAutosave("P");
    addRoi3d(mk("c", "S1"));
    vi.advanceTimersByTime(900);
    await vi.runAllTimersAsync();
    expect(store.calls).toEqual([{ pk: "P", seriesUid: "S1", ids: ["a", "c"] }]);
    stop();
  });

  it("削除は、そのシリーズの残りを渡す（差分は保存側が墓標にする）。変化の無い再保存はしない", async () => {
    store.saved = [mk("a", "S1")];
    await hydrateSolidsForSeries("P", "S1");
    const stop = startSolidAutosave("P");
    removeRoi3d("a");
    vi.advanceTimersByTime(900);
    await vi.runAllTimersAsync();
    expect(store.calls).toEqual([{ pk: "P", seriesUid: "S1", ids: [] }]);
    vi.advanceTimersByTime(900);
    await vi.runAllTimersAsync();
    expect(store.calls).toHaveLength(1);
    stop();
  });

  it("読み込み前に作られた solid は、保存済みと和を取って残り、読み込み後に保存される", async () => {
    store.saved = [mk("a", "S1")];
    addRoi3d(mk("n", "S1")); // 読み込み前に作った
    await hydrateSolidsForSeries("P", "S1");
    await vi.runAllTimersAsync();
    expect(listRoi3d("S1").map((x) => x.id).sort()).toEqual(["a", "n"]);
    expect(store.calls).toEqual([{ pk: "P", seriesUid: "S1", ids: ["a", "n"] }]);
  });

  it("負例: 別の患者のシリーズを、この患者のキーで保存しない", async () => {
    store.saved = [mk("q", "S9")];
    await hydrateSolidsForSeries("Q", "S9");
    const stop = startSolidAutosave("P");
    addRoi3d(mk("w", "S9")); // Q の患者のシリーズが変わった
    vi.advanceTimersByTime(900);
    await vi.runAllTimersAsync();
    expect(store.calls).toEqual([]);
    stop();
  });

  it("解除時に保留中の保存を流し切る", async () => {
    await hydrateSolidsForSeries("P", "S1");
    const stop = startSolidAutosave("P");
    addRoi3d(mk("z", "S1"));
    stop(); // デバウンス待ちのまま閉じる
    await vi.runAllTimersAsync();
    expect(store.calls).toEqual([{ pk: "P", seriesUid: "S1", ids: ["z"] }]);
  });
});
