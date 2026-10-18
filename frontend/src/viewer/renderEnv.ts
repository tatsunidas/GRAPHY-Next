/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 描画環境（何の GPU で WebGL2 を描いているか、ソフトウェア描画に落ちていないか）の検出。
// 設計: fw/render-environment-design.md
//
// 純関数（classifyRenderer / detectHybrid / summarize）と、WebGL に触る薄い層（probeRenderEnv）に分ける。
// 判定は純関数に閉じ込めて単体テストし、probe は使い捨てコンテキストを作って読み、すぐ解放するだけにする。

export type RenderKind = "hardware" | "software" | "unknown";

/** 判定の根拠。a=GPU 名がソフトウェア描画の製品名、b=Chromium の機能状態がソフトウェア扱い。 */
export type RenderKindEvidence = "name" | "status" | "both" | "hardware-name" | "empty-name";

export interface RenderKindResult {
  kind: RenderKind;
  evidence: RenderKindEvidence;
}

/** `app.getGPUFeatureStatus()` の値（`{ webgl2: "enabled", ... }`）。 */
export type GpuFeatureStatus = Record<string, string>;

/** ソフトウェア描画の製品名（ANGLE の renderer 文字列に含まれる）。 */
const SOFTWARE_RENDERER_PATTERN = /swiftshader|llvmpipe|softpipe|microsoft basic render driver/i;

/** webgl2 の機能状態のうち、ソフトウェア描画を示すもの。 */
const SOFTWARE_FEATURE_STATUS = new Set(["unavailable_software", "disabled_software"]);

/**
 * 描画の種別を判定する。software になるのは次のどちらか（両方でもよい）。
 * <ul>
 *   <li>a: GPU 名がソフトウェア描画の製品名（SwiftShader・llvmpipe・softpipe・Microsoft Basic Render Driver）に一致</li>
 *   <li>b: `webgl2` の機能状態が `unavailable_software` / `disabled_software`</li>
 * </ul>
 * どちらでもなく GPU 名が空なら unknown（取れていないだけで hardware とは言えない）。
 * それ以外（名前があり、ソフトウェアの根拠が無い）が hardware。
 */
export function classifyRenderer(
  rendererName: string | null | undefined,
  featureStatus?: GpuFeatureStatus | null,
): RenderKindResult {
  const name = (rendererName ?? "").trim();
  const byName = name !== "" && SOFTWARE_RENDERER_PATTERN.test(name);
  const byStatus = SOFTWARE_FEATURE_STATUS.has(featureStatus?.webgl2 ?? "");
  if (byName && byStatus) return { kind: "software", evidence: "both" };
  if (byName) return { kind: "software", evidence: "name" };
  if (byStatus) return { kind: "software", evidence: "status" };
  if (name === "") return { kind: "unknown", evidence: "empty-name" };
  return { kind: "hardware", evidence: "hardware-name" };
}

/** `app.getGPUInfo('basic')` の `gpuDevice` の 1 要素（使うのはこの 3 項目だけ）。 */
export interface GpuDeviceInfo {
  vendorId: number;
  deviceId: number;
  active: boolean;
}

export interface HybridDetection {
  hybrid: boolean;
  reason: "names-differ" | "multiple-devices" | "none";
}

/**
 * ハイブリッド GPU（内蔵＋外付けの併載）か。次のどちらかで true。
 * <ul>
 *   <li>`default` と `high-performance` で GPU 名が（空でなく）異なる</li>
 *   <li>OS が報告した GPU が、ベンダー・デバイスの組として 2 種類以上ある</li>
 * </ul>
 * 名前が片方でも空のときは比較しない（取れていないだけの可能性があるため）。
 */
