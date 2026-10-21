import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Roi3dBox } from "./roi3dBox";

// API だけ差し替える（保存ストア・同期・台帳・通知は本物。窓間は fake チャネルで再現）。
const fetchRoiDocument = vi.fn();
const saveRoiDocument = vi.fn();
vi.mock("./roiPersistenceApi", () => ({
  fetchRoiDocument: (...a: unknown[]) => fetchRoiDocument(...a),
  saveRoiDocument: (...a: unknown[]) => saveRoiDocument(...a),
  deleteRoiDocument: vi.fn(),
}));
vi.mock("../log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { setRoiChannelForTest } = await import("./roiChangeChannel");
const { addRoi3d, clearRoi3d, listRoi3d, subscribeRoi3dEdits, updateRoi3d } = await import("./roiLedger");
const { resetRoiSaveState, loadRoisCached } = await import("./roiSaveStore");
const { hydrateSolidsForSeries, resetSolidSync, startSolidAutosave } = await import("./roiSolidSync");

const PK = "P1";
const solid = (id: string, over: Partial<Roi3dBox> = {}): Roi3dBox => ({
  id,
  shape: "ellipsoid",
  center: [0, 0, 0],
  size: [2, 2, 2],
  seriesUid: "S1",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...over,
});
const doc = (solids: Roi3dBox[], deleted: string[] = [], version = 3) => ({
  patientKey: PK,
  json: JSON.stringify({ schema: 1, rois: [], deleted: deleted.map((roiUid) => ({ roiUid, at: "2026-01-02T00:00:00.000Z" })), solids }),
  roiCount: 0,
  updatedAt: "x",
  version,
});

/** 受け口だけの fake チャネル。相手窓からの到着は `arrive` で再現する。 */
function fakeChannel() {
  const posted: unknown[] = [];
  const ch = { posted, onmessage: null as ((e: { data: unknown }) => void) | null, postMessage: (m: unknown) => void posted.push(m) };
  const arrive = (patientKey: string, from = "other-window") => ch.onmessage?.({ data: { type: "roi-saved", from, patientKey } });
  return { ch, arrive };
}

let net: ReturnType<typeof fakeChannel>;
let stop: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  fetchRoiDocument.mockReset();
  saveRoiDocument.mockReset();
  saveRoiDocument.mockImplementation((_pk, json, count, version) =>
    Promise.resolve({ patientKey: PK, json, roiCount: count, updatedAt: "now", version: (version ?? 0) + 1 }),
  );
  resetRoiSaveState();
  resetSolidSync();
  clearRoi3d();
  net = fakeChannel();
  setRoiChannelForTest(net.ch);
  // 窓の起動: 保存済み（u1 のみ）を読み、S1 を台帳へ。
  fetchRoiDocument.mockResolvedValue(doc([solid("u1")]));
  await loadRoisCached(PK);
  await hydrateSolidsForSeries(PK, "S1");
  stop = startSolidAutosave(PK);
  fetchRoiDocument.mockClear();
});
afterEach(() => {
  stop();
  setRoiChannelForTest(null);
  vi.useRealTimers();
});

const settle = () => vi.advanceTimersByTimeAsync(300);
const ids = () => listRoi3d().map((x) => x.id).sort();

describe("窓間ライブ共有（solid）", () => {
  it("他窓が追加した solid が台帳に出て、取り込みで保存し直さない（エコー無し）", async () => {
    fetchRoiDocument.mockResolvedValue(doc([solid("u1"), solid("u2")], [], 9));
    net.arrive(PK);
    await settle();
    expect(ids()).toEqual(["u1", "u2"]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveRoiDocument).not.toHaveBeenCalled();
  });

  it("取り込みは「利用者の編集」として通知されない（変更検出に頼らず保存の起点にならない）", async () => {
    const edited = vi.fn();
    const off = subscribeRoi3dEdits(edited);
    fetchRoiDocument.mockResolvedValue(doc([solid("u1"), solid("u2")], [], 9));
    net.arrive(PK);
    await settle();
    expect(ids()).toEqual(["u1", "u2"]);
    expect(edited).not.toHaveBeenCalled();
    off();
  });

  it("他窓の削除（墓標）で消える", async () => {
    fetchRoiDocument.mockResolvedValue(doc([], ["u1"], 9));
    net.arrive(PK);
    await settle();
    expect(ids()).toEqual([]);
  });

  it("この窓の未保存の新しい編集は、古い保存分で上書きされない", async () => {
    updateRoi3d({ ...listRoi3d()[0], label: "mine" }); // 現在時刻で打刻される＝相手の 2026-01-01 より新しい
    fetchRoiDocument.mockResolvedValue(doc([solid("u1", { label: "theirs" })], [], 9));
    net.arrive(PK);
    await vi.advanceTimersByTimeAsync(300); // 受信デバウンス後・保存デバウンス前
    expect(listRoi3d()[0].label).toBe("mine");
  });

  it("相手の方が新しければ相手の編集を採る", async () => {
    fetchRoiDocument.mockResolvedValue(doc([solid("u1", { label: "theirs", updatedAt: "2999-01-01T00:00:00.000Z" })], [], 9));
    net.arrive(PK);
    await settle();
    expect(listRoi3d()[0].label).toBe("theirs");
  });

  it("負例: 別患者の通知・自窓発の通知・未読込の患者は取りに行かない", async () => {
    net.arrive("OTHER");
    net.arrive(PK, "test-self");
    await settle();
    expect(fetchRoiDocument).not.toHaveBeenCalled();
    stop();
    stop = startSolidAutosave("NOT-LOADED"); // この患者のシリーズは読み込んでいない
    net.arrive("NOT-LOADED");
    await settle();
    expect(fetchRoiDocument).not.toHaveBeenCalled();
  });

  it("取り込みは版を動かさない（次の保存は読んだ版で出し、競合は 409 で守られる）", async () => {
    fetchRoiDocument.mockResolvedValue(doc([solid("u1"), solid("u2")], [], 9));
    net.arrive(PK);
    await settle();
    addRoi3d(solid("u3"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(saveRoiDocument).toHaveBeenCalledTimes(1);
    expect(saveRoiDocument.mock.calls[0][3]).toBe(3); // 読んだ版（9 ではない）
    const sent = JSON.parse(saveRoiDocument.mock.calls[0][1] as string) as { solids: { id: string }[] };
    expect(sent.solids.map((x) => x.id).sort()).toEqual(["u1", "u2", "u3"]); // 取り込んだ u2 も落とさない
  });

  it("保存に成功すると他窓へ通知する（患者キーのみ）", async () => {
    addRoi3d(solid("u9"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.ch.posted).toEqual([{ type: "roi-saved", from: "test-self", patientKey: PK }]);
  });

  it("保存に失敗したら通知しない", async () => {
    saveRoiDocument.mockRejectedValue(new Error("HTTP 500"));
    addRoi3d(solid("u9"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(net.ch.posted).toEqual([]);
  });
});
