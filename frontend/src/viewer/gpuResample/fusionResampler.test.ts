/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { afterEach, describe, expect, it } from "vitest";
import { computeFusionPixel, computeFusionSlice, fusionInterpolate, prepareFusionSlice, type FusionVolume } from "../fusionEngine";
import {
  _resetFusionResampleSlot, FusionResampleController, type EnvFacts, type FusionResampleRequest, type ResamplerDeps,
} from "./fusionResampler";
import type { GpuFailReason, GpuLike, UploadResult } from "./gpuResampler";
import { evaluatePlan, type ResamplePlan } from "./resamplePlan";
import { fusionFixtureTransforms, makeFusionFixtureBg, makeFusionFixtureFg } from "./parityFixtures.testutil";

const ENV: EnvFacts = { kind: "hardware", webgl2: true, colorBufferFloat: true, max3dTextureSize: 2048 };
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/**
 * 偽の GPU。アップロードされた前景から、計画（float64）で (u, v, w_mm) を求めて CPU の補間（fusionInterpolate）で値を出す
 * ＝「正しく動く GPU」。fault で、壊れた GPU（座標のずれ・値の改ざん）を作る。時間は共有の時計を進める。
 */
class FakeGpu implements GpuLike {
  lost = false;
  vol: FusionVolume | null = null;
  uploads = 0;
  paramSets = 0;
  resamples = 0;
  released = 0;
  upload_result: UploadResult = { ok: true };
  /** その前景（寸法）のときだけ誤る。canary を通して実データでだけ誤る GPU を作る。 */
  faultFor: ((vol: FusionVolume) => boolean) | null = null;
  fault: "shift" | "bias" | null = null;
  constructor(private clock: { t: number }, public costMs: number) {}
  upload(vol: FusionVolume): UploadResult {
    this.uploads++;
    if (!this.upload_result.ok) return this.upload_result;
    this.vol = vol;
    return { ok: true };
  }
  setParams(vol: FusionVolume): void { this.paramSets++; this.vol = vol; }
  resample(plan: ResamplePlan, cols: number, rows: number): Float32Array | null {
    this.resamples++;
    this.clock.t += this.costMs;
    const vol = this.vol!;
    const wPos = prepareFusionSlice(vol, { iop: vol.iop, ipp: [0, 0, 0], pixelSpacingCol: 1, pixelSpacingRow: 1, cols: 1, rows: 1 }, null)!.wPos;
    const bad = this.fault !== null && (!this.faultFor || this.faultFor(vol));
    const out = new Float32Array(cols * rows);
    for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) {
      const p = evaluatePlan(plan, bx, by);
      const shift = bad && this.fault === "shift" ? 0.5 : 0;
      const v = fusionInterpolate(vol, wPos, p[0] + shift, p[1] + shift, p[2]);
      out[by * cols + bx] = bad && this.fault === "bias" ? v * 1.01 + 1 : v;
    }
    return out;
  }
  setFault(): void { /* 不使用 */ }
  release(): void { this.released++; }
  dispose(): void { /* 不使用 */ }
}

interface Rig {
  clock: { t: number };
  gpu: FakeGpu;
  ctl: FusionResampleController;
  req: (over?: Partial<FusionResampleRequest>) => FusionResampleRequest;
  created: () => number;
  decisions: () => number;
}

function rig(o: { env?: Partial<EnvFacts>; gpuCost?: number; cpuCost?: number; createError?: GpuFailReason; prefetch?: "ok" | "null" } = {}): Rig {
  _resetFusionResampleSlot();
  const clock = { t: 0 };
  const gpu = new FakeGpu(clock, o.gpuCost ?? 1);
  let created = 0;
  let decided = 0;
  const deps: ResamplerDeps = {
    loadEnv: async () => ({ ...ENV, ...o.env }),
    createGpu: () => { created++; return o.createError ? { error: o.createError } : gpu; },
    now: () => clock.t,
    cpu: (fg, bg, xf) => { clock.t += o.cpuCost ?? 10; return computeFusionSlice(fg, bg, xf); },
  };
  const ctl = new FusionResampleController(deps);
  const fg = makeFusionFixtureFg();
  return {
    clock, gpu, ctl, created: () => created, decisions: () => decided,
    req: (over = {}) => ({
      key: "series-A", fgPartial: fg, bg: makeFusionFixtureBg(0), xf: null, slopeKey: 0,
      prefetchAll: async () => (o.prefetch === "null" ? null : fg), fgFull: () => fg,
      onDecision: () => { decided++; }, memoryLimitBytes: 1 << 30, ...over,
    }),
  };
}

afterEach(() => _resetFusionResampleSlot());

