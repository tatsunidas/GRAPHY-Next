/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H61（計算機の状態・Colab のランタイムの解放）。確認の画面（ask）は DOM が要るので実機で確かめる。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeStatus, releaseComputeRuntime } from "./pluginComputeApi";
import type { PluginManifest } from "./pluginTypes";

const plugin = { id: "p", name: "P", version: "1", permissions: ["remote-compute"] } as unknown as PluginManifest;
const noPermission = { ...plugin, permissions: [] } as unknown as PluginManifest;

function stubDesktop(allocated: boolean) {
  const release = vi.fn(async () => ({ ok: true, released: true }));
  vi.stubGlobal("window", {
    graphyDesktop: {
      computeEndpointsGet: async () => ({
        available: true,
        problems: [],
        endpoints: [
          { id: "lab", label: "Lab", kind: "jupyter", url: "https://lab.example", hasToken: true, secretKey: "k" },
          {
            id: "colab-t4", label: "Colab T4", kind: "colab", hasToken: true,
            spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" },
            runtime: { allocated, name: "rt", expireTime: "2026-10-03T12:00:00Z" },
          },
        ],
      }),
      computeColabRelease: release,
    },
  });
  return release;
}

afterEach(() => vi.unstubAllGlobals());

describe("H61 compute.status", () => {
  it("shows kind and runtime only — no URL, token key or runtime name", async () => {
    stubDesktop(true);
    const s = await computeStatus(plugin);
    expect(s).toEqual([
      { id: "lab", label: "Lab", kind: "jupyter", runtime: null },
      { id: "colab-t4", label: "Colab T4", kind: "colab", runtime: { allocated: true, accelerator: "T4" } },
    ]);
    expect(JSON.stringify(s)).not.toMatch(/lab\.example|secretKey|"rt"/);
  });

  it("is empty for a plugin without the remote-compute permission", async () => {
    stubDesktop(true);
    expect(await computeStatus(noPermission)).toEqual([]);
  });
});

describe("H61 compute.releaseRuntime", () => {
  it("releases an allocated Colab runtime", async () => {
    const release = stubDesktop(true);
    expect(await releaseComputeRuntime(plugin, "colab-t4")).toEqual({ ok: true, released: true });
    expect(release).toHaveBeenCalledWith("colab-t4");
  });

  it("does nothing when nothing is allocated or the endpoint is not Colab", async () => {
    const release = stubDesktop(false);
    expect(await releaseComputeRuntime(plugin, "colab-t4", { ask: true })).toEqual({ ok: true, released: false });
    expect(await releaseComputeRuntime(plugin, "lab")).toEqual({ ok: true, released: false });
    expect(release).not.toHaveBeenCalled();
  });

  it("refuses without the permission or for an unknown endpoint", async () => {
    const release = stubDesktop(true);
    expect(await releaseComputeRuntime(noPermission, "colab-t4")).toEqual({ ok: false, error: "permission-denied" });
    expect(await releaseComputeRuntime(plugin, "nope")).toEqual({ ok: false, error: "unknown-endpoint" });
    expect(release).not.toHaveBeenCalled();
  });
});
