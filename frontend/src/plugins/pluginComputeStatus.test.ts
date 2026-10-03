/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H61（計算機の状態・Colab のランタイムの解放）。確認の画面（ask）は DOM が要るので実機で確かめる。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { computeStatus, defaultEndpoint, releaseComputeRuntime, runComputeJob } from "./pluginComputeApi";
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

describe("既定の計算機（Colab の GPU T4）", () => {
  const t4 = { id: "colab-t4", kind: "colab" as const, hasToken: true, spec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" } };
  const cpu = { id: "colab-cpu", kind: "colab" as const, hasToken: true, spec: { variant: "VARIANT_CPU", accelerator: "NONE", shape: "SHAPE_STANDARD" } };
  const lab = { id: "lab", kind: "jupyter" as const, hasToken: true };
  const labNoToken = { id: "lab0", kind: "jupyter" as const, hasToken: false };

  it("prefers the Colab T4, then the first with a token, then the first", () => {
    expect(defaultEndpoint([labNoToken, lab, cpu, t4])?.id).toBe("colab-t4");
    expect(defaultEndpoint([labNoToken, lab, cpu])?.id).toBe("lab");
    expect(defaultEndpoint([labNoToken])?.id).toBe("lab0");
    // ログアウト中の T4 は既定にしない（トークンの入った Jupyter があればそちら）
    expect(defaultEndpoint([{ ...t4, hasToken: false }, lab])?.id).toBe("lab");
  });

  it("asks main to add the default when nothing is registered, and reports why it could not", async () => {
    const ensure = vi.fn(async () => ({ ok: false as const, error: "colab-signin-required" }));
    vi.stubGlobal("window", {
      graphyDesktop: {
        computeConfirm: vi.fn(),
        computeEndpointsGet: async () => ({ available: true, problems: [], endpoints: [] }),
        computeEnsureDefault: ensure,
      },
    });
    const r = await runComputeJob(plugin, { script: "print(1)", inputs: [] });
    expect(r).toEqual({ ok: false, error: "colab-signin-required" });
    expect(ensure).toHaveBeenCalledTimes(1);
  });

  it("does not add anything when the plugin names an endpoint", async () => {
    const ensure = vi.fn();
    vi.stubGlobal("window", {
      graphyDesktop: {
        computeConfirm: vi.fn(),
        computeEndpointsGet: async () => ({ available: true, problems: [], endpoints: [] }),
        computeEnsureDefault: ensure,
      },
    });
    expect(await runComputeJob(plugin, { script: "print(1)", inputs: [], endpointId: "x" })).toEqual({ ok: false, error: "unknown-endpoint" });
    expect(ensure).not.toHaveBeenCalled();
  });
});