async function settled(r: Rig, over: Partial<FusionResampleRequest> = {}) {
  r.ctl.compute(r.req(over));
  await tick(); await tick();
  return r.ctl.compute(r.req(over));
}

describe("正例: GPU が使えて、CPU と一致し、速いときだけ GPU", () => {
  it("判定が済むまでは CPU（理由 evaluating）、済んだら GPU。値は CPU と E 以内、カーソル値は CPU の厳密な値", async () => {
    const r = rig();
    const first = r.ctl.compute(r.req());
    expect(first.engine).toBe("cpu");
    expect(first.reason).toBe("evaluating");
    await tick(); await tick();
    expect(r.decisions()).toBe(1);
    const res = r.ctl.compute(r.req());
    expect(res.engine).toBe("gpu-webgl2");
    expect(res.reason).toBeNull();
    const cpu = computeFusionSlice(makeFusionFixtureFg(), makeFusionFixtureBg(0), null);
    expect(res.values.length).toBe(cpu.length);
    let finite = 0;
    for (let i = 0; i < cpu.length; i++) {
      if (Number.isNaN(cpu[i])) expect(Number.isNaN(res.values[i])).toBe(true);
      else { finite++; expect(Math.abs(res.values[i] - cpu[i])).toBeLessThan(1e-3 * Math.max(1, Math.abs(cpu[i]))); }
    }
    expect(finite).toBeGreaterThan(500); // 対象が実在する
    const d = r.ctl.getDecision()!;
    expect(d.engine).toBe("gpu-webgl2");
    expect(d.parity!.violations).toBe(0);
    expect(d.gpuMs!).toBeLessThan(d.cpuMs!);
    expect(d.canary!.ok).toBe(true);
    // カーソル値は CPU で 1 画素を計算し直した値（導入前と同じ）
    const ctx = prepareFusionSlice(makeFusionFixtureFg(), makeFusionFixtureBg(0), null)!;
    const idx = cpu.findIndex((v) => Number.isFinite(v));
    const col = idx % makeFusionFixtureBg(0).cols, row = Math.floor(idx / makeFusionFixtureBg(0).cols);
    expect(Object.is(res.exactAt!(col, row), computeFusionPixel(ctx, col, row))).toBe(true);
  });

  it("校正（slopeKey）が変わったら、スライスごとの slope・intercept だけ作り直す（前景は再アップロードしない）", async () => {
    const r = rig();
    await settled(r);
    const before = { uploads: r.gpu.uploads, params: r.gpu.paramSets };
    r.ctl.compute(r.req({ slopeKey: 1 }));
    expect(r.gpu.uploads).toBe(before.uploads);
    expect(r.gpu.paramSets).toBe(before.params + 1);
  });

  it("前景が替わったら（key）判定をやり直す。カナリアは 1 起動に 1 回", async () => {
    const r = rig();
    await settled(r);
    const canary1 = r.ctl.getDecision()!.canary;
    await settled(r, { key: "series-B" });
    expect(r.ctl.getDecision()!.engine).toBe("gpu-webgl2");
    expect(r.created()).toBe(1); // GPU（コンテキスト）は共有
    expect(r.ctl.getDecision()!.canary).toBe(canary1); // 同じ記録（再実行していない）
  });
});

