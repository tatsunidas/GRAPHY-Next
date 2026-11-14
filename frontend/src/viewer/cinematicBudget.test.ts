/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import {
  axisWeights,
  gpuBudget,
  halfRound,
  halfUlp,
  isSharedMemoryGpu,
  planCinematicGrid,
  resampleSlabs,
  TEXEL_BYTES,
  type Vec3,
} from "./cinematicBudget";

const MIB = 1024 * 1024;

describe("planCinematicGrid", () => {
  const base = { dims: [512, 512, 900] as Vec3, spacingMm: [0.7, 0.7, 0.7] as Vec3, max3d: 2048 };
  it("予算が十分なら間引かない（full）。予算なし（null）でも同じ", () => {
    const a = planCinematicGrid({ ...base, budgetTexels: 512 * 512 * 900 });
    expect(a.dims).toEqual([512, 512, 900]);
    expect(a.reason).toBe("full");
    expect(a.bytes).toBe(512 * 512 * 900 * TEXEL_BYTES);
    expect(planCinematicGrid({ ...base, budgetTexels: null }).dims).toEqual([512, 512, 900]);
  });
  it("予算を 1 テクセル減らすと、結果が予算以下になり reason=budget。間引いた間隔は元より大きい", () => {
    const need = 512 * 512 * 900;
    const a = planCinematicGrid({ ...base, budgetTexels: need - 1 });
    expect(a.reason).toBe("budget");
    expect(a.texels).toBeLessThanOrEqual(need - 1);
    expect(Math.max(...a.spacingMm)).toBeGreaterThan(0.7); // 1 テクセル減らすだけでも、どれかの軸が間引かれる
  });
  it("元が目標間隔より粗い軸は触らない（5 mm スライスの z は残し、面内から削る）", () => {
    const a = planCinematicGrid({ dims: [512, 512, 100], spacingMm: [0.7, 0.7, 5], budgetTexels: 512 * 512 * 100 - 1, max3d: 2048 });
    expect(a.dims[2]).toBe(100);
    expect(a.dims[0]).toBeLessThan(512);
    expect(a.dims[0]).toBe(a.dims[1]);
    expect(a.texels).toBeLessThanOrEqual(512 * 512 * 100 - 1);
  });
  it("予算を増やしても寸法は減らない（単調）", () => {
    let prev = 0;
    for (const f of [0.01, 0.05, 0.1, 0.3, 0.6, 1]) {
      const a = planCinematicGrid({ ...base, budgetTexels: Math.floor(512 * 512 * 900 * f) });
      expect(a.texels).toBeGreaterThanOrEqual(prev);
      expect(a.texels).toBeLessThanOrEqual(Math.floor(512 * 512 * 900 * f));
      prev = a.texels;
    }
  });
  it("3D テクスチャの上限を超えない（max3d）。予算の都合でなければ reason=max3d", () => {
    const a = planCinematicGrid({ dims: [4096, 512, 64], spacingMm: [0.1, 0.1, 0.1], budgetTexels: null, max3d: 2048 });
    expect(Math.max(...a.dims)).toBeLessThanOrEqual(2048);
    expect(a.dims[0]).toBe(2048);
    expect(a.reason).toBe("max3d");
  });
  it("間引いても箱の長さ（mm）は元と同じ", () => {
    const a = planCinematicGrid({ ...base, budgetTexels: 20_000_000 });
    for (let i = 0; i < 3; i++) expect(a.dims[i] * a.spacingMm[i]).toBeCloseTo(base.dims[i] * 0.7, 6);
  });
  it("予算が 0 以下でも落ちず、全軸 1 以上", () => {
    const a = planCinematicGrid({ ...base, budgetTexels: 0 });
    expect(a.dims.every((d) => d >= 1)).toBe(true);
  });
});

