import { beforeEach, describe, expect, it, vi } from "vitest";

const httpGet = vi.fn();
const httpSend = vi.fn();
vi.mock("../http", async (orig) => ({
  ...(await orig<typeof import("../http")>()),
  httpGet: (...a: unknown[]) => httpGet(...a),
  httpSend: (...a: unknown[]) => httpSend(...a),
}));

import { HttpError } from "../http";
import { ensureLocal, storageStatus, validateEnsureRequest } from "./pluginStorageApi";

const job = (state: string, result: unknown = null, error: string | null = null, progress = 0) => ({
  jobId: "J1", state, progress, message: "", elapsedMs: 0, result, error,
});

beforeEach(() => {
  httpGet.mockReset();
  httpSend.mockReset();
});

describe("H62 host.storage.ensureLocal", () => {
  it("検査を確保する: 投入の URL・本文はプラグイン id に固定され、結果は値で返る", async () => {
    httpSend.mockResolvedValueOnce(job("QUEUED"));
    httpGet.mockResolvedValueOnce(job("DONE", { ok: true, total: 5, fetched: 4, alreadyLocal: 1, cacheMode: true }));
    const r = await ensureLocal("my/plugin", { studyUid: "1.2.3", seriesUids: ["4.5"] }, { pollMs: 100 });
    expect(r).toEqual({ ok: true, total: 5, fetched: 4, alreadyLocal: 1, cacheMode: true });
    expect(httpSend).toHaveBeenCalledWith("/api/plugins/my%2Fplugin/storage/ensure", "POST", { studyUid: "1.2.3", seriesUids: ["4.5"] });
    expect(httpGet).toHaveBeenCalledWith("/api/plugin-jobs/J1");
  });

  it("シリーズを省くと本文に seriesUids を入れない（検査全体）。モード A でなければ cacheMode:false", async () => {
    httpSend.mockResolvedValueOnce(job("QUEUED"));
    httpGet.mockResolvedValueOnce(job("DONE", { ok: true, total: 3, fetched: 0, alreadyLocal: 3, cacheMode: false }));
    const r = await ensureLocal("p", { studyUid: "1.2.3" }, { pollMs: 100 });
    expect(httpSend.mock.calls[0][2]).toEqual({ studyUid: "1.2.3" });
    expect(r).toMatchObject({ ok: true, fetched: 0, cacheMode: false });
  });

  it("進み具合を通知する", async () => {
    httpSend.mockResolvedValueOnce(job("QUEUED"));
    httpGet.mockResolvedValueOnce(job("RUNNING", null, null, 0.5)).mockResolvedValueOnce(job("DONE", { ok: true, total: 2, fetched: 2, alreadyLocal: 0, cacheMode: true }, null, 1));
    const seen: number[] = [];
    await ensureLocal("p", { studyUid: "1" }, { pollMs: 100, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([0.5, 1]);
  });

  it("取り寄せに失敗した結果（ok:false）は、例外でなく理由コードつきの値（負例）", async () => {
    httpSend.mockResolvedValueOnce(job("QUEUED"));
    httpGet.mockResolvedValueOnce(job("DONE", { ok: false, error: "offline", fetched: 16 }));
    expect(await ensureLocal("p", { studyUid: "1" }, { pollMs: 100 })).toEqual({ ok: false, error: "offline", fetched: 16 });
  });

  it("検査が無い・ジョブの失敗・取り消しは、それぞれ値で返る", async () => {
    httpSend.mockResolvedValueOnce(job("QUEUED"));
    httpGet.mockResolvedValueOnce(job("DONE", { ok: false, error: "not-found" }));
    expect(await ensureLocal("p", { studyUid: "x" }, { pollMs: 100 })).toMatchObject({ ok: false, error: "not-found" });
    httpSend.mockResolvedValueOnce(job("QUEUED"));
    httpGet.mockResolvedValueOnce(job("FAILED", null, "boom"));
    expect(await ensureLocal("p", { studyUid: "x" }, { pollMs: 100 })).toEqual({ ok: false, error: "boom" });
    httpSend.mockResolvedValueOnce(job("QUEUED"));
    httpGet.mockResolvedValueOnce(job("CANCELLED"));
    expect(await ensureLocal("p", { studyUid: "x" }, { pollMs: 100 })).toEqual({ ok: false, cancelled: true });
  });

  it("abort すると backend に取り消しを求める", async () => {
    httpSend.mockResolvedValueOnce(job("QUEUED")).mockResolvedValue(undefined);
    httpGet.mockResolvedValueOnce(job("RUNNING")).mockResolvedValueOnce(job("CANCELLED"));
    const ac = new AbortController();
    ac.abort();
    const r = await ensureLocal("p", { studyUid: "1" }, { pollMs: 100, signal: ac.signal });
    expect(r).toEqual({ ok: false, cancelled: true });
    expect(httpSend).toHaveBeenCalledWith("/api/plugin-jobs/J1", "DELETE");
  });

  it("投入が断られたら（404・501・400）その理由を値で返す。通信は 1 回だけ", async () => {
    httpSend.mockRejectedValueOnce(new HttpError("desktop-only", 501));
    expect(await ensureLocal("p", { studyUid: "1" })).toEqual({ ok: false, error: "desktop-only" });
    expect(httpGet).not.toHaveBeenCalled();
  });

  it("要求の形が悪ければ、送らずに理由コードで返す（負例）", async () => {
    for (const [req, code] of [
      [{ studyUid: "" }, "invalid-study-uid"],
      [{ studyUid: "   " }, "invalid-study-uid"],
      [{ studyUid: "9".repeat(65) }, "invalid-study-uid"],
      [{}, "invalid-study-uid"],
      [null, "invalid-study-uid"],
      [{ studyUid: "1", seriesUids: "x" }, "invalid-series-uid"],
      [{ studyUid: "1", seriesUids: [""] }, "invalid-series-uid"],
      [{ studyUid: "1", seriesUids: [1] }, "invalid-series-uid"],
      [{ studyUid: "1", seriesUids: Array(1001).fill("a") }, "too-many-series"],
    ] as const) {
      expect(validateEnsureRequest(req), JSON.stringify(req).slice(0, 40)).toBe(code);
      expect(await ensureLocal("p", req as never)).toEqual({ ok: false, error: code });
    }
    expect(httpSend).not.toHaveBeenCalled();
    expect(validateEnsureRequest({ studyUid: "1.2.3" })).toBeNull();
    expect(validateEnsureRequest({ studyUid: "1.2.3", seriesUids: ["a", "b"] })).toBeNull();
  });
});

describe("H62 host.storage.status", () => {
  it("状態の URL はプラグイン id に固定される", async () => {
    httpGet.mockResolvedValueOnce({ cacheMode: true, usedBytes: 1, limitBytes: 2, remoteOnlyCount: 3 });
    expect(await storageStatus("a b")).toEqual({ cacheMode: true, usedBytes: 1, limitBytes: 2, remoteOnlyCount: 3 });
    expect(httpGet).toHaveBeenCalledWith("/api/plugins/a%20b/storage/status");
  });
});
