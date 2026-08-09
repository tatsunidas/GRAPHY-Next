/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * `regMetrics.ts` のテスト。
 *
 * <p>指標に求める性質を固定する: **正しい対応で最大**になること、
 * MI が**非単調な強度関係でも**それを満たすこと（NCC はそこで失敗すること）、
 * そして値が**滑らかに**変化すること（階段状だと最適化が動かない）。
 */
import { describe, it, expect } from "vitest";
import { mattesMI, normalizedMI, ncc, localNcc, evaluateMetric, type SamplePair } from "./regMetrics";

function pairs(f: number[], m: number[]): SamplePair {
  return { fixed: Float64Array.from(f), moving: Float64Array.from(m), count: f.length };
}

/** 決定的な擬似乱数（テストを実行ごとに揺らさない）。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("regMetrics — NCC", () => {
  it("完全一致で 1、符号反転で −1", () => {
    const f = [1, 2, 3, 4, 5, 6];
    expect(ncc(pairs(f, f))).toBeCloseTo(1, 9);
    expect(ncc(pairs(f, f.map((v) => -v)))).toBeCloseTo(-1, 9);
  });

  it("線形変換に不変（スケールとオフセットに依らない）", () => {
    const f = [10, 20, 35, 40, 55, 60];
    const m = f.map((v) => 3.5 * v - 120);
    expect(ncc(pairs(f, m))).toBeCloseTo(1, 9);
  });

  it("分散 0 や標本不足では 0 を返す（−1 ではない）", () => {
    // −1 を返すと「視野から外れた解」が最悪扱いになり、外れかけた位置で
    // 最適化が止まる。無情報は 0。
    expect(ncc(pairs([1, 1, 1, 1], [1, 2, 3, 4]))).toBe(0);
    expect(ncc(pairs([1], [1]))).toBe(0);
  });
});

describe("regMetrics — Mattes MI", () => {
  it("完全一致のほうが無関係な組より大きい", () => {
    const rnd = mulberry32(1);
    const f: number[] = [];
    for (let n = 0; n < 4000; n++) f.push(rnd() * 100);
    const noise: number[] = [];
    for (let n = 0; n < 4000; n++) noise.push(rnd() * 100);
    expect(mattesMI(pairs(f, f))).toBeGreaterThan(mattesMI(pairs(f, noise)));
  });

  it("★非単調な強度関係でも一致を検出する（NCC は失敗する）", () => {
    // GNBP-2R のマルチモーダル系列と同じ発想: 骨(高)→低、軟部(中)→高。
    const rnd = mulberry32(7);
    const f: number[] = [];
    for (let n = 0; n < 6000; n++) f.push(rnd() * 1000 - 200);
    const nonMonotone = (v: number): number =>
      v < 0 ? 100 : v < 200 ? 1200 : v < 500 ? 300 : 900;
    const m: number[] = f.map(nonMonotone);

    const miAligned = mattesMI(pairs(f, m));
    // 対応をシャッフルした（＝合っていない）組
    const shuffled = [...m];
    for (let n = shuffled.length - 1; n > 0; n--) {
      const j = Math.floor(mulberry32(n + 13)() * (n + 1));
      [shuffled[n], shuffled[j]] = [shuffled[j], shuffled[n]];
    }
    const miShuffled = mattesMI(pairs(f, shuffled));
    expect(miAligned).toBeGreaterThan(miShuffled * 2);

    // NCC はこの関係をほとんど拾えない（だから MI が要る）。
    expect(Math.abs(ncc(pairs(f, m)))).toBeLessThan(Math.abs(miAligned));
  });

  it("平行移動に対して滑らかに減る（階段状でない）", () => {
    // 1 次元の合成信号を少しずつずらして MI を測る。Parzen 窓が効いていれば
    // ずらし量に対して単調かつ滑らかに落ちる。
    const n = 3000;
    const sig = (x: number) => Math.sin(x * 0.05) * 500 + Math.sin(x * 0.011) * 300;
    const f: number[] = [];
    for (let i = 0; i < n; i++) f.push(sig(i));

    const miAt = (shift: number) => {
      const m: number[] = [];
      for (let i = 0; i < n; i++) m.push(sig(i + shift));
      return mattesMI(pairs(f, m));
    };
    const v0 = miAt(0), v1 = miAt(0.5), v2 = miAt(1), v3 = miAt(2);
    expect(v0).toBeGreaterThan(v1);
    expect(v1).toBeGreaterThan(v2);
    expect(v2).toBeGreaterThan(v3);
    // 0 → 0.5 の変化が「階段の 1 段分」ではなく細かく効いていること。
    expect(v0 - v1).toBeGreaterThan(0);
    expect(v0 - v1).toBeLessThan(v0 - v3);
  });

  it("同じ入力なら同じ値（決定的）", () => {
    const rnd = mulberry32(99);
    const f: number[] = [], m: number[] = [];
    for (let n = 0; n < 2000; n++) { f.push(rnd() * 50); m.push(rnd() * 50); }
    expect(mattesMI(pairs(f, m))).toBe(mattesMI(pairs(f, m)));
  });

  it("標本不足では 0", () => {
    expect(mattesMI(pairs([1], [1]))).toBe(0);
  });
});

describe("regMetrics — evaluateMetric", () => {
  it("どちらの指標も「大きいほど良い」に揃っている", () => {
    const f = [1, 2, 3, 4, 5, 6, 7, 8];
    const good = f.map((v) => v * 2);
    const bad = [5, 1, 8, 2, 7, 3, 6, 4];
    expect(evaluateMetric("ncc", pairs(f, good))).toBeGreaterThan(evaluateMetric("ncc", pairs(f, bad)));
    expect(evaluateMetric("mi", pairs(f, good))).toBeGreaterThanOrEqual(evaluateMetric("mi", pairs(f, bad)));
  });
});

describe("regMetrics — 局所 NCC（LNCC）", () => {
  /** パッチ構造を持つ標本を作る。 */
  function patches(f: number[][], m: number[][]): SamplePair {
    const patch = f[0].length;
    return {
      fixed: Float64Array.from(f.flat()),
      moving: Float64Array.from(m.flat()),
      count: f.length * patch,
      patchSize: patch,
    };
  }

  it("★空間的に変化する利得（バイアス場）に強い — 大域 NCC は落ちる", () => {
    // 各パッチ内では構造が同じで、パッチごとに**利得と下駄が違う**状況。
    // MR の表面コイル、造影の有無、PET の集積差がこの形になる。
    const structure = [10, 40, 25, 60, 15];
    const f: number[][] = [], m: number[][] = [];
    for (let p = 0; p < 8; p++) {
      const gain = 1 + p * 0.6;      // パッチごとに利得が変わる
      const offset = p * 30;
      f.push(structure);
      m.push(structure.map((v) => v * gain + offset));
    }
    const pairs = patches(f, m);
    // 各パッチの中では完全な線形関係なので LNCC は 1。
    expect(localNcc(pairs)).toBeCloseTo(1, 6);
    // 大域 NCC は「画像全体で単一の線形関係」を仮定するので、ここでは落ちる。
    expect(ncc(pairs)).toBeLessThan(0.9);
  });

  it("分散のないパッチ（空気・一様な組織）は寄与しない", () => {
    const pairs = patches(
      [[5, 5, 5, 5], [1, 2, 3, 4]],
      [[9, 9, 9, 9], [2, 4, 6, 8]],
    );
    // 1 つ目のパッチは相関が定義できない。2 つ目だけで 1 になる。
    expect(localNcc(pairs)).toBeCloseTo(1, 6);
  });

  it("有効なパッチが無ければ 0（無情報）", () => {
    expect(localNcc(patches([[3, 3, 3]], [[7, 7, 7]]))).toBe(0);
  });

  it("patchSize が 1 なら大域 NCC と同じ", () => {
    const f = [1, 2, 3, 4, 5, 6];
    const p: SamplePair = { fixed: Float64Array.from(f), moving: Float64Array.from(f), count: 6, patchSize: 1 };
    expect(localNcc(p)).toBeCloseTo(ncc(p), 9);
  });

  it("evaluateMetric から呼べる", () => {
    const pairs = patches([[1, 2, 3, 4]], [[2, 4, 6, 8]]);
    expect(evaluateMetric("lncc", pairs)).toBeCloseTo(1, 6);
  });
});