describe("gpuBudget", () => {
  const common = { shared: false, appliedVolumeMaxBytes: null, srcBytes: 100 * MIB, srcCopies: 4, vtkBytes: 100 * MIB, internalBytes: 32 * MIB };
  it("user: 設定の MB から vtk の分と内部バッファを引く", () => {
    const b = gpuBudget({ ...common, userMb: 1000 });
    expect(b.source).toBe("user");
    expect(b.textureBytes).toBe(1000 * MIB - 100 * MIB - 32 * MIB);
  });
  it("user が shared より先（内蔵 GPU でも利用者の値を使う）", () => {
    const b = gpuBudget({ ...common, userMb: 1000, shared: true, appliedVolumeMaxBytes: 8000 * MIB });
    expect(b.source).toBe("user");
  });
  it("shared: 本体のボリューム構築の上限から、元のコピー群と内部バッファを引く", () => {
    const b = gpuBudget({ ...common, userMb: null, shared: true, appliedVolumeMaxBytes: 2048 * MIB });
    expect(b.source).toBe("shared");
    expect(b.textureBytes).toBe(2048 * MIB - 400 * MIB - 32 * MIB);
  });
  it("どれも分からなければ unknown（予算なし）。0 で埋めない", () => {
    expect(gpuBudget({ ...common, userMb: null })).toEqual({ textureBytes: null, source: "unknown" });
    expect(gpuBudget({ ...common, userMb: 0 }).source).toBe("unknown");
  });
  it("引いた結果が負なら 0（負の予算にしない）", () => {
    expect(gpuBudget({ ...common, userMb: 50 }).textureBytes).toBe(0);
  });
  it("失敗の記録: 失敗した量の半分（描けた最大があればそれ）に抑える。予算が不明でも記録だけで決まる", () => {
    const rec = { failMinBytes: 800 * MIB };
    expect(gpuBudget({ ...common, userMb: null, record: rec })).toEqual({ textureBytes: 400 * MIB, source: "record" });
    expect(gpuBudget({ ...common, userMb: 4000, record: rec }).textureBytes).toBe(400 * MIB);
    expect(gpuBudget({ ...common, userMb: 4000, record: { failMinBytes: 800 * MIB, okMaxBytes: 600 * MIB } }).textureBytes).toBe(600 * MIB);
    // 記録より予算が小さければ予算のまま
    expect(gpuBudget({ ...common, userMb: 200, record: rec }).textureBytes).toBe(200 * MIB - 100 * MIB - 32 * MIB);
  });
});

describe("isSharedMemoryGpu", () => {
  it("Intel・Apple は内蔵、Arc・NVIDIA・AMD・不明は違う", () => {
    expect(isSharedMemoryGpu("ANGLE (Intel, Mesa Intel(R) Graphics (ARL), OpenGL 4.6)")).toBe(true);
    expect(isSharedMemoryGpu("ANGLE (Apple, Apple M2, OpenGL 4.1)")).toBe(true);
    expect(isSharedMemoryGpu("ANGLE (Intel, Intel(R) Arc(TM) A770 Graphics)")).toBe(false);
    expect(isSharedMemoryGpu("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060)")).toBe(false);
    expect(isSharedMemoryGpu("ANGLE (AMD, Radeon RX 6600)")).toBe(false);
    expect(isSharedMemoryGpu(null)).toBe(false);
  });
});

describe("半精度の丸め（R16F）", () => {
  it("丸め誤差は ulp/2 以下で、[0,1] では LUT の 1 段（1/255）より十分小さい（最大 2^-12）", () => {
    for (let i = 0; i <= 5000; i++) {
      const v = i / 5000;
      expect(Math.abs(v - halfRound(v))).toBeLessThanOrEqual(halfUlp(v) / 2 + 1e-15);
      expect(Math.abs(v - halfRound(v))).toBeLessThanOrEqual(2 ** -12 + 1e-15);
    }
    expect(2 ** -12).toBeLessThan(1 / 255 / 15);
    // 変換が切り捨てでも（実装まかせ。実機の Mesa で観測）、誤差は 1 ulp 以下 = 2^-11 で、LUT の 1 段の 1/7 以下
    for (let i = 0; i <= 5000; i++) {
      const v = i / 5000;
      expect(Math.abs(v - Math.floor(v / halfUlp(v)) * halfUlp(v))).toBeLessThanOrEqual(halfUlp(v) + 1e-15);
    }
    expect(2 ** -11).toBeLessThan(1 / 255 / 7);
  });
  it("既知の値: 0.5 は 0.5、1 は 1、半精度で表せる 0.333251953125 はそのまま", () => {
    expect(halfRound(0.5)).toBe(0.5);
    expect(halfRound(1)).toBe(1);
    expect(halfRound(0.333251953125)).toBe(0.333251953125);
    expect(halfRound(1 / 3)).toBe(0.333251953125);
  });
});

