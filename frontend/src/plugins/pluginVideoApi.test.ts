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
  __resetBatchConsents,
  __resetVideoConsents,
  __setBatchConfirm,
  __setDerivedConfirm,
  importDicomFiles,
  requestBatchConsent,
  __setVideoConsentConfirm,
  saveDerivedVideo,
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

describe("H54 派生の動画シリーズ", () => {
  afterEach(() => __setDerivedConfirm(null));
  const base = { artifactJobId: "j-mp4", sourceSopInstanceUid: "2.25.1", referencedFrames: [10, 20, 30], seriesDescription: "Summarized" };
  const jobResult = (extra: Record<string, unknown> = {}) =>
    done({
      result: { target: "db", sopInstanceUid: "2.25.9", seriesInstanceUid: "2.25.8", studyInstanceUid: "1.2", numberOfFrames: 3, seriesDescription: "[Plugin] Summarized" },
      ...extra,
    });

  it("保管庫へ（db）は本体の確認ダイアログを出してから書き、一覧の読み直しを知らせる", async () => {
    const seen: unknown[] = [];
    __setDerivedConfirm(async (l) => {
      seen.push(l);
      return true;
    });
    httpSend.mockImplementation(async (url: string) => (String(url).endsWith("/video/derived") ? { jobId: "j2" } : undefined));
    httpGet.mockResolvedValueOnce(jobResult());
    const r = await saveDerivedVideo(PLUGIN, { ...base, target: "db" }, { pollMs: 1 });
    expect(seen).toEqual([{ pluginName: "UVS", seriesDescription: "[Plugin] Summarized", frames: 3 }]);
    expect(httpSend).toHaveBeenCalledWith("/api/plugins/uvs/video/derived", "POST", expect.objectContaining({ target: "db", referencedFrames: [10, 20, 30] }));
    expect(r).toMatchObject({ ok: true, result: { target: "db", sopInstanceUid: "2.25.9", artifact: null } });
    expect(emitted).toEqual([expect.objectContaining({ reason: "plugin:uvs", studyUids: ["1.2"] })]);
  });

  it("確認ダイアログで取り消すと何も書かない", async () => {
    __setDerivedConfirm(async () => false);
    expect(await saveDerivedVideo(PLUGIN, { ...base, target: "db" })).toEqual({ ok: false, cancelled: true });
    expect(httpSend).not.toHaveBeenCalledWith("/api/plugins/uvs/video/derived", expect.anything(), expect.anything());
  });

  it("ファイルへ（file）は確認ダイアログを出さず、.dcm の成果物を返す（一覧は読み直させない）", async () => {
    __setDerivedConfirm(async () => {
      throw new Error("出してはいけない");
    });
    httpSend.mockImplementation(async (url: string) => (String(url).endsWith("/video/derived") ? { jobId: "j3" } : undefined));
    httpGet.mockResolvedValueOnce(
      done({
        result: { target: "file", sopInstanceUid: "2.25.9", seriesInstanceUid: "2.25.8", studyInstanceUid: "1.2", numberOfFrames: 3, seriesDescription: "x" },
        __artifact: { jobId: "j3", name: "summary.dcm", size: 123 },
      }),
    );
    const r = await saveDerivedVideo(PLUGIN, { ...base, target: "file" }, { pollMs: 1 });
    expect(r).toMatchObject({ ok: true, result: { target: "file", artifact: { jobId: "j3", name: "summary.dcm" } } });
    expect(emitted).toEqual([]);
  });
});

describe("H55 バッチの同意（1 回）と H57 DICOM の取り込み", () => {
  afterEach(() => {
    __setBatchConfirm(null);
    __setDerivedConfirm(null);
    __resetBatchConsents();
  });

  it("確認は 1 回だけ。派生シリーズの保存は札の範囲なら確認を出さず、同じ元 SOP の 2 回目や範囲外は確認する", async () => {
    const batchSeen: unknown[] = [];
    __setBatchConfirm(async (l) => {
      batchSeen.push(l);
      return true;
    });
    const derivedSeen: unknown[] = [];
    __setDerivedConfirm(async (l) => {
      derivedSeen.push(l);
      return false; // 個別の確認が出たら取り消す
    });
    const c = await requestBatchConsent(PLUGIN, {
      importDicom: { paths: ["C:/in/a.dcm"] },
      derived: [
        { sourceSopInstanceUid: "s1", seriesDescription: "Summarized" },
        { sourceSopInstanceUid: "s2", seriesDescription: "Summarized" },
      ],
    });
    expect(c).toMatchObject({ ok: true, importToken: null });
    expect(batchSeen).toEqual([expect.objectContaining({ importDicom: 1, derived: 2, derivedDescription: "[Plugin] Summarized" })]);
    if (!c.ok) return;
    httpSend.mockImplementation(async (url: string) => (String(url).endsWith("/video/derived") ? { jobId: "jd" } : undefined));
    httpGet.mockResolvedValue(done({ result: { target: "db", sopInstanceUid: "d", seriesInstanceUid: "ds", studyInstanceUid: "st", seriesNumber: 2, numberOfFrames: 3, seriesDescription: "x" } }));
    const req = { artifactJobId: "j", sourceSopInstanceUid: "s1", target: "db" as const, consentToken: c.derivedToken! };
    expect((await saveDerivedVideo(PLUGIN, req, { pollMs: 1 })).ok).toBe(true);
    expect(derivedSeen).toEqual([]); // 開始時に済んでいる
    // 同じ元 SOP の 2 回目・範囲外の SOP は個別の確認（ここでは取り消し）
    expect(await saveDerivedVideo(PLUGIN, req)).toEqual({ ok: false, cancelled: true });
    expect(await saveDerivedVideo(PLUGIN, { ...req, sourceSopInstanceUid: "s9" })).toEqual({ ok: false, cancelled: true });
    expect(derivedSeen).toHaveLength(2);
  });

  it("DICOM の取り込みは札の範囲のファイルだけ・本体の通常の取り込みへ", async () => {
    __setBatchConfirm(async () => true);
    const c = await requestBatchConsent(PLUGIN, { importDicom: { paths: ["C:/in/a.dcm", "C:/in/b.dcm"] } });
    if (!c.ok) throw new Error("no consent");
    expect(await importDicomFiles("uvs", { consentToken: c.dicomToken!, paths: ["C:/in/x.dcm"] })).toEqual({ ok: false, error: "path-not-consented" });
    httpSend.mockImplementation(async (url: string) =>
      String(url) === "/api/import/paths" ? { imported: 1, skipped: 0, failed: 0, studiesWithoutDate: 0, errors: [] } : undefined,
    );
    const r = await importDicomFiles("uvs", { consentToken: c.dicomToken!, paths: ["C:/in/a.dcm"] });
    expect(r).toMatchObject({ ok: true, imported: 1 });
    expect(httpSend).toHaveBeenCalledWith("/api/import/paths", "POST", { paths: ["C:/in/a.dcm"] });
    expect(emitted).toEqual([expect.objectContaining({ reason: "plugin:uvs" })]);
  });

  it("取り消せば札は出ない・空の要求は受けない", async () => {
    __setBatchConfirm(async () => false);
    expect(await requestBatchConsent(PLUGIN, { importDicom: { paths: ["a.dcm"] } })).toEqual({ ok: false, cancelled: true });
    expect(await requestBatchConsent(PLUGIN, {})).toEqual({ ok: false, error: "empty" });
  });
});
