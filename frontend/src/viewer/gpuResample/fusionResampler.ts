/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルを CPU でやるか GPU（WebGL2）でやるかを決める。
 *
 * <p>**GPU は「使えて、結果が CPU と一致し、速いと確かめたとき」だけ**。どの段階の失敗も CPU の経路に戻り（理由を記録）、
 * 表示は導入前と同じ結果のまま出る。数値（状態バーの前景値・保存・ROI 統計）は常に CPU。
 *
 * <p>決め方（前景の組＝シリーズ・C・T ごと。裏で進めるので、判定が済むまでは CPU で描き続ける）:
 * 1. 設定 `viewer.fusionResample` が `cpu` → CPU。
 * 2. 描画環境（`renderEnv`）: ソフトウェア描画は CPU（CPU のコードを別の CPU で回すだけ）・WebGL2 なし・
 *    浮動小数点の描画先なし・前景が `MAX_3D_TEXTURE_SIZE` や メモリの上限を超える → CPU。
 * 3. 前景の全スライスを裏で読み（呼び出し側）、アップロードする（確保の失敗は `oom` で CPU）。
 * 4. **カナリア**（その GPU で最初の 1 回）: 合成ボリュームで GPU と CPU を計算し、一致検査器（`resampleParity`）に通らなければ CPU。
 * 5. **時間と一致の比較**（実データの直近の背景スライス）: 一致検査に通り、GPU が速いときだけ GPU。
 */
import { computeFusionPixel, computeFusionSlice, prepareFusionSlice, type BackgroundSliceMeta, type FusionVolume } from "../fusionEngine";
import type { RenderKind } from "../renderEnv";
import type { WorldTransform } from "../regTransform";
import { canaryCases, canaryForeground } from "./canary";
import { GpuResampler, type GpuFailReason, type GpuLike } from "./gpuResampler";
import type { ShaderFault } from "./gpuShader";
import { setFusionEngineInfo, type FusionResampleDecision } from "./fusionResampleStats";
import { writeFusionDecision } from "./fusionResampleReport";
import { boundsForSlice, checkResampleParity } from "./resampleParity";
import { planResample } from "./resamplePlan";

export type FusionEngine = "cpu" | "gpu-webgl2";
export type FusionResampleMode = "auto" | "cpu";

/** CPU にした理由。画面の表示とデバッグ API に出す。 */
export type CpuReason =
  | "setting-cpu"
  | "evaluating"
  | "software"
  | "no-webgl2"
  | "no-float-rt"
  | "too-large"
  | "memory"
  | "unsupported-pixel-type"
  | "oom"
  | "context-lost"
  | "gl-error"
  | "shader-compile"
  | "prefetch-failed"
  | "gpu-busy"
  | "parity-failed"
  | "slower"
  | "dvf"
  | "gpu-failed";

export function parseFusionResampleMode(v: unknown): FusionResampleMode {
  return v === "cpu" ? "cpu" : "auto";
}

/** 描画環境の事実（`RenderEnvSummary` のうち使うもの）。 */
export interface EnvFacts {
  kind: RenderKind;
  webgl2: boolean;
  colorBufferFloat: boolean | null;
  max3dTextureSize: number | null;
}

export interface FusionResampleRequest {
  /** 前景の組（シリーズ・C・T）の識別。変わったらテクスチャを作り直す。 */
  key: string;
  /** 今の背景スライスに要る前景の数枚（CPU の経路と、カーソル値の再計算に使う）。 */
  fgPartial: FusionVolume;
  bg: BackgroundSliceMeta;
  xf: WorldTransform | null;
  /** 校正（SUV）が変わると増える。増えたらスライスごとの slope・intercept だけ作り直す。 */
  slopeKey: number;
  /** 前景の全スライスを裏で読む（GPU 候補のときだけ呼ぶ）。読めなければ null。 */
  prefetchAll: () => Promise<FusionVolume | null>;
  /** 今の校正での全スライス（全部キャッシュにあるときだけ）。slope・intercept の作り直しに使う。 */
  fgFull: () => FusionVolume | null;
  /** 判定が済んだ（描き直すと GPU になりうる）ときに呼ぶ。 */
  onDecision?: () => void;
  /** 前景の全スライスの保存値の合計バイト数の上限（ボリューム構築のメモリ上限）。 */
  memoryLimitBytes: number;
}

export interface FusionResampleResult {
  values: Float32Array;
  engine: FusionEngine;
  reason: CpuReason | null;
  /** GPU で描いたとき: その画素の値を CPU で計算し直す（状態バーの前景値を導入前と同じにするため）。 */
  exactAt?: (col: number, row: number) => number;
}