export function detectHybrid(
  defaultName: string | null | undefined,
  highPerformanceName: string | null | undefined,
  devices?: readonly GpuDeviceInfo[] | null,
): HybridDetection {
  const a = (defaultName ?? "").trim();
  const b = (highPerformanceName ?? "").trim();
  if (a !== "" && b !== "" && a !== b) return { hybrid: true, reason: "names-differ" };
  const distinct = new Set((devices ?? []).map((d) => `${d.vendorId}:${d.deviceId}`));
  if (distinct.size >= 2) return { hybrid: true, reason: "multiple-devices" };
  return { hybrid: false, reason: "none" };
}

/** 1 つの WebGL2 コンテキストから読んだ値。 */
export interface ContextProbe {
  /** `WEBGL_debug_renderer_info` の UNMASKED_RENDERER_WEBGL。拡張が無ければ null。 */
  renderer: string | null;
  vendor: string | null;
  max3dTextureSize: number | null;
  maxTextureSize: number | null;
  colorBufferFloat: boolean;
  textureFloatLinear: boolean;
}

export interface RenderEnvProbe {
  /** `powerPreference: "default"` のコンテキスト。作れなければ null。 */
  defaultCtx: ContextProbe | null;
  /** `powerPreference: "high-performance"` のコンテキスト（3D が使う側）。作れなければ null。 */
  highPerformanceCtx: ContextProbe | null;
}

export interface MemoryFacts {
  /** OS の搭載メモリ（バイト）。取れなければ null（web 版など）。 */
  totalBytes: number | null;
  /** ボリューム構築の上限（MB）。 */
  volumeMaxMb: number;
}

export interface RenderEnvSummary {
  kind: RenderKind;
  evidence: RenderKindEvidence;
  /** 3D が使う側の GPU 名（なければ既定側）。 */
  renderGpu: string | null;
  defaultGpu: string | null;
  webgl2: boolean;
  max3dTextureSize: number | null;
  maxTextureSize: number | null;
  colorBufferFloat: boolean | null;
  textureFloatLinear: boolean | null;
  totalBytes: number | null;
  volumeMaxMb: number;
  /** ブラウザからは取得できない。常に null（推測の値を出さない）。 */
  gpuMemoryBytes: null;
  featureStatus: GpuFeatureStatus | null;
  gpuDevices: GpuDeviceInfo[] | null;
  hybrid: HybridDetection;
}

/** probe・デスクトップの GPU 状態・メモリの事実から、画面とコピー用 JSON の元になる要約を作る。 */
export function summarize(
  probe: RenderEnvProbe,
  gpu: { featureStatus: GpuFeatureStatus; devices: GpuDeviceInfo[] } | null,
  memory: MemoryFacts,
): RenderEnvSummary {
  const used = probe.highPerformanceCtx ?? probe.defaultCtx;
  const { kind, evidence } = classifyRenderer(used?.renderer, gpu?.featureStatus);
  return {
    kind,
    evidence,
    renderGpu: used?.renderer ?? null,
    defaultGpu: probe.defaultCtx?.renderer ?? null,
    webgl2: used !== null,
    max3dTextureSize: used?.max3dTextureSize ?? null,
    maxTextureSize: used?.maxTextureSize ?? null,
    colorBufferFloat: used ? used.colorBufferFloat : null,
    textureFloatLinear: used ? used.textureFloatLinear : null,
    totalBytes: memory.totalBytes,
    volumeMaxMb: memory.volumeMaxMb,
    gpuMemoryBytes: null,
    featureStatus: gpu?.featureStatus ?? null,
    gpuDevices: gpu?.devices ?? null,
    hybrid: detectHybrid(probe.defaultCtx?.renderer, probe.highPerformanceCtx?.renderer, gpu?.devices),
  };
}

// ── WebGL に触る薄い層 ──────────────────────────────────────────────────────

let cachedProbe: RenderEnvProbe | undefined;

