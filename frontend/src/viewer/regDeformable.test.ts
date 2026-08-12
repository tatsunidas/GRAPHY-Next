/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * `regDeformable.ts` のテスト。
 *
 * <p>合成ボリュームに**既知の変形**を入れて、それを取り戻せるかを見る。
 * 実データ相当の検証は `bench/` の GNBP-2R-deform（解析的な真値つき）で行う。
 * こちらはブラウザも DICOM も無しで回る速い網で、向き・折り返しの検出・
 * 中止のような壊れ方の分かりやすい性質を固定するためのもの。
 */
import { describe, it, expect } from "vitest";
import { makeVolume, type RegVolume } from "./regGeometry";
import { registerDeformable } from "./regDeformable";
import { applyTransform, type Vec3 } from "./regTransform";

const N = 40;
const SPACING = 2; // mm（80mm 立方）
const HALF = ((N - 1) / 2) * SPACING;

/**
 * 合成ボリューム。`warp` は **world 点 → 内容を読む world 点**（つまり逆写像）。
 * 部分体積を作るためスーパーサンプリングする（`regCore.test.ts` と同じ理由:
 * 二値で焼き込むとデータ上の真値が定義できない）。
 */
function phantom(warp?: (p: Vec3) => Vec3): RegVolume {
  const ss = 2;
  const data = new Float32Array(N * N * N);
  const offs: number[] = [];
  for (let t = 0; t < ss; t++) offs.push(((t - (ss - 1) / 2) / ss) * SPACING);

  const valueAt = (wx: number, wy: number, wz: number): number => {
    let x = wx, y = wy, z = wz;
    if (warp) { const q = warp([wx, wy, wz]); x = q[0]; y = q[1]; z = q[2]; }
    const e = (x / 32) ** 2 + (y / 24) ** 2 + (z / 28) ** 2;
    let v = -1000;
    if (e < 1) v = 40;
    if (e > 0.7 && e < 1) v = 900;
    if (Math.hypot(x - 14, y - 6, z + 9) < 7) v = 300;
    if (Math.hypot(x + 12, y + 12, z - 10) < 6) v = 600;
    if (Math.hypot(x, y + 14, z + 12) < 5) v = 450;
    return v;
  };

  let o = 0;
  for (let k = 0; k < N; k++) {
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        let acc = 0;
        for (const oz of offs) for (const oy of offs) for (const ox of offs) {
          acc += valueAt(-HALF + i * SPACING + ox, -HALF + j * SPACING + oy, -HALF + k * SPACING + oz);
        }
        data[o++] = acc / (ss * ss * ss);
      }
    }
  }
  return makeVolume(data, [N, N, N], [1, 0, 0, 0, 1, 0], [-HALF, -HALF, -HALF], SPACING, SPACING, [0, 0, SPACING]);
}

/** 既知の滑らかな変形（GNBP-2R と同じ形。真値が閉形式で分かる）。 */
const K = (2 * Math.PI) / 90;
const AMP: Vec3 = [5, 4, 6];
function trueDisplacement(p: Vec3): Vec3 {
  return [
    AMP[0] * Math.sin(K * p[1]) * Math.cos(K * p[2]),
    AMP[1] * Math.sin(K * p[2]) * Math.cos(K * p[0]),
    AMP[2] * Math.sin(K * p[0]) * Math.cos(K * p[1]),
  ];
}
/** moving を作るための逆写像（不動点反復）。 */
function inverseWarp(q: Vec3): Vec3 {
  let r: Vec3 = [q[0], q[1], q[2]];
  for (let n = 0; n < 25; n++) {
    const u = trueDisplacement(r);
    r = [q[0] - u[0], q[1] - u[1], q[2] - u[2]];
  }
  return r;
}

const OPTS = {
  // 粗→細の 2 段（既定と同じ考え方。テストは小さいファントムなので値を明示する）
  controlSpacingsMm: [20, 10],
  descriptorSpacingMm: 2,
  maxDisplacementMm: 8,
  displacementStepMm: 1,
  iterations: 2,
};