describe("regMetrics — NMI", () => {
  it("完全一致のほうが無関係な組より大きい", () => {
    const rnd = mulberry32(3);
    const f: number[] = [];
    for (let n = 0; n < 4000; n++) f.push(rnd() * 100);
    const noise: number[] = [];
    for (let n = 0; n < 4000; n++) noise.push(rnd() * 100);
    expect(normalizedMI(pairs(f, f))).toBeGreaterThan(normalizedMI(pairs(f, noise)));
  });

  it("無関係な組では 1 に近づく（NMI の定義どおり）", () => {
    const rnd = mulberry32(11);
    const f: number[] = [], m: number[] = [];
    for (let n = 0; n < 8000; n++) { f.push(rnd() * 100); m.push(rnd() * 100); }
    const v = normalizedMI(pairs(f, m));
    expect(v).toBeGreaterThan(1);
    expect(v).toBeLessThan(1.35);
  });

  it("★重なりが変わっても MI ほど動かない", () => {
    // 同じ「合い方」のまま、標本の量（＝重なる体積）だけを変える。
    // MI は情報量そのものなので分布が変われば動くが、NMI は同時エントロピーで
    // 割るぶん、重なりの変化に対して安定する。
    const rnd = mulberry32(23);
    const base: number[] = [];
    for (let n = 0; n < 6000; n++) base.push(rnd() * 100);
    const map = (v: number) => v * 0.8 + 15;

    // 「重なりが小さい」= 標本の一部だけを使い、残りは無相関な組で埋める。
    const mixed = (overlap: number) => {
      const f: number[] = [], m: number[] = [];
      const r2 = mulberry32(77);
      for (let n = 0; n < base.length; n++) {
        if (n < base.length * overlap) { f.push(base[n]); m.push(map(base[n])); }
        else { f.push(base[n]); m.push(r2() * 100); }
      }
      return pairs(f, m);
    };
    const miRatio = mattesMI(mixed(1.0)) / mattesMI(mixed(0.5));
    const nmiRatio = normalizedMI(mixed(1.0)) / normalizedMI(mixed(0.5));
    // どちらも「よく合っている方」が大きいが、NMI の方が比が 1 に近い＝振れが小さい。
    expect(miRatio).toBeGreaterThan(1);
    expect(nmiRatio).toBeGreaterThan(1);
    expect(nmiRatio).toBeLessThan(miRatio);
  });

  it("evaluateMetric から呼べる", () => {
    const f = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(evaluateMetric("nmi", pairs(f, f.map((v) => v * 2)))).toBeGreaterThan(1);
  });
});
