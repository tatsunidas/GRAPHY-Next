/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { path: string; body: Record<string, unknown> }[] = [];
const emitted: unknown[] = [];
let probe: Record<string, unknown>;
let exportReply: unknown;
let jobFails = false;
let isDesktop = true;
vi.mock("../http", async (orig) => {
  const actual = await orig<typeof import("../http")>();
  return {
    ...actual,
    httpSend: vi.fn(async (path: string, _m: string, body: Record<string, unknown>) => {
      sent.push({ path, body });
      if (path.endsWith("/probe")) return probe;
      if (path.endsWith("/export")) {
        if (exportReply instanceof Error) throw exportReply;
        return exportReply;
      }
      if (path.endsWith("/release")) return undefined;
      return { jobId: "job1" };
    }),
    httpGet: vi.fn(async () =>
      jobFails
        ? { state: "FAILED", error: "boom", progress: 0, message: "" }
        : { state: "DONE", progress: 1, message: "", result: { studyInstanceUid: "1.2", seriesInstanceUid: "1.3", slices: 4, phases: 2, geometrySynthesized: false } },
    ),
  };
});
vi.mock("../dbEvents", () => ({ emitDbChanged: (d: unknown) => emitted.push(d) }));
vi.mock("../desktopBridge", async (orig) => ({ ...(await orig<typeof import("../desktopBridge")>()), desktop: () => (isDesktop ? {} : null) }));

import { HttpError } from "../http";
import { __setNiftiConfirm, exportNiftiSeries, importNiftiVolume, releaseNifti } from "./pluginNiftiApi";
import type { PluginNiftiImportRequest } from "./pluginTypes";

const plugin = { id: "nb", name: "Format bridge" };
const req = (over: Partial<PluginNiftiImportRequest> = {}): PluginNiftiImportRequest => ({
  path: "/tmp/graphy-plugin-nifti/nb/j/out.nii.gz",
  sourceName: "scan.v",
  patient: { patientId: "P1", patientName: "Name^P" },
  modality: "PT",
  ...over,
});
const importCalls = () => sent.filter((s) => s.path.endsWith("/import"));

beforeEach(() => {
  sent.length = 0;
  emitted.length = 0;
  jobFails = false;
  isDesktop = true;
  probe = { columns: 64, rows: 64, slices: 30, phases: 1, channels: 1, format: "NIfTI", geometrySynthesized: false, supported: true };
  exportReply = { ok: true, path: "/tmp/graphy-plugin-nifti/nb/u/volume.nii.gz", bytes: 5, slices: 16, frames: 1, timeStepSec: null };
});
afterEach(() => __setNiftiConfirm(null));

