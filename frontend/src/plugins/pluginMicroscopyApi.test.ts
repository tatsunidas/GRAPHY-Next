/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: { path: string; body: Record<string, unknown> }[] = [];
const emitted: unknown[] = [];
let failAt = -1;
vi.mock("../http", async (orig) => ({
  ...(await orig<typeof import("../http")>()),
  httpSend: vi.fn(async (path: string, _m: string, body: Record<string, unknown>) => {
    sent.push({ path, body });
    return { jobId: `job${sent.length}` };
  }),
  httpGet: vi.fn(async (url: string) => {
    const n = Number(url.match(/job(\d+)/)?.[1] ?? 0);
    if (n - 1 === failAt) return { state: "FAILED", error: "boom", progress: 0, message: "" };
    return { state: "DONE", progress: 1, message: "", result: { studyInstanceUid: "1.2", seriesInstanceUid: `1.3.${n}`, frameOfReferenceUid: "1.4", specimenUid: "1.5", frames: 3 } };
  }),
}));
vi.mock("../dbEvents", () => ({ emitDbChanged: (d: unknown) => emitted.push(d) }));
vi.mock("../desktopBridge", async (orig) => ({ ...(await orig<typeof import("../desktopBridge")>()), desktop: () => ({}) }));

import { __setMicroscopyConfirm, importMicroscopyVolume } from "./pluginMicroscopyApi";
import type { PluginMicroscopyImportRequest } from "./pluginTypes";

const spec = { width: 2, height: 2, slices: 3, phases: 1, type: "uint8" as const, byteOrder: "little" as const, offset: 0, spacing: [1, 1, 1] as [number, number, number] };
const req = (): PluginMicroscopyImportRequest => ({
  sourceName: "a.lsm",
  sourceFormat: "Zeiss LSM",
  patient: { patientId: "P" },
  channels: [
    { path: "/tmp/graphy-plugin-microscopy/micro/j/ch0.raw", spec, channelName: "Ch1", wavelengthNm: 633 },
    { path: "/tmp/graphy-plugin-microscopy/micro/j/ch1.raw", spec, channelName: "Ch2" },
    { path: "/tmp/graphy-plugin-microscopy/micro/j/ch2.raw", spec, channelName: "Ch3" },
  ],
});
const plugin = { id: "micro", name: "Microscopy import" };

describe("importMicroscopyVolume（H68）", () => {
  beforeEach(() => {
    sent.length = 0;
    emitted.length = 0;
    failAt = -1;
  });
  afterEach(() => __setMicroscopyConfirm(null));

  it("確認を取り消すと何も送らない", async () => {
    __setMicroscopyConfirm(async () => false);
    const r = await importMicroscopyVolume(plugin, req());
    expect(r).toMatchObject({ ok: false, cancelled: true, imported: [] });
    expect(sent).toHaveLength(0);
  });

  it("確認画面にはチャネル名と合計のフレーム数が出る。2 本目からは 1 本目の UID が渡る", async () => {
    const seen: unknown[] = [];
    __setMicroscopyConfirm(async (l) => (seen.push(l), true));
    const r = await importMicroscopyVolume(plugin, req());
    expect(seen[0]).toMatchObject({ pluginName: "Microscopy import", channels: ["Ch1", "Ch2", "Ch3"], frames: 9 });
    expect(r.ok).toBe(true);
    expect(r.imported.map((x) => x.seriesInstanceUid)).toEqual(["1.3.1", "1.3.2", "1.3.3"]);
    expect(sent[0].path).toBe("/api/plugins/micro/microscopy/import");
    expect(sent[0].body.studyInstanceUid).toBeUndefined();
    expect(sent[1].body).toMatchObject({ studyInstanceUid: "1.2", frameOfReferenceUid: "1.4", specimenUid: "1.5", seriesNumber: 2 });
    expect(sent[0].body.wavelengthNm).toBe(633);
    expect(sent[1].body.wavelengthNm).toBeNull();
    expect(emitted.length).toBeGreaterThan(0);
  });

  it("途中で失敗したら残りを止め、取り込めた分を返す", async () => {
    __setMicroscopyConfirm(async () => true);
    failAt = 1;
    const r = await importMicroscopyVolume(plugin, req());
    expect(r).toMatchObject({ ok: false, error: "boom" });
    expect(r.imported).toHaveLength(1);
    expect(sent).toHaveLength(2); // 3 本目は送らない
  });

  it("患者 ID・チャネルが無ければ確認も出さずに断る", async () => {
    const confirm = vi.fn(async () => true);
    __setMicroscopyConfirm(confirm);
    expect((await importMicroscopyVolume(plugin, { ...req(), patient: { patientId: " " } })).ok).toBe(false);
    expect((await importMicroscopyVolume(plugin, { ...req(), channels: [] })).ok).toBe(false);
    expect(confirm).not.toHaveBeenCalled();
  });
});