export interface ResamplerDeps {
  loadEnv: () => Promise<EnvFacts>;
  createGpu: () => GpuLike | { error: GpuFailReason };
  now: () => number;
  /** 計時と描画に使う CPU の実装（既定は computeFusionSlice。テストで時間を進める偽物に差し替える）。 */
  cpu?: (fg: FusionVolume, bg: BackgroundSliceMeta, xf: WorldTransform | null) => Float32Array;
}

/** 1 つの GPU（コンテキスト）を全体で共有する。前景のテクスチャは同時に 1 組だけ。 */
interface Slot {
  gpu: GpuLike | null;
  owner: object | null;
  canary: FusionResampleDecision["canary"];
  createError: GpuFailReason | null;
}
const slot: Slot = { gpu: null, owner: null, canary: null, createError: null };

/** テスト用: 共有の GPU の状態を捨てる。 */
export function _resetFusionResampleSlot(): void {
  slot.gpu?.dispose();
  slot.gpu = null;
  slot.owner = null;
  slot.canary = null;
  slot.createError = null;
}

interface Session {
  key: string;
  phase: "evaluating" | "gpu" | "cpu";
  reason: CpuReason | null;
  full: FusionVolume | null;
  slopeKey: number;
  decision: FusionResampleDecision | null;
}

const median = (a: number[]): number => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];

export class FusionResampleController {
  private mode: FusionResampleMode = "auto";
  private session: Session | null = null;
  private lastReq: FusionResampleRequest | null = null;
  private readonly owner = {};

  constructor(private readonly deps: ResamplerDeps) {}

  private cpuSlice(fg: FusionVolume, bg: BackgroundSliceMeta, xf: WorldTransform | null): Float32Array {
    return (this.deps.cpu ?? computeFusionSlice)(fg, bg, xf);
  }

  setMode(mode: FusionResampleMode): void {
    this.mode = mode;
  }

  /** 画面を閉じるとき。GPU のテクスチャを返す。 */
  release(): void {
    this.dropSession();
  }

  /**
   * いまの背景スライスについて、GPU と CPU を両方計算して一致検査器に通す（実アプリの検査用。判定の記録は変えない）。
   * GPU で描いていない・直近の要求が無い・DVF を含む変換のときは null。
   */
  parityNow(): { pixels: number; valid: number; violations: number; ambiguous: number; maxRatio: number; gpuMs: number; cpuMs: number; finiteGpu: number } | null {
    const s = this.session;
    const req = this.lastReq;
    const gpu = slot.gpu;
    if (!s || !req || s.phase !== "gpu" || !s.full || !gpu || slot.owner !== this.owner || gpu.lost) return null;
    const plan = planResample(s.full, req.bg, req.xf);
    if (plan.stages.length > 0) return null;
    const t0 = this.deps.now();
    const g = gpu.resample(plan, req.bg.cols, req.bg.rows);
    const gpuMs = this.deps.now() - t0;
    if (!g) return null;
    const t1 = this.deps.now();
    this.cpuSlice(req.fgPartial, req.bg, req.xf);
    const cpuMs = this.deps.now() - t1;
    const cpuFull = computeFusionSlice(s.full, req.bg, req.xf);
    const r = checkResampleParity(cpuFull, g, boundsForSlice(s.full, req.bg, req.xf));
    let finiteGpu = 0;
    for (let i = 0; i < g.length; i++) if (Number.isFinite(g[i])) finiteGpu++;
    return { pixels: r.pixels, valid: r.valid, violations: r.violations, ambiguous: r.ambiguous, maxRatio: r.maxRatio, gpuMs, cpuMs, finiteGpu };
  }

  getDecision(): FusionResampleDecision | null {
    return this.session?.decision ?? null;
  }

