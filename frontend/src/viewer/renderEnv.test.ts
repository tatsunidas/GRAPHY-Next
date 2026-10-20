/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import {
  classifyRenderer,
  detectHybrid,
  summarize,
  interactionScaleFor,
  interactionScaleForQuality,
  parseRenderQuality,
  type ContextProbe,
} from "./renderEnv";

// 実機（開発機）で UNMASKED_RENDERER_WEBGL から読んだ文字列。
const DEV_MACHINE = "ANGLE (Intel, Mesa Intel(R) Graphics (ARL), OpenGL 4.6)";
const NVIDIA = "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const AMD = "ANGLE (AMD, AMD Radeon RX 6700 XT (0x000073DF) Direct3D11 vs_5_0 ps_5_0, D3D11)";
const SWIFTSHADER = "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)";
const LLVMPIPE = "ANGLE (Mesa, llvmpipe (LLVM 15.0.7, 256 bits), OpenGL 4.5)";
const WARP = "ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)";

describe("classifyRenderer: 正例（hardware）", () => {
  it.each([DEV_MACHINE, NVIDIA, AMD])("%s は hardware", (name) => {
    expect(classifyRenderer(name, { webgl2: "enabled" }).kind).toBe("hardware");
  });
  it("機能状態が無くても、名前がソフトウェアでなければ hardware", () => {
    expect(classifyRenderer(NVIDIA).kind).toBe("hardware");
    expect(classifyRenderer(NVIDIA, null).kind).toBe("hardware");
  });
});

describe("classifyRenderer: 負例（software）", () => {
  it.each([SWIFTSHADER, LLVMPIPE, WARP, "softpipe"])("根拠 a だけ（名前のみ）: %s", (name) => {
    const r = classifyRenderer(name, { webgl2: "enabled" });
    expect(r).toEqual({ kind: "software", evidence: "name" });
  });
  it.each(["unavailable_software", "disabled_software"])("根拠 b だけ（機能状態のみ）: %s", (st) => {
    const r = classifyRenderer(NVIDIA, { webgl2: st });
    expect(r).toEqual({ kind: "software", evidence: "status" });
  });
  it("a と b の両方", () => {
    expect(classifyRenderer(SWIFTSHADER, { webgl2: "unavailable_software" })).toEqual({
      kind: "software",
      evidence: "both",
    });
  });
  it("名前が空でも根拠 b があれば software", () => {
    expect(classifyRenderer("", { webgl2: "disabled_software" }).kind).toBe("software");
  });
  it("大文字小文字を区別しない", () => {
    expect(classifyRenderer("LLVMPIPE (LLVM 15)").kind).toBe("software");
  });
});

describe("classifyRenderer: 名前が空は unknown（hardware にしない）", () => {
  it.each([null, undefined, "", "   "])("%j", (name) => {
    expect(classifyRenderer(name, { webgl2: "enabled" })).toEqual({ kind: "unknown", evidence: "empty-name" });
    expect(classifyRenderer(name).kind).toBe("unknown");
  });
  it("機能状態が enabled でも、名前が無ければ hardware とは言わない", () => {
    expect(classifyRenderer(null, { webgl2: "enabled" }).kind).not.toBe("hardware");
  });
});

describe("detectHybrid", () => {
  const intel = { vendorId: 0x8086, deviceId: 0x5917, active: false };
  const nv = { vendorId: 0x10de, deviceId: 0x2504, active: true };
  it("名前が異なれば hybrid", () => {
    expect(detectHybrid("Intel UHD", "NVIDIA RTX")).toEqual({ hybrid: true, reason: "names-differ" });
  });
  it("名前が同じで GPU が 1 つなら hybrid ではない", () => {
    expect(detectHybrid("Intel UHD", "Intel UHD", [intel])).toEqual({ hybrid: false, reason: "none" });
  });
  it("名前が同じでも OS が 2 種類の GPU を報告すれば hybrid", () => {
    expect(detectHybrid("Intel UHD", "Intel UHD", [intel, nv])).toEqual({ hybrid: true, reason: "multiple-devices" });
  });
  it("同じ GPU が重複して並んでも 1 つと数える", () => {
    expect(detectHybrid("A", "A", [intel, { ...intel }]).hybrid).toBe(false);
  });
  it("片方の名前が空なら名前では比べない", () => {
    expect(detectHybrid("Intel UHD", null).hybrid).toBe(false);
    expect(detectHybrid("", "NVIDIA").hybrid).toBe(false);
  });
  it("GPU 一覧が無い（web 版）でも落ちない", () => {
    expect(detectHybrid("A", "A", null).hybrid).toBe(false);
    expect(detectHybrid("A", "A", undefined).hybrid).toBe(false);
  });
});