/**
 * 使い捨ての WebGL2 コンテキストを `default` と `high-performance` の 2 つ作って読み、1 度だけキャッシュする。
 * WebGL の同時コンテキスト数には上限（多くのブラウザで 16）があるため、読み終えたらすぐ
 * `WEBGL_lose_context` で解放する（作法は `volumeMemory.ts` の `probeMax3dTextureSize` と同じ）。
 * 取れなければ該当側は null。
 */
export function probeRenderEnv(): RenderEnvProbe {
  if (cachedProbe) return cachedProbe;
  cachedProbe = {
    defaultCtx: probeContext("default"),
    highPerformanceCtx: probeContext("high-performance"),
  };
  return cachedProbe;
}

function probeContext(powerPreference: "default" | "high-performance"): ContextProbe | null {
  try {
    if (typeof document === "undefined") return null; // 単体テスト（node 環境）
    const gl = document.createElement("canvas").getContext("webgl2", { powerPreference });
    if (!gl) return null;
    const num = (p: number): number | null => {
      const v = gl.getParameter(p) as unknown;
      return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    };
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const result: ContextProbe = {
      renderer: dbg ? str(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null,
      vendor: dbg ? str(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null,
      max3dTextureSize: num(gl.MAX_3D_TEXTURE_SIZE),
      maxTextureSize: num(gl.MAX_TEXTURE_SIZE),
      colorBufferFloat: gl.getExtension("EXT_color_buffer_float") !== null,
      textureFloatLinear: gl.getExtension("OES_texture_float_linear") !== null,
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return result;
  } catch {
    return null;
  }
}

/** 3D が使う側（high-performance）の MAX_3D_TEXTURE_SIZE。取れなければ既定側、それも無ければ null。 */
export function probeMax3dTextureSizeForRender(): number | null {
  const p = probeRenderEnv();
  return p.highPerformanceCtx?.max3dTextureSize ?? p.defaultCtx?.max3dTextureSize ?? null;
}

// ── 操作中の縮小描画（設計: fw/render-environment-design.md「操作中の縮小描画」）──

/** 3D の画質設定。auto=操作中は縮小描画、full=常に精細。 */
export type RenderQuality = "auto" | "full";

/** vtk.js の OpenGL VolumeMapper が、面積倍率をこの値未満なら全解像度のまま描く（Rendering/OpenGL/VolumeMapper.js）。 */
export const MIN_INTERACTION_SCALE = 1.5;
/** 同じく vtk.js が丸める上限（軸あたり 1/20）。 */
export const MAX_INTERACTION_SCALE = 400;

/**
 * 操作中の面積倍率。静止 1 フレームが stillMs、目標の更新率が rate（回/秒）のとき、
 * 画素数を 1/s にすれば（描画時間が画素数にほぼ比例するなら）1 フレームが 1/rate 秒に収まる。
 * s = (stillMs/1000)·rate。1.5 未満なら縮小しない（1）、400 で頭打ち。
 * 測れていない（NaN・0 以下）ときも 1（今までと同じ）。
 */
export function interactionScaleFor(stillMs: number, rate: number): number {
  if (!Number.isFinite(stillMs) || !Number.isFinite(rate) || stillMs <= 0 || rate <= 0) return 1;
  const s = (stillMs / 1000) * rate;
  if (s < MIN_INTERACTION_SCALE) return 1;
  return Math.min(s, MAX_INTERACTION_SCALE);
}

/** 画質設定を含めた倍率。full は常に 1（縮小しない）。 */
export function interactionScaleForQuality(quality: RenderQuality, stillMs: number, rate: number): number {
  return quality === "full" ? 1 : interactionScaleFor(stillMs, rate);
}

/** 設定値を RenderQuality に直す。auto・full 以外（未設定・不正値）は auto。 */
export function parseRenderQuality(v: unknown): RenderQuality {
  return v === "full" ? "full" : "auto";
}

/** 3D の静止 1 フレームの直近の実測を、別ウィンドウの設定画面へ渡すための localStorage キー。 */
export const STILL_MS_STORAGE_KEY = "graphy.render3d.stillMs";