describe("resampleSlabs（箱平均）", () => {
  const brute = (data: number[], dims: Vec3, tdims: Vec3, dmin: number, span: number) => {
    // 別の書き方（面積加重の定義どおり、各目標セルを直接平均）。
    const out = new Float32Array(tdims[0] * tdims[1] * tdims[2]);
    const ov = (k: number, j: number, n: number, t: number) => Math.max(0, Math.min(k + 1, ((j + 1) * n) / t) - Math.max(k, (j * n) / t));
    for (let z = 0; z < tdims[2]; z++)
      for (let y = 0; y < tdims[1]; y++)
        for (let x = 0; x < tdims[0]; x++) {
          let acc = 0, wsum = 0;
          for (let k = 0; k < dims[2]; k++) {
            const wz = ov(k, z, dims[2], tdims[2]);
            if (!wz) continue;
            for (let j = 0; j < dims[1]; j++) {
              const wy = ov(j, y, dims[1], tdims[1]);
              if (!wy) continue;
              for (let i = 0; i < dims[0]; i++) {
                const wx = ov(i, x, dims[0], tdims[0]);
                if (!wx) continue;
                const w = wx * wy * wz;
                acc += w * ((data[(k * dims[1] + j) * dims[0] + i] - dmin) / span);
                wsum += w;
              }
            }
          }
          out[(z * tdims[1] + y) * tdims[0] + x] = acc / wsum;
        }
    return out;
  };
  const run = (data: number[], dims: Vec3, tdims: Vec3, dmin: number, span: number) => {
    const out = new Float32Array(tdims[0] * tdims[1] * tdims[2]);
    const slabs: number[] = [];
    resampleSlabs(data, dims, tdims, dmin, span, (z, slab) => {
      slabs.push(z);
      out.set(slab, z * tdims[0] * tdims[1]);
    });
    expect(slabs).toEqual(Array.from({ length: tdims[2] }, (_, i) => i));
    return out;
  };
  const vol = (dims: Vec3) => Array.from({ length: dims[0] * dims[1] * dims[2] }, (_, i) => ((i * 2654435761) >>> 0) % 1000 - 300);

  it("寸法が同じなら正規化だけ（恒等）", () => {
    const d: Vec3 = [5, 4, 3];
    const data = vol(d);
    const out = run(data, d, d, -300, 1000);
    for (let i = 0; i < data.length; i++) expect(out[i]).toBeCloseTo((data[i] + 300) / 1000, 6);
  });
  it("割り切れない間引き（7×5×9 → 3×2×4）が、定義どおりの面積加重平均と一致する", () => {
    const d: Vec3 = [7, 5, 9];
    const t: Vec3 = [3, 2, 4];
    const data = vol(d);
    const a = run(data, d, t, -300, 1000);
    const b = brute(data, d, t, -300, 1000);
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 5);
  });
  it("2 倍の間引きは 2×2×2 の平均。全体の平均値が保たれる", () => {
    const d: Vec3 = [8, 6, 4];
    const data = vol(d);
    const out = run(data, d, [4, 3, 2], -300, 1000);
    const meanSrc = data.reduce((x, y) => x + (y + 300) / 1000, 0) / data.length;
    const meanOut = Array.from(out).reduce((x, y) => x + y, 0) / out.length;
    expect(meanOut).toBeCloseTo(meanSrc, 5);
    expect(out[0]).toBeCloseTo(([0, 1].flatMap((k) => [0, 1].flatMap((j) => [0, 1].map((i) => data[(k * 6 + j) * 8 + i]))).reduce((x, y) => x + y, 0) / 8 + 300) / 1000, 6);
  });
  it("負例（最近傍に置き換えると）定義どおりの平均と一致しない＝検査が差を拾う", () => {
    const d: Vec3 = [8, 6, 4];
    const data = vol(d);
    const t: Vec3 = [4, 3, 2];
    const nearest = new Float32Array(24);
    for (let z = 0; z < 2; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) nearest[(z * 3 + y) * 4 + x] = (data[((z * 2) * 6 + y * 2) * 8 + x * 2] + 300) / 1000;
    const b = brute(data, d, t, -300, 1000);
    expect(Array.from(nearest).some((v, i) => Math.abs(v - b[i]) > 1e-3)).toBe(true);
  });
  it("axisWeights: 重みの合計は 1、全元セルを覆う", () => {
    const w = axisWeights(7, 3);
    for (const ws of w.weights) expect(ws.reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9);
    expect(w.start[0]).toBe(0);
    expect(w.start[2] + w.weights[2].length).toBe(7);
  });
});
