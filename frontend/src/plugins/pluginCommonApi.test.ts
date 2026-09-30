/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const httpGet = vi.fn();
const httpSend = vi.fn();
vi.mock("../http", () => ({
  httpGet: (...a: unknown[]) => httpGet(...a),
  httpSend: (...a: unknown[]) => httpSend(...a),
}));

import { listVideos, runBackendJob, searchPatients } from "./pluginCommonApi";

const status = (state: string, extra: Record<string, unknown> = {}) => ({
  jobId: "j1",
  state,
  progress: 0,
  message: "",
  elapsedMs: 0,
  result: null,
  error: null,
  ...extra,
});

beforeEach(() => {
  httpGet.mockReset();
  httpSend.mockReset();
});

describe("runBackendJob（H45）", () => {
  it("プラグインの id のジョブを投入し、進み具合を渡して結果を返す", async () => {
    httpSend.mockResolvedValueOnce(status("QUEUED"));
    httpGet
      .mockResolvedValueOnce(status("RUNNING", { progress: 0.5, message: "half" }))
      .mockResolvedValueOnce(status("DONE", { progress: 1, result: { n: 3 } }));
    const seen: [number, string][] = [];
    const r = await runBackendJob("uvs", { op: "x" }, { pollMs: 1, onProgress: (p, m) => seen.push([p, m]) });
    expect(httpSend).toHaveBeenCalledWith("/api/plugins/uvs/jobs", "POST", { op: "x" });
    expect(httpGet).toHaveBeenCalledWith("/api/plugin-jobs/j1");
    expect(seen).toEqual([
      [0.5, "half"],
      [1, ""],
    ]);
    expect(r).toEqual({ ok: true, result: { n: 3 } });
  });

  it("abort すると取り消しを 1 回だけ送り、CANCELLED を取り消しとして返す", async () => {
    httpSend.mockResolvedValueOnce(status("QUEUED")).mockResolvedValue(undefined);
    const ac = new AbortController();
    ac.abort();
    httpGet.mockResolvedValueOnce(status("RUNNING")).mockResolvedValueOnce(status("CANCELLED"));
    const r = await runBackendJob("uvs", {}, { pollMs: 1, signal: ac.signal });
    expect(httpSend.mock.calls.filter((c) => c[1] === "DELETE")).toEqual([["/api/plugin-jobs/j1", "DELETE"]]);
    expect(r).toEqual({ ok: false, cancelled: true });
  });

  it("例外は投げず、失敗・投入の拒否を {ok:false, error} で返す", async () => {
    httpSend.mockResolvedValueOnce(status("QUEUED"));
    httpGet.mockResolvedValueOnce(status("FAILED", { error: "boom" }));
    expect(await runBackendJob("uvs", {}, { pollMs: 1 })).toEqual({ ok: false, error: "boom" });

    httpSend.mockRejectedValueOnce(new Error("HTTP 501"));
    expect(await runBackendJob("uvs", {})).toEqual({ ok: false, error: "HTTP 501" });
  });
});

describe("searchPatients（H44）", () => {
  it("patientKey を患者 ID → 氏名の順で作り、どちらも無い患者は落とす", async () => {
    httpGet.mockResolvedValueOnce([
      { patientId: "K12", patientName: "K^12", patientBirthDate: "20200101", patientSex: "F", numberOfStudies: 2 },
      { patientId: "", patientName: "NONAME", patientBirthDate: null, patientSex: null, numberOfStudies: 1 },
      { patientId: null, patientName: null, patientBirthDate: null, patientSex: null, numberOfStudies: 1 },
    ]);
    const r = await searchPatients(" k1 ");
    expect(httpGet).toHaveBeenCalledWith("/api/patients?q=k1");
    expect(r.map((p) => p.patientKey)).toEqual(["K12", "NONAME"]);
    expect(r[0]).toMatchObject({ birthDate: "20200101", sex: "F", studyCount: 2 });
  });
});

describe("listVideos（H51）", () => {
  const H264 = "1.2.840.10008.1.2.4.102";
  const US_MF = "1.2.840.10008.5.1.4.1.1.3.1";
  const CT = "1.2.840.10008.5.1.4.1.1.2";
  const routes: Record<string, unknown> = {
    "/api/studies?studyInstanceUid=S1": [{ studyInstanceUid: "S1", patientId: "K12", patientName: "A^B", studyDate: "20260901", studyDescription: "old" }],
    "/api/studies?patientId=K12": [
      { studyInstanceUid: "S1", patientId: "K12", patientName: "A^B", studyDate: "20260901", studyDescription: "old" },
      { studyInstanceUid: "S2", patientId: "K12", patientName: "A^B", studyDate: "20260926", studyDescription: "new" },
      { studyInstanceUid: "SX", patientId: "K120", patientName: "C^D", studyDate: "20260927", studyDescription: "other" },
    ],
    "/api/studies/S1/series": [
      { seriesInstanceUid: "S1-2", modality: "US", seriesNumber: 2, seriesDescription: "[Plugin] b" },
      { seriesInstanceUid: "S1-1", modality: "US", seriesNumber: 1, seriesDescription: "[Plugin] a" },
      { seriesInstanceUid: "S1-CT", modality: "CT", seriesNumber: 3, seriesDescription: "ct" },
    ],
    "/api/studies/S2/series": [{ seriesInstanceUid: "S2-1", modality: "US", seriesNumber: 1, seriesDescription: "[Plugin] c" }],
    "/api/studies/S1/series/S1-1/instances": [{ sopInstanceUid: "v1", sopClassUid: US_MF, transferSyntaxUid: H264 }],
    "/api/studies/S1/series/S1-2/instances": [{ sopInstanceUid: "v2", sopClassUid: US_MF, transferSyntaxUid: H264 }],
    "/api/studies/S1/series/S1-CT/instances": [{ sopInstanceUid: "ct1", sopClassUid: CT, transferSyntaxUid: "1.2.840.10008.1.2.1" }],
    "/api/studies/S2/series/S2-1/instances": [{ sopInstanceUid: "v3", sopClassUid: "1.2.840.10008.5.1.4.1.1.77.1.4.1", transferSyntaxUid: H264 }],
  };
  beforeEach(() => {
    httpGet.mockImplementation(async (url: string) => {
      if (!(url in routes)) throw new Error(`unexpected ${url}`);
      return routes[url];
    });
  });

  it("検査で引くと、その検査の動画だけ（CT などは拾わない）をシリーズ番号の順に返す", async () => {
    const r = await listVideos({ studyUid: "S1" });
    expect(r.map((v) => [v.sopInstanceUid, v.seriesDescription])).toEqual([
      ["v1", "[Plugin] a"],
      ["v2", "[Plugin] b"],
    ]);
    expect(r[0]).toMatchObject({ patientKey: "K12", studyUid: "S1", studyDate: "20260901", modality: "US",
      sopClassUid: US_MF, transferSyntaxUid: H264 });
  });

  it("患者で引くと、ID が完全一致する患者の検査を新しい順に返す（部分一致の別人は混ぜない）", async () => {
    const r = await listVideos({ patientKey: "K12" });
    expect(r.map((v) => v.sopInstanceUid)).toEqual(["v3", "v1", "v2"]);
    expect(r.every((v) => v.patientKey === "K12")).toBe(true);
  });

  it("空の問い合わせは何も引かない", async () => {
    expect(await listVideos({ studyUid: "" })).toEqual([]);
    expect(await listVideos({ patientKey: " " })).toEqual([]);
    expect(httpGet).not.toHaveBeenCalled();
  });
});