  compute(req: FusionResampleRequest): FusionResampleResult {
    this.lastReq = req;
    active = this;
    const cpu = (reason: CpuReason): FusionResampleResult => {
      setFusionEngineInfo("cpu", reason, this.session?.decision ?? undefined);
      return { values: this.cpuSlice(req.fgPartial, req.bg, req.xf), engine: "cpu", reason };
    };
    if (this.mode === "cpu") return cpu("setting-cpu");

    let s = this.session;
    if (!s || s.key !== req.key) {
      this.dropSession();
      s = this.session = { key: req.key, phase: "evaluating", reason: "evaluating", full: null, slopeKey: req.slopeKey, decision: null };
      void this.evaluate(s);
    }
    if (s.phase !== "gpu" || !s.full) return cpu(s.reason ?? "evaluating");

    const gpu = slot.gpu;
    if (!gpu || slot.owner !== this.owner || gpu.lost) return this.fail(s, gpu?.lost ? "context-lost" : "gpu-failed", cpu);
    if (req.slopeKey !== s.slopeKey) {
      const v = req.fgFull();
      if (v) {
        gpu.setParams(v);
        s.slopeKey = req.slopeKey;
      }
    }
    const plan = planResample(s.full, req.bg, req.xf);
    if (plan.stages.length > 0) return cpu("dvf"); // DVF を含む変換は CPU（この判定は GPU の採否を変えない）
    const values = gpu.resample(plan, req.bg.cols, req.bg.rows);
    if (!values) return this.fail(s, gpu.lost ? "context-lost" : "gpu-failed", cpu);
    const ctx = prepareFusionSlice(req.fgPartial, req.bg, req.xf);
    setFusionEngineInfo("gpu-webgl2", null, s.decision);
    return {
      values,
      engine: "gpu-webgl2",
      reason: null,
      exactAt: ctx ? (col, row) => computeFusionPixel(ctx, col, row) : undefined,
    };
  }

  private fail(s: Session, reason: CpuReason, cpu: (r: CpuReason) => FusionResampleResult): FusionResampleResult {
    s.phase = "cpu";
    s.reason = reason; // 復帰しても同じ利用中は GPU に戻さない（ちらつき防止）
    return cpu(reason);
  }

  private dropSession(): void {
    if (slot.owner === this.owner) {
      slot.gpu?.release();
      slot.owner = null;
    }
    this.session = null;
  }

  private settle(s: Session, phase: "gpu" | "cpu", reason: CpuReason | null, decision: Partial<FusionResampleDecision>): void {
    if (this.session !== s) return; // 前景が替わった
    s.phase = phase;
    s.reason = reason;
    s.decision = {
      engine: phase === "gpu" ? "gpu-webgl2" : "cpu",
      reason,
      parity: null,
      cpuMs: null,
      gpuMs: null,
      canary: slot.canary,
      ...decision,
    };
    setFusionEngineInfo(s.decision.engine, reason, s.decision);
    writeFusionDecision(s.decision);
    if (phase !== "gpu" && slot.owner === this.owner) {
      slot.gpu?.release();
      slot.owner = null;
    }
    this.lastReq?.onDecision?.();
  }

