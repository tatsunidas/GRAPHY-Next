/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * MIND-SSC のテスト。
 *
 * <p>ここで確かめたい性質は 1 つに尽きる: **強度の対応関係が非単調でも、
 * 同じ構造なら記述子が一致すること**。これが成り立つから非剛体を SSD で解ける。
 */
import { describe, it, expect } from "vitest";
import { computeMindSsc, descriptorDistance, MIND_CHANNELS } from "./regDescriptors";

const DIMS = [16, 16, 16] as const;

/** 球と箱を置いた合成ボリューム。 */
function structure(shiftX = 0): Float32Array {
  const [nx, ny, nz] = DIMS;
  const v = new Float32Array(nx * ny * nz);
  let o = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = i - shiftX;
        const r = Math.hypot(x - 8, j - 8, k - 8);
        let val = 0;
        if (r < 5) val = 100;
        if (x > 10 && j > 10) val = 200;
        v[o++] = val;
      }
    }
  }
  return v;
}

/** 非単調な強度写像（GNBP-2R のマルチモーダルと同じ発想）。 */
function nonMonotone(src: Float32Array): Float32Array {
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const v = src[i];
    out[i] = v === 0 ? 500 : v === 100 ? 50 : 900; // 0→500, 100→50, 200→900
  }
  return out;
}

function descAt(_d: Uint8Array, i: number, j: number, k: number): number {
  return ((k * DIMS[1] + j) * DIMS[0] + i) * MIND_CHANNELS;
}

describe("computeMindSsc", () => {
  it("12 チャンネルで、各点の最大値が 255 に正規化される", () => {
    const m = computeMindSsc(structure(), DIMS);
    expect(m.data.length).toBe(DIMS[0] * DIMS[1] * DIMS[2] * MIND_CHANNELS);
    // 構造のある点を見る（平坦な空気ではなく球の縁）
    const base = descAt(m.data, 8, 8, 4);
    let max = 0;
    for (let c = 0; c < MIND_CHANNELS; c++) max = Math.max(max, m.data[base + c]);
    expect(max).toBe(255);
  });

  it("★非単調に強度を写像しても、正しい対応の方が誤対応よりはっきり近い", () => {
    // これが非剛体を SSD で解ける理由。**絶対値ではなく相対**で見るのが本質:
    // 強度写像が変わればコントラスト比も変わるので距離はゼロにはならない。
    // 最適化に必要なのは「正しい位置が最小になる」ことだけである。
    const a = computeMindSsc(structure(), DIMS);
    const b = computeMindSsc(nonMonotone(structure()), DIMS);

    for (const [i, j, k] of [[8, 8, 3], [8, 3, 8], [3, 8, 8], [12, 12, 8]] as const) {
      const o = descAt(a.data, i, j, k);
      const matched = descriptorDistance(a.data, o, b.data, o);
      // 同じ点 vs 構造の違う点（球の中心＝平坦、と外の空気）
      const wrong1 = descriptorDistance(a.data, o, b.data, descAt(b.data, 8, 8, 8));
      const wrong2 = descriptorDistance(a.data, o, b.data, descAt(b.data, 1, 1, 1));
      expect(matched).toBeLessThan(Math.max(wrong1, wrong2));
    }
  });

  it("非単調写像後も、対応点の距離は取りうる最大の 1/4 未満に収まる", () => {
    const a = computeMindSsc(structure(), DIMS);
    const b = computeMindSsc(nonMonotone(structure()), DIMS);
    let worst = 0;
    for (const [i, j, k] of [[8, 8, 3], [8, 3, 8], [3, 8, 8], [12, 12, 8]] as const) {
      const o = descAt(a.data, i, j, k);
      worst = Math.max(worst, descriptorDistance(a.data, o, b.data, o));
    }
    // 最大は 12ch × 255 = 3060。実測 490 程度（16%）。
    // 強度写像でコントラスト比が変わる分は残るので 0 にはならない。
    expect(worst).toBeLessThan(3060 * 0.25);
  });

  it("平坦な領域では全チャンネルが等しくなる（無意味な記述子を作らない）", () => {
    const flat = new Float32Array(DIMS[0] * DIMS[1] * DIMS[2]).fill(42);
    const m = computeMindSsc(flat, DIMS);
    const base = descAt(m.data, 8, 8, 8);
    for (let c = 0; c < MIND_CHANNELS; c++) expect(m.data[base + c]).toBe(255);
  });

  it("同じ構造をずらすと、対応する位置で記述子が一致する", () => {
    const a = computeMindSsc(structure(0), DIMS);
    const b = computeMindSsc(structure(2), DIMS);
    // a の (6,8,8) は b の (8,8,8) に対応する
    const da = descriptorDistance(a.data, descAt(a.data, 6, 8, 8), b.data, descAt(b.data, 8, 8, 8));
    // 対応しない位置より小さいこと
    const db = descriptorDistance(a.data, descAt(a.data, 6, 8, 8), b.data, descAt(b.data, 12, 8, 8));
    expect(da).toBeLessThan(db);
  });

  it("同じ入力なら同じ出力（決定的）", () => {
    const a = computeMindSsc(structure(), DIMS);
    const b = computeMindSsc(structure(), DIMS);
    expect(Array.from(a.data)).toEqual(Array.from(b.data));
  });
});

describe("descriptorDistance", () => {
  it("同一なら 0、最大は 12×255", () => {
    const a = new Uint8Array(MIND_CHANNELS).fill(255);
    const b = new Uint8Array(MIND_CHANNELS).fill(0);
    expect(descriptorDistance(a, 0, a, 0)).toBe(0);
    expect(descriptorDistance(a, 0, b, 0)).toBe(MIND_CHANNELS * 255);
  });
});
