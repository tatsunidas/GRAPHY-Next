// @vitest-environment jsdom
/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// シネマティックのオーバーレイの DOM 煙テスト: パストレーサ（WebGL）は偽物に差し替え、
// 予算 → 格子 → 解像度の行／失敗の案内／再開、を既定のまま通る経路を含めて確かめる。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const create = vi.fn();
vi.mock("../viewer/cinematicPathTracer", () => ({
  createCinematicPathTracer: (...a: unknown[]) => create(...a),
  defaultPathTraceParams: () => ({}),
}));
vi.mock("./measure3d", () => ({ inverseViewProj: () => null }));
// WebGL の無い jsdom では描画環境の検出ができないので、GPU 名だけ差し替える（テストごとに変える）。
vi.mock("../viewer/volumeMemory", async (orig) => ({
  ...(await orig<typeof import("../viewer/volumeMemory")>()),
  getMax3dTextureSize: () => null, // 検出は WebGL が要るので使わない（上限なし）
}));
let rendererName = "Test GPU";
vi.mock("../viewer/renderEnv", async (orig) => ({
  ...(await orig<typeof import("../viewer/renderEnv")>()),
  probeRenderEnv: () => ({ defaultCtx: { renderer: rendererName }, highPerformanceCtx: null }),
}));

import { Viewer3DCinematicOverlay } from "./Viewer3DCinematicOverlay";

const MIB = 1024 * 1024;
const DIMS: [number, number, number] = [64, 64, 40];

function fakeView(): VtkVolumeView {
  const scalars = { getData: () => new Int16Array(DIMS[0] * DIMS[1] * DIMS[2]) };
  const imageData = {
    getDimensions: () => DIMS,
    getSpacing: () => [0.7, 0.7, 0.7],
    getOrigin: () => [0, 0, 0],
    getDirection: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
    getPointData: () => ({ getScalars: () => scalars }),
  };
  const cam = { getPosition: () => [0, 0, 1], getFocalPoint: () => [0, 0, 0], getViewUp: () => [0, 1, 0], getParallelScale: () => 1 };
  return {
    getSceneParts: () => ({ renderer: { getActiveCamera: () => cam }, render: () => undefined, imageData }),
    getLut256: () => new Uint8Array(1024),
  } as unknown as VtkVolumeView;
}

/** 偽のエンジン。テクスチャは要求された寸法で作ったことにする。 */
function fakeEngine(texDims: [number, number, number], over: { lost?: () => boolean } = {}) {
  const lostCbs = new Set<() => void>();
  return {
    getTexInfo: () => ({
      texDims,
      srcDims: DIMS,
      spacingMm: [0, 1, 2].map((i) => (DIMS[i] * 0.7) / texDims[i]),
      textureBytes: texDims[0] * texDims[1] * texDims[2] * 2,
    }),
    isLost: over.lost ?? (() => false),
    onLost: (cb: () => void) => {
      lostCbs.add(cb);
      return () => lostCbs.delete(cb);
    },
    readTexLayer: () => null,
    setSeedOffset: () => undefined,
    setCamera: () => undefined,
    setLut: () => undefined,
    setClip: () => undefined,
    setParams: () => undefined,
    reset: () => undefined,
    renderFrame: () => undefined,
    getFrameCount: () => 0,
    resize: () => undefined,
    setRenderScale: () => undefined,
    getRenderScale: () => 1,
    getInternalSize: () => ({ width: 1, height: 1 }),
    finish: () => undefined,
    isIdle: () => true,
    dispose: () => undefined,
  };
}