  private async evaluate(s: Session): Promise<void> {
    const req0 = this.lastReq;
    if (!req0) return;
    try {
      const env = await this.deps.loadEnv();
      if (this.session !== s) return;
      if (env.kind !== "hardware") return this.settle(s, "cpu", "software", {});
      if (!env.webgl2) return this.settle(s, "cpu", "no-webgl2", {});
      if (env.colorBufferFloat === false) return this.settle(s, "cpu", "no-float-rt", {});

      const full = await req0.prefetchAll();
      if (this.session !== s) return;
      if (!full || full.slices.length === 0) return this.settle(s, "cpu", "prefetch-failed", {});
      if (env.max3dTextureSize !== null && (full.cols > env.max3dTextureSize || full.rows > env.max3dTextureSize || full.slices.length > env.max3dTextureSize)) {
        return this.settle(s, "cpu", "too-large", {});
      }
      const bytes = full.slices.length * full.cols * full.rows * (full.slices[0].pixels instanceof Float32Array ? 4 : (full.slices[0].pixels as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 4);
      if (bytes > req0.memoryLimitBytes) return this.settle(s, "cpu", "memory", {});
      if (slot.owner && slot.owner !== this.owner) return this.settle(s, "cpu", "gpu-busy", {});

      if (!slot.gpu && !slot.createError) {
        const g = this.deps.createGpu();
        if ("error" in g) slot.createError = g.error;
        else slot.gpu = g;
      }
      if (!slot.gpu) return this.settle(s, "cpu", (slot.createError ?? "no-webgl2") as CpuReason, {});
      const gpu = slot.gpu;
      slot.owner = this.owner;

      // カナリア（その GPU で最初の 1 回）
      if (!slot.canary) slot.canary = this.runCanary(gpu);
      if (!slot.canary.ok) return this.settle(s, "cpu", "parity-failed", {});

      const up = gpu.upload(full);
      if (!up.ok) return this.settle(s, "cpu", up.reason as CpuReason, {});
      s.full = full;
      const req = this.lastReq ?? req0;
      s.slopeKey = req.slopeKey;
      const v = req.fgFull();
      if (v) gpu.setParams(v); // 校正は今の値で

      // 時間と一致の比較（実データの直近の背景スライス。DVF を含むときは同じ幾何の恒等で比べる）
      const bg = req.bg;
      let xf = req.xf;
      if (planResample(full, bg, xf).stages.length > 0) xf = null;
      const plan = planResample(full, bg, xf);
      const g0 = gpu.resample(plan, bg.cols, bg.rows); // ウォームアップ（シェーダのコンパイルなど）
      if (!g0) return this.settle(s, "cpu", gpu.lost ? "context-lost" : "gpu-failed", {});
      const gpuT: number[] = [];
      const cpuT: number[] = [];
      let gv: Float32Array | null = g0;
      for (let i = 0; i < 3; i++) {
        const t0 = this.deps.now();
        gv = gpu.resample(plan, bg.cols, bg.rows);
        gpuT.push(this.deps.now() - t0);
        if (!gv) return this.settle(s, "cpu", gpu.lost ? "context-lost" : "gpu-failed", {});
        const t1 = this.deps.now();
        this.cpuSlice(req.fgPartial, bg, xf);
        cpuT.push(this.deps.now() - t1);
      }
      const cpuFull = computeFusionSlice(full, bg, xf);
      const parity = checkResampleParity(cpuFull, gv as Float32Array, boundsForSlice(full, bg, xf));
      const info = {
        parity: { pixels: parity.pixels, valid: parity.valid, violations: parity.violations, ambiguous: parity.ambiguous, maxRatio: parity.maxRatio },
        cpuMs: median(cpuT),
        gpuMs: median(gpuT),
      };
      if (parity.violations > 0) return this.settle(s, "cpu", "parity-failed", info);
      if (!(info.gpuMs < info.cpuMs)) return this.settle(s, "cpu", "slower", info);
      this.settle(s, "gpu", null, info);
    } catch {
      this.settle(s, "cpu", "gpu-failed", {});
    }
  }

  /** 合成ボリュームで GPU と CPU を計算して一致検査器に通す。 */
  private runCanary(gpu: GpuLike): NonNullable<FusionResampleDecision["canary"]> {
    const fg = canaryForeground();
    const cases = canaryCases();
    const up = gpu.upload(fg);
    if (!up.ok) return { ok: false, violations: -1, maxRatio: 0, cases: 0 };
    let violations = 0;
    let maxRatio = 0;
    for (const c of cases) {
      const g = gpu.resample(planResample(fg, c.bg, c.xf), c.bg.cols, c.bg.rows);
      if (!g) return { ok: false, violations: -1, maxRatio, cases: cases.length };
      const r = checkResampleParity(computeFusionSlice(fg, c.bg, c.xf), g, boundsForSlice(fg, c.bg, c.xf));
      violations += r.violations;
      maxRatio = Math.max(maxRatio, r.maxRatio);
    }
    return { ok: violations === 0, violations, maxRatio, cases: cases.length };
  }
}

/** 直近に使われた画面のコントローラ（開発の検査用のデバッグ API が触る）。 */
let active: FusionResampleController | null = null;
export function probeFusionParity(): ReturnType<FusionResampleController["parityNow"]> {
  return active ? active.parityNow() : null;
}
/** 開発（dev）ビルドの検査用: 経路の設定を、設定の保存なしで切り替える。 */
export function setFusionResampleModeForDebug(mode: FusionResampleMode): void {
  if (!import.meta.env.DEV) return;
  active?.setMode(mode);
}
/** 開発（dev）ビルドの検査用: 共有の GPU を捨てて、次の利用でカナリアからやり直す。 */
export function resetFusionGpuForDebug(): void {
  if (!import.meta.env.DEV) return;
  _resetFusionResampleSlot();
}

/** 開発（dev）ビルドの検査用: 次に作る GPU のシェーダに誤りを入れる（カナリアが落とすことの確認）。本番では効かない。 */
let devFault: ShaderFault | null = null;
export function setFusionGpuFault(f: ShaderFault | null): void {
  if (!import.meta.env.DEV) return;
  devFault = f;
  slot.gpu?.setFault(f);
}

/** 本番の依存（描画環境の要約・WebGL2 の GPU・performance.now）。 */
export function createDefaultResampler(): FusionResampleController {
  return new FusionResampleController({
    loadEnv: async () => {
      const { loadRenderEnvSummary } = await import("../renderEnvReport");
      const s = await loadRenderEnvSummary();
      return { kind: s.kind, webgl2: s.webgl2, colorBufferFloat: s.colorBufferFloat, max3dTextureSize: s.max3dTextureSize };
    },
    createGpu: () => {
      const g = GpuResampler.create();
      if (!("error" in g)) g.setFault(devFault);
      return g;
    },
    now: () => performance.now(),
  });
}