describe("importNiftiVolume（H79）", () => {
  it("確認で「やめる」→ 取り込みを backend へ送らず、cancelled（負例）", async () => {
    __setNiftiConfirm(async () => false);
    const r = await importNiftiVolume(plugin, req());
    expect(r).toMatchObject({ ok: false, cancelled: true });
    expect(importCalls()).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it("確認画面の中身は、プラグインの申告ではなく本体が読んだヘッダ。出所はマニフェストの名前", async () => {
    probe = { ...probe, columns: 32, rows: 24, slices: 16, phases: 8, format: "NIfTI pair" };
    const seen: unknown[] = [];
    __setNiftiConfirm(async (l) => (seen.push(l), true));
    await importNiftiVolume(plugin, req({ sourceName: "claimed-as-other.nii" }));
    expect(seen[0]).toMatchObject({ pluginName: "Format bridge", patient: "P1 / Name^P", format: "NIfTI pair", geometrySynthesized: false });
    expect((seen[0] as { shape: string }).shape).toContain("32×24×16");
    expect((seen[0] as { shape: string }).shape).toContain("8");
  });

  it("向きが合成のときは確認画面の行にそれが出る", async () => {
    probe = { ...probe, geometrySynthesized: true };
    const seen: unknown[] = [];
    __setNiftiConfirm(async (l) => (seen.push(l), true));
    await importNiftiVolume(plugin, req());
    expect(seen[0]).toMatchObject({ geometrySynthesized: true });
  });

  it("「取り込む」→ 1 回だけ backend へ送り、成功で DB の変更を通知する", async () => {
    __setNiftiConfirm(async () => true);
    const r = await importNiftiVolume(plugin, req({ sidecar: "/tmp/graphy-plugin-nifti/nb/j/out.json", valueUnit: "Bq/ml", seriesNumber: 3 }));
    expect(r).toMatchObject({ ok: true, studyInstanceUid: "1.2", seriesInstanceUid: "1.3", slices: 4, phases: 2, geometrySynthesized: false });
    expect(importCalls()).toHaveLength(1);
    expect(importCalls()[0].path).toBe("/api/plugins/nb/nifti/import");
    expect(importCalls()[0].body).toMatchObject({
      path: "/tmp/graphy-plugin-nifti/nb/j/out.nii.gz",
      metadataPath: "/tmp/graphy-plugin-nifti/nb/j/out.json",
      patientId: "P1",
      modality: "PT",
      valueUnit: "Bq/ml",
      seriesNumber: 3,
    });
    expect(emitted).toEqual([{ reason: "plugin:nb", studyUids: ["1.2"] }]);
  });

  it("確認の前に断る: web・パスなし・患者 ID なし（確認画面は出ない）", async () => {
    let shown = 0;
    __setNiftiConfirm(async () => (shown++, true));
    isDesktop = false;
    expect(await importNiftiVolume(plugin, req())).toMatchObject({ ok: false, error: "desktop-only" });
    isDesktop = true;
    expect(await importNiftiVolume(plugin, req({ path: " " }))).toMatchObject({ ok: false, error: "no-path" });
    expect(await importNiftiVolume(plugin, req({ patient: { patientId: " " } }))).toMatchObject({ ok: false, error: "no-patient" });
    expect(shown).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it("下読みで読めない・未対応の形式は、確認画面を出さずに断る", async () => {
    let shown = 0;
    __setNiftiConfirm(async () => (shown++, true));
    probe = { ...probe, supported: false, pixelConversion: "未対応のデータ型" };
    expect(await importNiftiVolume(plugin, req())).toMatchObject({ ok: false, error: "未対応のデータ型" });
    expect(shown).toBe(0);
    expect(importCalls()).toHaveLength(0);
  });

  it("取り込みのジョブが失敗したら、エラーを返し、DB の変更は通知しない", async () => {
    __setNiftiConfirm(async () => true);
    jobFails = true;
    const r = await importNiftiVolume(plugin, req());
    expect(r).toMatchObject({ ok: false, error: "boom" });
    expect(emitted).toHaveLength(0);
  });
});

describe("exportNiftiSeries・releaseNifti（H78）", () => {
  it("書き出し: プラグイン ID の口へ送り、返ったパス・時相・間隔をそのまま渡す。確認画面は出ない", async () => {
    exportReply = { ok: true, path: "/tmp/x/volume.nii.gz", bytes: 9, slices: 48, frames: 3, timeStepSec: 5 };
    const r = await exportNiftiSeries("nb", { studyUid: "S", seriesUid: "T" });
    expect(r).toMatchObject({ ok: true, path: "/tmp/x/volume.nii.gz", frames: 3, timeStepSec: 5 });
    expect(sent[0]).toMatchObject({ path: "/api/plugins/nb/nifti/export", body: { studyUid: "S", seriesUid: "T" } });
  });

  it("断る形（チルトなど）は backend の理由コードを error に入れて返す（例外にしない）", async () => {
    exportReply = new HttpError("volume-sheared", 422);
    expect(await exportNiftiSeries("nb", { studyUid: "S", seriesUid: "T" })).toEqual({ ok: false, error: "volume-sheared" });
  });

  it("web・入力なしは送らずに断る", async () => {
    isDesktop = false;
    expect(await exportNiftiSeries("nb", { studyUid: "S", seriesUid: "T" })).toEqual({ ok: false, error: "desktop-only" });
    isDesktop = true;
    expect(await exportNiftiSeries("nb", { studyUid: "", seriesUid: "T" })).toEqual({ ok: false, error: "bad-request" });
    expect(sent).toHaveLength(0);
  });

  it("release は自分の ID の口へ送る", async () => {
    expect(await releaseNifti("nb", "/tmp/x/volume.nii.gz")).toEqual({ ok: true });
    expect(sent[0]).toMatchObject({ path: "/api/plugins/nb/nifti/release", body: { path: "/tmp/x/volume.nii.gz" } });
  });
});