let host: HTMLElement;
let root: Root;
const q = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function mount(props: { gpuMemoryMb: number | null }) {
  await act(async () => {
    root.render(
      createElement(
        I18nProvider,
        null,
        createElement(Viewer3DCinematicOverlay, { view: fakeView(), active: true, renderKind: "hardware", quality: "auto", onCancel: () => undefined, ...props }),
      ),
    );
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("graphy.locale", "ja");
  rendererName = "Test GPU";
  create.mockReset();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("Viewer3DCinematicOverlay（煙テスト）", () => {
  it("既定のまま（予算が不明）: 元の解像度で作り、解像度の行が full で出る。失敗の案内は出ない", async () => {
    create.mockImplementation((_c, _i, _g, _p, dims) => ({ ok: true, engine: fakeEngine(dims) }));
    await mount({ gpuMemoryMb: null });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][4]).toEqual(DIMS);
    const row = q("cine2-resolution")!;
    expect(row.getAttribute("data-reason")).toBe("full");
    expect(row.getAttribute("data-tex-dims")).toBe(DIMS.join(","));
    expect(row.getAttribute("data-src-dims")).toBe(DIMS.join(","));
    expect(row.getAttribute("data-budget-source")).toBe("unknown");
    // GPU バイト = テクスチャ（R16F）+ 内部バッファ（2·W·H·16）。jsdom の canvas は 1×1
    expect(row.getAttribute("data-gpu-bytes")).toBe(String(DIMS[0] * DIMS[1] * DIMS[2] * 2 + 2 * 1 * 1 * 16));
    expect(q("cine2-lost")).toBeNull();
    expect(row.textContent).toContain("元の解像度");
  });

  it("設定の GPU メモリが小さいと、間引いて作り、理由（設定の値）と元・間引き後の間隔が出る", async () => {
    create.mockImplementation((_c, _i, _g, _p, dims) => ({ ok: true, engine: fakeEngine(dims) }));
    await mount({ gpuMemoryMb: 0.5 });
    const dims = create.mock.calls[0][4] as [number, number, number];
    expect(dims[0] * dims[1] * dims[2]).toBeLessThan(DIMS[0] * DIMS[1] * DIMS[2]);
    const row = q("cine2-resolution")!;
    expect(row.getAttribute("data-reason")).toBe("budget");
    expect(row.getAttribute("data-budget-source")).toBe("user");
    expect(row.textContent).toContain("間引き");
    expect(row.textContent).toContain("設定の値");
    expect(row.textContent).toContain("0.70");
  });

  it("内蔵 GPU（Intel）で設定が無ければ、予算は共有メモリの見積もり（shared）。この小さいボリュームでは間引かない", async () => {
    rendererName = "ANGLE (Intel, Mesa Intel(R) Graphics (ARL), OpenGL 4.6)";
    create.mockImplementation((_c, _i, _g, _p, dims) => ({ ok: true, engine: fakeEngine(dims) }));
    await mount({ gpuMemoryMb: null });
    const row = q("cine2-resolution")!;
    expect(row.getAttribute("data-budget-source")).toBe("shared");
    expect(row.getAttribute("data-reason")).toBe("full");
  });

  it("テクスチャの確保に失敗（out-of-memory）: 案内が出て、［間引いて再開］で失敗した量の半分以下で作り直す", async () => {
    create.mockImplementationOnce(() => ({ ok: false, reason: "out-of-memory" })).mockImplementation((_c, _i, _g, _p, dims) => ({ ok: true, engine: fakeEngine(dims) }));
    await mount({ gpuMemoryMb: null });
    expect(q("cine2-resolution")).toBeNull();
    const card = q("cine2-lost")!;
    expect(card.getAttribute("data-kind")).toBe("create");
    expect(q("cine2-lost-body")!.textContent).toContain(String(Math.ceil((DIMS[0] * DIMS[1] * DIMS[2] * 2) / MIB)));
    // 失敗した量が記録される（次の自動の予算の根拠）
    expect(JSON.parse(localStorage.getItem("graphy.cinematic.gpuRecord")!)["Test GPU"].failMinBytes).toBe(DIMS[0] * DIMS[1] * DIMS[2] * 2);
    await act(async () => {
      q("cine2-retry-downsampled")!.click();
    });
    expect(create).toHaveBeenCalledTimes(2);
    const dims = create.mock.calls[1][4] as [number, number, number];
    expect(dims[0] * dims[1] * dims[2] * 2).toBeLessThanOrEqual(Math.floor((DIMS[0] * DIMS[1] * DIMS[2] * 2) / 2));
    expect(q("cine2-lost")).toBeNull();
    expect(q("cine2-resolution")!.getAttribute("data-reason")).toBe("budget");
  });

  it("実行中にコンテキストが失われたら、案内（lost）を出す。失わなければ出ない（正例）", async () => {
    let lost = false;
    create.mockImplementation((_c, _i, _g, _p, dims) => ({ ok: true, engine: fakeEngine(dims, { lost: () => lost }) }));
    await mount({ gpuMemoryMb: null });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(q("cine2-lost")).toBeNull();
    lost = true;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
    const card = q("cine2-lost")!;
    expect(card.getAttribute("data-kind")).toBe("lost");
    expect(q("cine2-resolution")).toBeNull();
  });

  it("WebGL2 が使えない（unsupported）: 従来の案内だけで、失敗の案内は出ない", async () => {
    create.mockImplementation(() => ({ ok: false, reason: "unsupported" }));
    await mount({ gpuMemoryMb: null });
    expect(q("cine2-lost")).toBeNull();
    expect(q("cine2-badge")!.textContent).toContain("WebGL2");
  });
});
