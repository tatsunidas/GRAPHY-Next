import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnonJobStatus, AnonRequest } from "../api";
import {
  cancelAnonJob,
  downloadAnonJobZip,
  fetchAnonJobConfig,
  submitAnonJob,
} from "../api";
import type { AnonRoiCandidate } from "./anonRoiCandidates";
import {
  buildJobRequest,
  groupRoiPolygons,
  jobNotes,
  jobOutcome,
  roiMasksForJob,
  stowBlockedByOptions,
} from "./anonWebJob";

const poly = (sop: string) => ({ xs: [0, 10, 10], ys: [0, 0, 10], sopInstanceUids: [sop], frames: [] as number[] });
const cand = (roiUid: string, seriesUid: string, frame: number | null = null): AnonRoiCandidate => ({
  roiUid, label: roiUid, tool: "rect", seriesUid, seriesLabel: "", sopInstanceUid: "s", frame, polygon: poly("s"),
});

const status = (over: Partial<AnonJobStatus>): AnonJobStatus => ({
  jobId: "j1", state: "DONE", total: 3, processed: 3, instances: 3, burnedInstances: 0, notBurnedInstances: 0,
  partiallyBurnedInstances: 0, usedSeed: null, errorCount: 0, errors: [], error: null, expiresAt: 0,
  output: "zip", stored: 0, ...over,
});

const base: AnonRequest = {
  studyUids: ["1.2"], options: ["CleanPixelData"], replacePatientName: "a", replacePatientId: "b",
  burnIn: true, destination: "C:/x",
};

describe("roiMasksForJob", () => {
  const cands = [cand("a", "S1"), cand("b", "S1"), cand("c", "S2")];
  it("チェックした ROI だけをシリーズごとにまとめる", () => {
    const m = roiMasksForJob(cands, new Set(["a", "c"]), false);
    expect(m.map((x) => [x.seriesUid, x.polygons?.length])).toEqual([["S1", 1], ["S2", 1]]);
  });
  it("チェックが無いシリーズは載せない（web に置き換え登録は無い）", () => {
    expect(roiMasksForJob(cands, new Set(["c"]), false).map((x) => x.seriesUid)).toEqual(["S2"]);
    expect(roiMasksForJob(cands, new Set(), false)).toEqual([]);
  });
  it("既定は全フレーム、drawnFrameOnly だと描いたフレームだけ", () => {
    const withFrame = [cand("a", "S1", 4)];
    expect(roiMasksForJob(withFrame, new Set(["a"]), false)[0].polygons![0].frames).toEqual([]);
    expect(roiMasksForJob(withFrame, new Set(["a"]), true)[0].polygons![0].frames).toEqual([4]);
  });
  it("groupRoiPolygons は空のシリーズも持つ（standalone の置き換え登録用）", () => {
    expect([...groupRoiPolygons(cands, new Set(["c"]), false)].map(([k, v]) => [k, v.length])).toEqual([["S1", 0], ["S2", 1]]);
  });
});

describe("buildJobRequest", () => {
  it("destination を持たず、output と masks を載せる", () => {
    const masks = roiMasksForJob([cand("a", "S1")], new Set(["a"]), false);
    const r = buildJobRequest(base, "stow", masks);
    expect(r.output).toBe("stow");
    expect(r.masks).toEqual(masks);
    expect("destination" in r).toBe(false);
    expect(r.burnIn).toBe(true);
  });
  it("CleanPixelData が無ければ焼き込みもマスクも送らない", () => {
    const r = buildJobRequest({ ...base, options: [] }, "zip", roiMasksForJob([cand("a", "S1")], new Set(["a"]), false));
    expect(r.burnIn).toBe(false);
    expect(r.masks).toEqual([]);
  });
});

describe("stowBlockedByOptions / jobOutcome / jobNotes", () => {
  it("RetainUIDs のときだけ PACS 保存を止める", () => {
    expect(stowBlockedByOptions(new Set(["RetainUIDs"]))).toBe(true);
    expect(stowBlockedByOptions(new Set(["CleanPixelData"]))).toBe(false);
  });
  it("終了状態を分ける", () => {
    expect(jobOutcome(status({}))).toEqual({ kind: "zipReady" });
    expect(jobOutcome(status({ output: "stow", stored: 3 }))).toEqual({ kind: "stowed", stored: 3 });
    expect(jobOutcome(status({ state: "CANCELLED", output: "stow", stored: 2 }))).toEqual({ kind: "cancelled", stored: 2 });
    expect(jobOutcome(status({ state: "FAILED", error: "x", stored: 2 }))).toEqual({ kind: "failed", error: "x", stored: 2 });
  });
  it("未焼き込み・一部焼き込み・失敗を片方で上書きせず全部出す", () => {
    const keys = jobNotes(status({ notBurnedInstances: 1, partiallyBurnedInstances: 2, errorCount: 3 })).map((n) => n.key);
    expect(keys).toEqual(["anon.burnIn.warn.unmasked", "anon.burnIn.warn.partial", "anon.job.errors"]);
    expect(jobNotes(status({}))).toEqual([]);
  });
});

describe("匿名化ジョブ API", () => {
  beforeEach(() => vi.stubGlobal("window", {}));
  afterEach(() => vi.unstubAllGlobals());
  const stub = (res: Partial<Response> & { ok: boolean }) => {
    const f = vi.fn().mockResolvedValue({ headers: new Headers(), json: async () => ({}), blob: async () => new Blob(["z"]), ...res });
    vi.stubGlobal("fetch", f);
    return f;
  };
  const headerOf = (f: ReturnType<typeof vi.fn>, i = 0) => (f.mock.calls[i][1].headers as Record<string, string>);

  it("書き込み（POST・DELETE）に X-Graphy-Request を付ける", async () => {
    const f = stub({ ok: true });
    await submitAnonJob({ ...base, output: "zip" });
    await cancelAnonJob("j/1");
    expect(headerOf(f, 0)["X-Graphy-Request"]).toBeTruthy();
    expect(f.mock.calls[0][1].method).toBe("POST");
    expect(headerOf(f, 1)["X-Graphy-Request"]).toBeTruthy();
    expect(f.mock.calls[1][1].method).toBe("DELETE");
    expect(String(f.mock.calls[1][0])).toContain("/api/anonymizer/jobs/j%2F1");
  });
  it("403（取り込み未許可）は理由つきの HttpError", async () => {
    stub({
      ok: false, status: 403, headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({ message: "許可されていません" }),
    });
    await expect(submitAnonJob({ ...base, output: "stow" })).rejects.toMatchObject({ status: 403, message: "許可されていません" });
  });
  it("設定とファイル名を読む", async () => {
    stub({ ok: true, json: async () => ({ importEnabled: true }) });
    expect(await fetchAnonJobConfig()).toEqual({ importEnabled: true });
    stub({ ok: true, headers: new Headers({ "content-disposition": 'attachment; filename="anonymized.zip"' }) });
    expect((await downloadAnonJobZip("j1")).filename).toBe("anonymized.zip");
  });
});
