/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const httpGet = vi.fn();
const httpSend = vi.fn();
vi.mock("../http", async (orig) => ({
  ...(await orig<typeof import("../http")>()),
  httpGet: (...a: unknown[]) => httpGet(...a),
  httpSend: (...a: unknown[]) => httpSend(...a),
}));
const emitted: unknown[] = [];
vi.mock("../dbEvents", () => ({ emitDbChanged: (d: unknown) => emitted.push(d) }));

import {
  __resetVideoConsents,
  __setVideoConsentConfirm,
  importVideoAsDicom,
  requestVideoImportConsent,
  type ConsentLines,
} from "./pluginVideoApi";

const PLUGIN = { id: "uvs", name: "UVS" };
const NEW = { create: { patientId: "K12", patientName: "K^12" } } as const;
let shown: ConsentLines[] = [];

const done = (result: Record<string, unknown>) => ({
  jobId: "j",
  state: "DONE",
  progress: 1,
  message: "",
  elapsedMs: 0,
  result,
  error: null,
});

beforeEach(() => {
  __resetVideoConsents();
  shown = [];
  emitted.length = 0;
  httpGet.mockReset();
  httpSend.mockReset();
  // 事前確認（validate）は既定で「問題なし」
  httpSend.mockImplementation(async (url: string) => (String(url).endsWith("/video/validate") ? { ok: true, issues: [] } : undefined));
  __setVideoConsentConfirm(async (l) => {
    shown.push(l);
    return true;
  });
});
afterEach(() => __setVideoConsentConfirm(null));

