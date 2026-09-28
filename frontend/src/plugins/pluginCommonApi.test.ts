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

import { runBackendJob, searchPatients } from "./pluginCommonApi";

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
