import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Measure3d } from "./roiMeasure3d";

const fetchRoiDocument = vi.fn();
const saveRoiDocument = vi.fn();
vi.mock("./roiPersistenceApi", () => ({
  fetchRoiDocument: (...a: unknown[]) => fetchRoiDocument(...a),
  saveRoiDocument: (...a: unknown[]) => saveRoiDocument(...a),
  deleteRoiDocument: vi.fn(),
}));
vi.mock("../log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { setRoiChannelForTest } = await import("./roiChangeChannel");
const { addMeasure3d, clearMeasure3d, dropMeasure3dSeries, listMeasure3d, removeMeasure3d, subscribeMeasure3dEdits, updateMeasure3d } = await import("./roiLedger");
const { resetRoiSaveState, loadRoisCached } = await import("./roiSaveStore");
const { forgetMeasureSync, hydrateMeasuresForSeries, resetMeasureSync, startMeasureAutosave } = await import("./roiMeasureSync");

const PK = "P1";
const ms = (id: string, over: Partial<Measure3d> = {}): Measure3d => ({
  id, a: [0, 0, 0], b: [3, 4, 0], seriesUid: "S1", updatedAt: "2026-01-01T00:00:00.000Z", ...over,
});
const doc = (measures3d: Measure3d[] | undefined, deleted: string[] = [], version = 3) => ({
  patientKey: PK,
  json: JSON.stringify({ schema: 1, rois: [], deleted: deleted.map((roiUid) => ({ roiUid, at: "2026-01-02T00:00:00.000Z" })), ...(measures3d ? { measures3d } : {}) }),
  roiCount: 0, updatedAt: "x", version,
});
function fakeChannel() {
  const posted: unknown[] = [];
  const ch = { posted, onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => void posted.push(m) };
  return { ch, arrive: (patientKey: string, from = "other-window") => ch.onmessage?.({ data: { type: "roi-saved", from, patientKey } }) };
}

let net: ReturnType<typeof fakeChannel>;
let stop: () => void;
const boot = async (d: ReturnType<typeof doc>) => {
  fetchRoiDocument.mockResolvedValue(d);
  await loadRoisCached(PK);
  await hydrateMeasuresForSeries(PK, "S1");
  stop = startMeasureAutosave(PK);
  fetchRoiDocument.mockClear();
};

beforeEach(() => {
  vi.useFakeTimers();
  fetchRoiDocument.mockReset();
  saveRoiDocument.mockReset();
  saveRoiDocument.mockImplementation((_pk, json, count, version) => Promise.resolve({ patientKey: PK, json, roiCount: count, updatedAt: "now", version: (version ?? 0) + 1 }));
  resetRoiSaveState();
  resetMeasureSync();
  clearMeasure3d();
  net = fakeChannel();
  setRoiChannelForTest(net.ch);
});
afterEach(() => {
  stop?.();
  setRoiChannelForTest(null);
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const ids = () => listMeasure3d().map((x) => x.id).sort();
const sentDoc = () => JSON.parse(saveRoiDocument.mock.calls.at(-1)![1] as string) as { measures3d: { id: string }[]; deleted: { roiUid: string }[] };

describe("3D 定規の保存・窓間共有", () => {
  it("保存済みの定規が読み込みで台帳に出る（編集通知なし・保存し直さない）", async () => {
    const edited = vi.fn();
    const off = subscribeMeasure3dEdits(edited);
    await boot(doc([ms("m1")]));
    expect(ids()).toEqual(["m1"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(edited).not.toHaveBeenCalled();
    expect(saveRoiDocument).not.toHaveBeenCalled();
    off();
  });

  it("旧ドキュメント（measures3d 無し）は空で読める", async () => {
    await boot(doc(undefined));
    expect(ids()).toEqual([]);
  });

  it("追加すると保存され、他窓へ通知される。距離は保存せず端点だけ", async () => {
    await boot(doc([]));
    addMeasure3d({ id: "m2", a: [0, 0, 0], b: [0, 0, 7], seriesUid: "S1" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveRoiDocument).toHaveBeenCalledTimes(1);
    const saved = (JSON.parse(saveRoiDocument.mock.calls[0][1] as string) as { measures3d: Record<string, unknown>[] }).measures3d;
    expect(saved.map((x) => x.id)).toEqual(["m2"]);
    expect(saved[0]).not.toHaveProperty("distMm");
    expect(net.ch.posted).toHaveLength(1);
  });

  it("他窓が追加した定規が出る／他窓の削除（墓標）で消える／取り込みで保存し直さない", async () => {
    await boot(doc([ms("m1")]));
    fetchRoiDocument.mockResolvedValue(doc([ms("m1"), ms("m2")], [], 9));
    net.arrive(PK);
    await settle();
    expect(ids()).toEqual(["m1", "m2"]);
    fetchRoiDocument.mockResolvedValue(doc([ms("m2")], ["m1"], 10));
    net.arrive(PK);
    await settle();
    expect(ids()).toEqual(["m2"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveRoiDocument).not.toHaveBeenCalled();
  });

  it("利用者の削除は墓標になる", async () => {
    await boot(doc([ms("m1"), ms("m2")]));
    removeMeasure3d("m1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentDoc().measures3d.map((x) => x.id)).toEqual(["m2"]);
    expect(sentDoc().deleted.map((t) => t.roiUid)).toEqual(["m1"]);
  });

  it("シーンの再読込（手放す）は削除ではない: 墓標を出さず、保存も起こさない", async () => {
    await boot(doc([ms("m1")]));
    dropMeasure3dSeries("S1");
    forgetMeasureSync(PK, "S1");
    expect(ids()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(saveRoiDocument).not.toHaveBeenCalled();
    // 開き直せば保存済みが戻る
    await hydrateMeasuresForSeries(PK, "S1");
    expect(ids()).toEqual(["m1"]);
  });

  it("この窓の未保存の新しい編集は古い保存分で上書きされない／相手が新しければ採る", async () => {
    await boot(doc([ms("m1")]));
    updateMeasure3d({ ...listMeasure3d()[0], label: "mine" });
    fetchRoiDocument.mockResolvedValue(doc([ms("m1", { label: "theirs" })], [], 9));
    net.arrive(PK);
    await settle();
    expect(listMeasure3d()[0].label).toBe("mine");
    await vi.advanceTimersByTimeAsync(1500);
    fetchRoiDocument.mockResolvedValue(doc([ms("m1", { label: "newer", updatedAt: "2999-01-01T00:00:00.000Z" })], [], 11));
    net.arrive(PK);
    await settle();
    expect(listMeasure3d()[0].label).toBe("newer");
  });

  it("負例: 別患者・自窓発の通知は取りに行かず、別シリーズの定規は混ざらない", async () => {
    await boot(doc([ms("m1")]));
    net.arrive("OTHER");
    net.arrive(PK, "test-self");
    await settle();
    expect(fetchRoiDocument).not.toHaveBeenCalled();
    fetchRoiDocument.mockResolvedValue(doc([ms("m1"), ms("x", { seriesUid: "S2" })], [], 9));
    net.arrive(PK);
    await settle();
    expect(ids()).toEqual(["m1"]);
  });

  it("削除を保存した後の Undo（同じ id で戻す）は墓標から外れて保存される", async () => {
    await boot(doc([ms("m1")]));
    removeMeasure3d("m1");
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentDoc().deleted.map((t) => t.roiUid)).toEqual(["m1"]);
    addMeasure3d(ms("m1", { updatedAt: undefined }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(sentDoc().measures3d.map((x) => x.id)).toEqual(["m1"]);
    expect(sentDoc().deleted.map((t) => t.roiUid)).not.toContain("m1");
  });

  it("読み込みは自分のシリーズの定規だけ（同じ患者の別シリーズは台帳に入らない）", async () => {
    await boot(doc([ms("m1"), ms("x", { seriesUid: "S2" })]));
    expect(ids()).toEqual(["m1"]);
  });
});