describe("H48 の同意の札", () => {
  it("ダイアログには本体が決めた中身（患者・ファイル名・書く SR）が出る", async () => {
    const r = await requestVideoImportConsent(PLUGIN, {
      patient: NEW,
      paths: ["E:/data/K12.avi", "E:\\data\\K20.avi"],
      modality: "US",
      frameValues: { description: "CPR / MAD" },
    });
    expect(r.ok).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0].pluginName).toBe("UVS");
    expect(shown[0].files).toEqual(["K12.avi", "K20.avi"]);
    expect(shown[0].patient).toContain("K12");
    expect(shown[0].frameValues).toBe("CPR / MAD");
  });

  it("拒否されたら札は出ない", async () => {
    __setVideoConsentConfirm(async () => false);
    expect(await requestVideoImportConsent(PLUGIN, { patient: NEW, paths: ["a.avi"] })).toEqual({ ok: false, cancelled: true });
  });

  it("札の範囲外（別のファイル・別の患者・見せていない SR・別のプラグイン・2 回目）は backend に届く前に拒否する", async () => {
    const c = await requestVideoImportConsent(PLUGIN, { patient: NEW, paths: ["a.avi"], modality: "US" });
    if (!c.ok) throw new Error("no consent");
    const base = { consentToken: c.consentToken, path: "a.avi", patient: NEW, modality: "US" as const };
    expect(await importVideoAsDicom("uvs", { ...base, path: "b.avi" })).toEqual({ ok: false, error: "path-not-consented" });
    expect(await importVideoAsDicom("uvs", { ...base, patient: { patientKey: "OTHER" } })).toEqual({
      ok: false,
      error: "patient-not-consented",
    });
    expect(
      await importVideoAsDicom("uvs", { ...base, frameValues: { series: [{ key: "CPR", label: "c", values: [0] }] } }),
    ).toEqual({ ok: false, error: "frame-values-not-consented" });
    expect(await importVideoAsDicom("other", base)).toEqual({ ok: false, error: "no-consent" });
    expect(await importVideoAsDicom("uvs", { ...base, modality: undefined })).toEqual({
      ok: false,
      error: "modality-not-consented",
    });
    expect(httpSend).not.toHaveBeenCalledWith("/api/plugins/uvs/video/imports", expect.anything(), expect.anything());

    httpSend.mockResolvedValueOnce({ jobId: "j" });
    httpGet.mockResolvedValueOnce(done({ duplicate: false, studyInstanceUid: "1.2", patientId: "K12", sopInstanceUid: "2.25.1" }));
    const ok = await importVideoAsDicom("uvs", base, { pollMs: 1 });
    expect(ok.ok).toBe(true);
    expect(httpSend).toHaveBeenCalledWith("/api/plugins/uvs/video/imports", "POST", expect.objectContaining({
      path: "a.avi",
      patient: { create: NEW.create },
      modality: "US",
    }));
    // 取り込めたら一覧の読み直しを知らせる
    expect(emitted).toEqual([expect.objectContaining({ reason: "plugin:uvs", studyUids: ["1.2"] })]);
    // 同じ札で同じファイルは 2 回撃てない
    expect(await importVideoAsDicom("uvs", base)).toEqual({ ok: false, error: "path-already-imported" });
  });

  it("重複（既に同じ動画がある）は一覧を読み直させない", async () => {
    const c = await requestVideoImportConsent(PLUGIN, { patient: NEW, paths: ["a.avi"] });
    if (!c.ok) throw new Error("no consent");
    httpSend.mockResolvedValueOnce({ jobId: "j" });
    httpGet.mockResolvedValueOnce(done({ duplicate: true, studyInstanceUid: "1.2", sopInstanceUid: "2.25.1" }));
    const r = await importVideoAsDicom("uvs", { consentToken: c.consentToken, path: "a.avi", patient: NEW }, { pollMs: 1 });
    expect(r).toMatchObject({ ok: true, result: { duplicate: true } });
    expect(emitted).toEqual([]);
  });

  it("既存の患者はダイアログに本体が引いた ID と氏名を出す（プラグインの言い分を出さない）", async () => {
    httpGet.mockResolvedValueOnce([
      { patientId: "K12", patientName: "胎児^K12", patientBirthDate: null, patientSex: null, numberOfStudies: 1 },
    ]);
    const r = await requestVideoImportConsent(PLUGIN, { patient: { patientKey: "K12" }, paths: ["a.avi"] });
    expect(r.ok).toBe(true);
    expect(shown[0].patient).toContain("胎児^K12");
    httpGet.mockResolvedValueOnce([]);
    expect(await requestVideoImportConsent(PLUGIN, { patient: { patientKey: "NOPE" }, paths: ["a.avi"] })).toMatchObject({
      ok: false,
    });
  });

  it("動画ごとに違う患者・シリーズの説明を 1 回のダイアログで見せ、札は path ごとの患者に縛る", async () => {
    httpGet.mockResolvedValueOnce([
      { patientId: "P1", patientName: "既存^一郎", patientBirthDate: null, patientSex: null, numberOfStudies: 1 },
    ]);
    const c = await requestVideoImportConsent(PLUGIN, {
      items: [
        { path: "a.avi", patient: { patientKey: "P1" }, seriesDescription: "左室" },
        { path: "b.avi", patient: NEW, seriesDescription: "右室" },
      ],
      modality: "US",
    });
    expect(c.ok).toBe(true);
    expect(shown).toHaveLength(1);
    expect(shown[0].perFilePatients).toBe(true);
    expect(shown[0].rows.map((r) => [r.file, r.seriesDescription])).toEqual([
      ["a.avi", "左室"],
      ["b.avi", "右室"],
    ]);
    expect(shown[0].rows[0].patient).toContain("既存^一郎");
    expect(shown[0].rows[1].patient).toContain("K12");
    if (!c.ok) return;
    // 事前確認には動画ごとの患者を渡す
    expect(httpSend).toHaveBeenCalledWith("/api/plugins/uvs/video/validate", "POST", {
      items: [
        { path: "a.avi", patient: { patientKey: "P1" } },
        { path: "b.avi", patient: { create: NEW.create } },
      ],
    });
    const tok = c.consentToken;
    // a.avi に b.avi の患者を付けたら拒否・シリーズの説明が見せたものと違っても拒否
    expect(await importVideoAsDicom("uvs", { consentToken: tok, path: "a.avi", patient: NEW, modality: "US", seriesDescription: "左室" })).toEqual({
      ok: false,
      error: "patient-not-consented",
    });
    expect(
      await importVideoAsDicom("uvs", { consentToken: tok, path: "b.avi", patient: NEW, modality: "US", seriesDescription: "別物" }),
    ).toEqual({ ok: false, error: "series-description-not-consented" });
  });

  it("★事前確認で問題があれば、ダイアログを出さずに理由（issues）を返す", async () => {
    httpSend.mockImplementation(async (url: string) =>
      String(url).endsWith("/video/validate")
        ? {
            ok: false,
            issues: [{ index: 0, path: "a.avi", code: "patient-exists", message: "患者 ID K12 は既にあります", existingPatientKey: "K12", existingPatientName: "K^12" }],
          }
        : undefined,
    );
    const r = await requestVideoImportConsent(PLUGIN, { patient: NEW, paths: ["a.avi"], modality: "US" });
    expect(r).toMatchObject({ ok: false, error: "patient-exists", issues: [{ existingPatientKey: "K12" }] });
    expect(shown).toEqual([]);
  });

  it("同じファイルを 2 回並べた要求は受けない", async () => {
    const r = await requestVideoImportConsent(PLUGIN, { items: [{ path: "a.avi", patient: NEW }, { path: "a.avi", patient: NEW }] });
    expect(r).toEqual({ ok: false, error: "duplicate-paths" });
    expect(shown).toEqual([]);
  });
});