describe("regDeformable — 既知の変形を取り戻せる", () => {
  const fixed = phantom();
  const moving = phantom(inverseWarp);

  it("★推定した変位場が真値に近づく（未位置合わせより誤差が小さい）", () => {
    const r = registerDeformable(fixed, moving, null, OPTS);

    // 体の内側の格子点で、推定変位と真値変位を比べる。
    let sumEst = 0, sumZero = 0, n = 0;
    for (let z = -20; z <= 20; z += 10) {
      for (let y = -16; y <= 16; y += 8) {
        for (let x = -20; x <= 20; x += 10) {
          const p: Vec3 = [x, y, z];
          const truth = trueDisplacement(p);
          const est = applyTransform(r.transform, p);
          const ex = est[0] - p[0], ey = est[1] - p[1], ez = est[2] - p[2];
          sumEst += (ex - truth[0]) ** 2 + (ey - truth[1]) ** 2 + (ez - truth[2]) ** 2;
          sumZero += truth[0] ** 2 + truth[1] ** 2 + truth[2] ** 2;
          n++;
        }
      }
    }
    const rmseEst = Math.sqrt(sumEst / n);
    const rmseZero = Math.sqrt(sumZero / n);
    // 何もしないより明確に良いこと。合成ファントム（体の外まで含む格子）での実測は
    // おおよそ 0.6 倍。閾値は実測に少し余裕を持たせた値にしてある。
    expect(rmseEst).toBeLessThan(rmseZero * 0.7);
  });

  it("★折り返さない（Jacobian 負値率が 0）", () => {
    // 負値は物理的にありえない。設計 §9.4 で「0 でなければ不合格」としている。
    const r = registerDeformable(fixed, moving, null, OPTS);
    expect(r.jacobian.negativeFraction).toBe(0);
    expect(r.jacobian.min).toBeGreaterThan(0);
  });

  it("変位が探索範囲の合計を超えない", () => {
    const r = registerDeformable(fixed, moving, null, OPTS);
    // **多段なので上限は 1 段分ではなく段の合計**。粗い段が maxDisplacementMm、
    // 細かい段はその半分（残差のみを追うため）。
    const perLevel = [OPTS.maxDisplacementMm, Math.max(OPTS.displacementStepMm * 2, OPTS.maxDisplacementMm / 2)];
    const limit = perLevel.reduce((a, b) => a + b, 0);
    expect(r.maxDisplacementMm).toBeLessThanOrEqual(limit + 1e-6);
  });
});

describe("regDeformable — 契約", () => {
  const fixed = phantom();

  it("同一ボリュームどうしなら変位はほぼ 0", () => {
    const r = registerDeformable(fixed, phantom(), null, OPTS);
    // 制御点の一部に残る 1〜2mm は、放物線サブボクセルが局所的な自己相似性の
    // 非対称性を拾うためで、2 段ぶん積み上がった値。中央値は 0.5mm 程度。
    expect(r.maxDisplacementMm).toBeLessThan(2.5);
    expect(r.jacobian.negativeFraction).toBe(0);
  });

  it("同じ入力なら同じ結果（決定的・乱数を使わない）", () => {
    const moving = phantom(inverseWarp);
    const a = registerDeformable(fixed, moving, null, OPTS);
    const b = registerDeformable(fixed, moving, null, OPTS);
    expect(Array.from(a.transform.displacements)).toEqual(Array.from(b.transform.displacements));
  });

  it("中止要求で止まる", () => {
    const moving = phantom(inverseWarp);
    let calls = 0;
    const r = registerDeformable(fixed, moving, null, { ...OPTS, shouldAbort: () => ++calls > 1 });
    expect(r.aborted).toBe(true);
    expect(r.maxDisplacementMm).toBe(0);
  });

  it("進捗が 0..1 で単調に増える", () => {
    const moving = phantom(inverseWarp);
    const seen: number[] = [];
    registerDeformable(fixed, moving, null, { ...OPTS, onProgress: (f) => seen.push(f) });
    expect(seen.length).toBeGreaterThan(3);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1]);
    expect(seen[seen.length - 1]).toBe(1);
  });
});