describe("summarize", () => {
  const ctx = (renderer: string | null, max3d: number | null): ContextProbe => ({
    renderer,
    vendor: null,
    max3dTextureSize: max3d,
    maxTextureSize: 16384,
    colorBufferFloat: true,
    textureFloatLinear: false,
  });
  const mem = { totalBytes: null, volumeMaxMb: 2048 };

  it("3D が使う側（high-performance）の値を採る", () => {
    const s = summarize({ defaultCtx: ctx("Intel", 2048), highPerformanceCtx: ctx("NVIDIA", 16384) }, null, mem);
    expect(s.renderGpu).toBe("NVIDIA");
    expect(s.defaultGpu).toBe("Intel");
    expect(s.max3dTextureSize).toBe(16384);
    expect(s.hybrid.hybrid).toBe(true);
  });
  it("high-performance が作れなければ既定側へ", () => {
    const s = summarize({ defaultCtx: ctx(NVIDIA, 2048), highPerformanceCtx: null }, null, mem);
    expect(s.max3dTextureSize).toBe(2048);
    expect(s.webgl2).toBe(true);
  });
  it("どちらも作れなければ WebGL2 は不可・種別は unknown・値は null（0 で埋めない）", () => {
    const s = summarize({ defaultCtx: null, highPerformanceCtx: null }, null, mem);
    expect(s.webgl2).toBe(false);
    expect(s.kind).toBe("unknown");
    expect(s.max3dTextureSize).toBeNull();
    expect(s.colorBufferFloat).toBeNull();
  });
  it("GPU メモリは常に null（ブラウザから取得できない）", () => {
    const s = summarize({ defaultCtx: ctx(NVIDIA, 2048), highPerformanceCtx: ctx(NVIDIA, 2048) }, null, mem);
    expect(s.gpuMemoryBytes).toBeNull();
  });
  it("デスクトップの機能状態を種別に反映する", () => {
    const s = summarize(
      { defaultCtx: ctx(NVIDIA, 2048), highPerformanceCtx: ctx(NVIDIA, 2048) },
      { featureStatus: { webgl2: "unavailable_software" }, devices: [] },
      mem,
    );
    expect(s.kind).toBe("software");
    expect(s.evidence).toBe("status");
  });
});

describe("interactionScaleFor（操作中の縮小倍率 = 静止秒 × 目標更新率）", () => {
  it("t·R が 1.5 未満なら 1（縮小しない）", () => {
    expect(interactionScaleFor(10, 30)).toBe(1); // 0.3
    expect(interactionScaleFor(49, 30)).toBe(1); // 1.47
  });
  it("境界: 1.5 ちょうどは縮小する", () => {
    expect(interactionScaleFor(50, 30)).toBeCloseTo(1.5, 10);
  });
  it("t·R をそのまま返す", () => {
    expect(interactionScaleFor(400, 30)).toBeCloseTo(12, 10);
    expect(interactionScaleFor(1000, 60)).toBeCloseTo(60, 10);
  });
  it("400 で頭打ち", () => {
    expect(interactionScaleFor(20000, 30)).toBe(400); // 600
    expect(interactionScaleFor(400 / 30 * 1000, 30)).toBeCloseTo(400, 6);
  });
  it("目標の更新率に追従する（固定の 30 ではない）", () => {
    expect(interactionScaleFor(100, 30)).toBeCloseTo(3, 10);
    expect(interactionScaleFor(100, 60)).toBeCloseTo(6, 10);
  });
  it("負例: 測れていない・不正な値は 1", () => {
    for (const bad of [NaN, 0, -5, Infinity]) expect(interactionScaleFor(bad, 30)).toBe(1);
    expect(interactionScaleFor(100, 0)).toBe(1);
    expect(interactionScaleFor(100, NaN)).toBe(1);
  });
});

describe("interactionScaleForQuality", () => {
  it("auto は interactionScaleFor と同じ", () => {
    expect(interactionScaleForQuality("auto", 400, 30)).toBeCloseTo(12, 10);
  });
  it("full は遅くても常に 1", () => {
    expect(interactionScaleForQuality("full", 400, 30)).toBe(1);
    expect(interactionScaleForQuality("full", 20000, 30)).toBe(1);
  });
});

describe("parseRenderQuality", () => {
  it("full だけが full、それ以外（未設定・不正値）は auto", () => {
    expect(parseRenderQuality("full")).toBe("full");
    expect(parseRenderQuality("auto")).toBe("auto");
    for (const v of [undefined, null, "", "FULL", 1]) expect(parseRenderQuality(v)).toBe("auto");
  });
});
