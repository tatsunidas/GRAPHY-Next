/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedRoi } from "./roiPersistence";

// API は差し替える（このテストの対象は保存の段取り＝版の扱い・墓標・競合再試行）。
const fetchRoiDocument = vi.fn();
const saveRoiDocument = vi.fn();
vi.mock("./roiPersistenceApi", () => ({
  fetchRoiDocument: (...a: unknown[]) => fetchRoiDocument(...a),
  saveRoiDocument: (...a: unknown[]) => saveRoiDocument(...a),
  deleteRoiDocument: vi.fn(),
}));
vi.mock("../log", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { loadRois, registerRoiCollector, resetRoiSaveState, saveRoiNow, scheduleRoiSave, subscribeRoiSave } =
  await import("./roiSaveStore");

const PK = "PAT-1";
const roi = (uid: string): SavedRoi => ({
  roiUid: uid,
  tool: "Bidirectional",
  sopInstanceUid: "1.2.3",
  points: [[0, 0, 0], [1, 1, 1]],
});

/** saveRoiDocument に渡された JSON を読む。 */
function lastSaved(): { rois: SavedRoi[]; deleted: { roiUid: string }[] } {
  const call = saveRoiDocument.mock.calls[saveRoiDocument.mock.calls.length - 1];
  return JSON.parse(call[1] as string);
}

function docOf(rois: SavedRoi[], deleted: { roiUid: string; at: string }[] = [], version: number | null = 1) {
  return {
    patientKey: PK,
    json: JSON.stringify({ schema: 1, rois, deleted }),
    roiCount: rois.length,
    updatedAt: "2026-07-30T00:00:00Z",
    version,
  };
}

beforeEach(() => {
  resetRoiSaveState();
  fetchRoiDocument.mockReset();
  saveRoiDocument.mockReset();
  // 既定: 未保存（空）→ 保存すると版 1 が返る。
  fetchRoiDocument.mockResolvedValue({ patientKey: PK, json: null, roiCount: 0, updatedAt: null, version: null });
  saveRoiDocument.mockImplementation((_pk, json, count) =>
    Promise.resolve({ patientKey: PK, json, roiCount: count, updatedAt: "now", version: 1 }),
  );
});

afterEach(() => {
  resetRoiSaveState();
  vi.useRealTimers();
});

describe("loadRois", () => {
  it("保存済みを読み、版を確定させる", async () => {
    fetchRoiDocument.mockResolvedValue(docOf([roi("a")], [], 7));
    const parsed = await loadRois(PK);
    expect(parsed.rois.map((r) => r.roiUid)).toEqual(["a"]);
  });

  it("読めなくても例外にせず空を返す", async () => {
    fetchRoiDocument.mockRejectedValue(new Error("network error"));
    expect(await loadRois(PK)).toEqual({ rois: [], deleted: [] });
  });
});

describe("saveRoiNow", () => {
  it("収集した ROI を保存する", async () => {
    registerRoiCollector(PK, () => [roi("a"), roi("b")]);
    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(true);
    expect(res.roiCount).toBe(2);
    expect(lastSaved().rois.map((r) => r.roiUid)).toEqual(["a", "b"]);
  });

  it("読む前に保存しようとしても、先に読んで版を取る（409 を踏まない）", async () => {
    registerRoiCollector(PK, () => [roi("a")]);
    await saveRoiNow(PK);
    // 版が未確定だったので内部で fetch している。
    expect(fetchRoiDocument).toHaveBeenCalledWith(PK);
    expect(saveRoiDocument.mock.calls[0][3]).toBeNull(); // 未保存なので version=null
  });

  it("2 回目の保存では前回の版を返送する", async () => {
    registerRoiCollector(PK, () => [roi("a")]);
    await saveRoiNow(PK);
    await saveRoiNow(PK);
    expect(saveRoiDocument.mock.calls[1][3]).toBe(1);
  });

  it("収集関数が無ければ保存しない", async () => {
    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(false);
    expect(saveRoiDocument).not.toHaveBeenCalled();
  });

  it("収集関数が投げても落ちない", async () => {
    registerRoiCollector(PK, () => {
      throw new Error("boom");
    });
    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(false);
    expect(saveRoiDocument).not.toHaveBeenCalled();
  });
});

describe("削除の墓標", () => {
  it("読み込み後に消えた ROI は墓標になる", async () => {
    fetchRoiDocument.mockResolvedValue(docOf([roi("a"), roi("b")], [], 3));
    await loadRois(PK);
    // b をユーザーが削除した状態を収集で表現する。
    registerRoiCollector(PK, () => [roi("a")]);
    await saveRoiNow(PK);
    const saved = lastSaved();
    expect(saved.rois.map((r) => r.roiUid)).toEqual(["a"]);
    expect(saved.deleted.map((t) => t.roiUid)).toEqual(["b"]);
  });

  it("既存の墓標は読み込みで引き継ぎ、保存に残る", async () => {
    fetchRoiDocument.mockResolvedValue(docOf([roi("a")], [{ roiUid: "old", at: "2026-01-01T00:00:00Z" }], 3));
    await loadRois(PK);
    registerRoiCollector(PK, () => [roi("a")]);
    await saveRoiNow(PK);
    expect(lastSaved().deleted.map((t) => t.roiUid)).toEqual(["old"]);
  });

  it("保存が失敗しても墓標は保留され、次の保存で出る", async () => {
    fetchRoiDocument.mockResolvedValue(docOf([roi("a"), roi("b")], [], 3));
    await loadRois(PK);
    registerRoiCollector(PK, () => [roi("a")]);
    saveRoiDocument.mockRejectedValueOnce(new Error("network error"));
    const first = await saveRoiNow(PK);
    expect(first.ok).toBe(false);

    saveRoiDocument.mockImplementation((_pk, json, count) =>
      Promise.resolve({ patientKey: PK, json, roiCount: count, updatedAt: "now", version: 4 }),
    );
    const second = await saveRoiNow(PK);
    expect(second.ok).toBe(true);
    // 1 回目で作られた墓標が消えていない。
    expect(lastSaved().deleted.map((t) => t.roiUid)).toEqual(["b"]);
  });

  it("保存成功後は既知 UID が更新され、同じ ROI が再び墓標にならない", async () => {
    fetchRoiDocument.mockResolvedValue(docOf([roi("a")], [], 3));
    await loadRois(PK);
    registerRoiCollector(PK, () => [roi("a")]);
    await saveRoiNow(PK);
    await saveRoiNow(PK);
    expect(lastSaved().deleted).toEqual([]);
  });
});

describe("競合（409）時のマージ再試行", () => {
  it("別ウィンドウの ROI を消さずにマージして保存する", async () => {
    registerRoiCollector(PK, () => [roi("mine")]);
    // 1 回目は 409、その後の読み直しで相手の ROI が見える。
    saveRoiDocument.mockRejectedValueOnce(new Error("HTTP 409"));
    fetchRoiDocument
      .mockResolvedValueOnce({ patientKey: PK, json: null, roiCount: 0, updatedAt: null, version: null })
      .mockResolvedValueOnce(docOf([roi("theirs")], [], 9));
    saveRoiDocument.mockImplementation((_pk, json, count) =>
      Promise.resolve({ patientKey: PK, json, roiCount: count, updatedAt: "now", version: 10 }),
    );

    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(true);
    expect(res.merged).toBe(true);
    expect(lastSaved().rois.map((r) => r.roiUid).sort()).toEqual(["mine", "theirs"]);
    // 再試行では読み直した版を使う。
    expect(saveRoiDocument.mock.calls[1][3]).toBe(9);
  });

  it("相手が削除した ROI は、こちらが持っていても復活させない", async () => {
    fetchRoiDocument.mockResolvedValueOnce(docOf([roi("x"), roi("y")], [], 1));
    await loadRois(PK);
    registerRoiCollector(PK, () => [roi("x"), roi("y")]);
    saveRoiDocument.mockRejectedValueOnce(new Error("HTTP 409"));
    // 相手が y を削除して保存済み。
    fetchRoiDocument.mockResolvedValueOnce(docOf([roi("x")], [{ roiUid: "y", at: "2026-07-30T01:00:00Z" }], 5));
    saveRoiDocument.mockImplementation((_pk, json, count) =>
      Promise.resolve({ patientKey: PK, json, roiCount: count, updatedAt: "now", version: 6 }),
    );

    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(true);
    expect(lastSaved().rois.map((r) => r.roiUid)).toEqual(["x"]);
    expect(lastSaved().deleted.map((t) => t.roiUid)).toEqual(["y"]);
  });

  it("409 以外のエラーでは再試行しない（無駄な上書きを避ける）", async () => {
    registerRoiCollector(PK, () => [roi("a")]);
    saveRoiDocument.mockRejectedValue(new Error("HTTP 500"));
    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(false);
    expect(res.merged).toBeUndefined();
    expect(saveRoiDocument).toHaveBeenCalledTimes(1);
  });

  it("再試行も失敗したら失敗を返す（黙って成功にしない）", async () => {
    registerRoiCollector(PK, () => [roi("a")]);
    saveRoiDocument.mockRejectedValue(new Error("HTTP 409"));
    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(false);
    expect(res.merged).toBe(true);
  });
});

describe("デバウンス", () => {
  it("連続した変更は 1 回にまとめる", async () => {
    vi.useFakeTimers();
    registerRoiCollector(PK, () => [roi("a")]);
    scheduleRoiSave(PK, 50);
    scheduleRoiSave(PK, 50);
    scheduleRoiSave(PK, 50);
    expect(saveRoiDocument).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60);
    expect(saveRoiDocument).toHaveBeenCalledTimes(1);
  });

  it("収集関数が未登録なら予約しない", async () => {
    vi.useFakeTimers();
    scheduleRoiSave(PK, 10);
    await vi.advanceTimersByTimeAsync(20);
    expect(saveRoiDocument).not.toHaveBeenCalled();
  });

  it("明示保存は予約を取り消して即座に保存する（二重保存しない）", async () => {
    vi.useFakeTimers();
    registerRoiCollector(PK, () => [roi("a")]);
    scheduleRoiSave(PK, 1000);
    const res = await saveRoiNow(PK);
    expect(res.ok).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(saveRoiDocument).toHaveBeenCalledTimes(1);
  });
});