describe("負例: どの段階の失敗も CPU に戻り、理由が記録される", () => {
  const cases: [string, Parameters<typeof rig>[0], string][] = [
    ["ソフトウェア描画", { env: { kind: "software" } }, "software"],
    ["描画の種別が不明", { env: { kind: "unknown" } }, "software"],
    ["WebGL2 なし", { env: { webgl2: false } }, "no-webgl2"],
    ["浮動小数点の描画先なし", { env: { colorBufferFloat: false } }, "no-float-rt"],
    ["前景が MAX_3D_TEXTURE_SIZE を超える", { env: { max3dTextureSize: 16 } }, "too-large"],
    ["コンテキストを作れない（WebGL2 なし）", { createError: "no-webgl2" }, "no-webgl2"],
    ["コンテキストを作れない（浮動小数点の描画先なし）", { createError: "no-float-rt" }, "no-float-rt"],
    ["前景の全スライスを読めない", { prefetch: "null" }, "prefetch-failed"],
    ["GPU が CPU より遅い", { gpuCost: 50, cpuCost: 10 }, "slower"],
  ];
  for (const [name, opts, reason] of cases) {
    it(`${name} → ${reason}`, async () => {
      const r = rig(opts);
      const res = await settled(r);
      expect(res.engine).toBe("cpu");
      expect(res.reason).toBe(reason);
      expect(r.ctl.getDecision()!.reason).toBe(reason);
      // 表示は CPU の結果のまま（導入前とビット一致）
      const cpu = computeFusionSlice(makeFusionFixtureFg(), makeFusionFixtureBg(0), null);
      expect(res.values.every((v, i) => Object.is(v, cpu[i]))).toBe(true);
    });
  }

  it("メモリの上限を超える → memory", async () => {
    const r = rig();
    const res = await settled(r, { memoryLimitBytes: 100 });
    expect(res.reason).toBe("memory");
  });

  it("アップロードの失敗（OUT_OF_MEMORY・保存値の型が非対応）→ その理由", async () => {
    for (const reason of ["oom", "unsupported-pixel-type"] as const) {
      const r = rig();
      r.gpu.upload_result = { ok: false, reason };
      // カナリアのアップロードも失敗する → canary 失敗として parity-failed になるので、カナリア後だけ失敗させる
      let n = 0;
      const orig = r.gpu.upload.bind(r.gpu);
      r.gpu.upload = (v) => (++n === 1 ? ((r.gpu.upload_result = { ok: true }), orig(v)) : ((r.gpu.upload_result = { ok: false, reason }), orig(v)));
      const res = await settled(r);
      expect(res.reason).toBe(reason);
    }
  });

  it("カナリアで落ちる GPU（座標がずれる）→ parity-failed。違反数と最大 |差|/E を記録し、以後その起動では使わない", async () => {
    const r = rig();
    r.gpu.fault = "shift";
    const res = await settled(r);
    expect(res.reason).toBe("parity-failed");
    const c = r.ctl.getDecision()!.canary!;
    expect(c.ok).toBe(false);
    expect(c.violations).toBeGreaterThan(0);
    expect(c.maxRatio).toBeGreaterThan(1);
    // 別の前景でも、カナリアは再実行せず CPU のまま
    const res2 = await settled(r, { key: "series-B" });
    expect(res2.reason).toBe("parity-failed");
  });

  it("実データでだけ誤る GPU（カナリアは通る）→ 時間と一致の比較で落ちる（parity-failed）", async () => {
    const r = rig();
    r.gpu.fault = "bias";
    // カナリアの前景と実データの前景は別オブジェクト。実データの前景だけ誤らせる
    const real = makeFusionFixtureFg();
    r.gpu.faultFor = (vol) => vol === real;
    const res = await settled(r, { fgPartial: real, prefetchAll: async () => real, fgFull: () => real });
    expect(res.reason).toBe("parity-failed");
    expect(r.ctl.getDecision()!.canary!.ok).toBe(true); // カナリアは通っている
    expect(r.ctl.getDecision()!.parity!.violations).toBeGreaterThan(0);
  });

  it("別の画面が GPU を使っている間は gpu-busy（前景のテクスチャは同時に 1 組）", async () => {
    const r = rig();
    await settled(r);
    const second = new FusionResampleController({ loadEnv: async () => ENV, createGpu: () => r.gpu, now: () => r.clock.t, cpu: (a, b, c) => { r.clock.t += 10; return computeFusionSlice(a, b, c); } });
    const req = r.req({ key: "series-Z" });
    second.compute(req); await tick(); await tick();
    expect(second.compute(req).reason).toBe("gpu-busy");
    r.ctl.release(); // 持ち主が手放せば、次は使える
    const third = await (async () => { second.compute(r.req({ key: "series-Y" })); await tick(); await tick(); return second.compute(r.req({ key: "series-Y" })); })();
    expect(third.engine).toBe("gpu-webgl2");
  });

  it("設定が cpu → setting-cpu（GPU に触らない）", async () => {
    const r = rig();
    r.ctl.setMode("cpu");
    const res = r.ctl.compute(r.req());
    await tick(); await tick();
    expect(res.reason).toBe("setting-cpu");
    expect(r.created()).toBe(0);
  });

  it("DVF を含む変換は、その背景スライスだけ CPU（理由 dvf）。GPU の採否は変えない", async () => {
    const r = rig();
    await settled(r);
    const dvf = fusionFixtureTransforms().find((t) => t.name === "DVF")!.xf;
    const res = r.ctl.compute(r.req({ xf: dvf }));
    expect(res.engine).toBe("cpu");
    expect(res.reason).toBe("dvf");
    expect(r.ctl.compute(r.req()).engine).toBe("gpu-webgl2"); // 変換を戻せば GPU
  });

  it("コンテキストを失ったら CPU（context-lost）。復帰しても同じ利用中は GPU に戻さない（ちらつき防止）", async () => {
    const r = rig();
    await settled(r);
    r.gpu.lost = true;
    expect(r.ctl.compute(r.req()).reason).toBe("context-lost");
    r.gpu.lost = false;
    expect(r.ctl.compute(r.req()).engine).toBe("cpu");
  });
});