describe("収集関数の解除", () => {
  it("保留中の保存があれば解除時に流し切る（ウィンドウを閉じて計測が消えない）", async () => {
    vi.useFakeTimers();
    const unregister = registerRoiCollector(PK, () => [roi("a")]);
    scheduleRoiSave(PK, 5000);
    unregister();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveRoiDocument).toHaveBeenCalledTimes(1);
  });

  it("保留が無ければ解除時に保存しない", async () => {
    const unregister = registerRoiCollector(PK, () => [roi("a")]);
    unregister();
    expect(saveRoiDocument).not.toHaveBeenCalled();
  });
});

describe("購読", () => {
  it("保存結果が通知される", async () => {
    const seen: Array<{ pk: string; ok: boolean }> = [];
    const unsub = subscribeRoiSave((pk, r) => seen.push({ pk, ok: r.ok }));
    registerRoiCollector(PK, () => [roi("a")]);
    await saveRoiNow(PK);
    unsub();
    expect(seen).toEqual([{ pk: PK, ok: true }]);
  });

  it("購読側が投げても保存は成功扱いのまま", async () => {
    const unsub = subscribeRoiSave(() => {
      throw new Error("listener boom");
    });
    registerRoiCollector(PK, () => [roi("a")]);
    const res = await saveRoiNow(PK);
    unsub();
    expect(res.ok).toBe(true);
  });
});
