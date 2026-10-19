/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, expect, it } from "vitest";
import { makeVolume } from "./regGeometry";
import { registerRigid } from "./regCore";
import { mat4FromEulerDeg } from "./regTransform";
import {
  accepted,
  buildAlignRequest,
  cropToNormalRange,
  moveFromRegistration,
  overlapCrops,
  overlapNcc,
} from "./stitchAutoAlign";
import { applyMove, placeInput, placementFromRigid, volumeCenter } from "./stitchAlign";
import type { StitchInput } from "./volumeStitch";

// 決定的な疑似乱数（mulberry32）
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const blobs = (() => {
  const r = rng(7);
  return Array.from({ length: 40 }, () => ({
    c: [8 + r() * 56, 8 + r() * 56, 24 + r() * 30] as [number, number, number],
    a: 300 + r() * 700,
    s: 4 + r() * 3,
  }));
})();
const field = (x: number, y: number, z: number) =>
  blobs.reduce((acc, b) => acc + b.a * Math.exp(-((x - b.c[0]) ** 2 + (y - b.c[1]) ** 2 + (z - b.c[2]) ** 2) / (2 * b.s * b.s)), 0);

/** 原点 z0、内容は `content(P)`（world → 値）。 */
function makeIn(z0: number, content: (x: number, y: number, z: number) => number): StitchInput {
  const nx = 36, ny = 36, nz = 14;
  const data = new Float32Array(nx * ny * nz);
  const vol = makeVolume(data, [nx, ny, nz], [1, 0, 0, 0, 1, 0], [0, 0, z0], 2, 2, [0, 0, 2]);
  const m = vol.indexToWorld;
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++)
        data[k * nx * ny + j * nx + i] = content(m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]);
  return { volume: vol, iop: [1, 0, 0, 0, 1, 0], modality: "CT", patientId: "P1" };
}

/** world 点に 4×4 を掛ける。 */
const mul = (m: ArrayLike<number>, p: readonly number[]): number[] => [
  m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3],
  m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7],
  m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11],
];

/** 内容が `err`（world 上の剛体 [R|t]）だけ動いた状態の B。g(P) = field(err⁻¹ P)。 */
function misplaced(z0: number, R: Float64Array, t: [number, number, number], pivot: number[]) {
  // err(P) = pivot + R(P − pivot) + t なので err⁻¹(Q) = pivot + Rᵀ(Q − pivot − t)
  return makeIn(z0, (x, y, z) => {
    const d = [x - pivot[0] - t[0], y - pivot[1] - t[1], z - pivot[2] - t[2]];
    return field(
      pivot[0] + R[0] * d[0] + R[4] * d[1] + R[8] * d[2],
      pivot[1] + R[1] * d[0] + R[5] * d[1] + R[9] * d[2],
      pivot[2] + R[2] * d[0] + R[6] * d[1] + R[10] * d[2],
    );
  });
}

function align(a: StitchInput, b: StitchInput, scope: "translation" | "rigid") {
  const cr = overlapCrops(a, b)!;
  const req = buildAlignRequest(cr.a, cr.b, { scope, sameFrameOfReference: true });
  const res = registerRigid(cr.a.volume, cr.b.volume, {
    metric: "ncc", sameModality: true, sameFrameOfReference: true, limits: req.limits,
  });
  return { cr, res, move: moveFromRegistration(res.transform.matrix)! };
}

describe("切り出しと重なりの NCC", () => {
  const a = makeIn(0, field);
  const b = makeIn(20, field); // a の 20〜26 と重なる（a は 0〜26、b は 20〜46）

  it("重なりに余白を足した範囲だけ切り出す", () => {
    const cr = overlapCrops(a, b)!;
    expect(cr.a.volume.dims[2]).toBeLessThan(a.volume.dims[2]);
    expect(cr.b.volume.dims[2]).toBeLessThan(b.volume.dims[2]);
    // 切り出し後も同じ world の点に同じ値
    const p = cr.b.volume.indexToWorld;
    const w = [p[3], p[7], p[11]];
    const orig = b.volume.worldToIndex;
    const k = orig[8] * w[0] + orig[9] * w[1] + orig[10] * w[2] + orig[11];
    expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-9);
    expect(cr.b.volume.data[0]).toBe(b.volume.data[Math.round(k) * 36 * 36]);
  });

  it("重ならない 2 本は null", () => {
    expect(overlapCrops(a, makeIn(100, field))).toBeNull();
    expect(cropToNormalRange(a, [0, 0, 1], 500, 600)).toBeNull();
  });

  it("正しい配置では NCC がほぼ 1、ずれると下がる（正例と負例）", () => {
    const good = overlapNcc(a, b)!;
    expect(good.ncc).toBeGreaterThan(0.999);
    const bad = overlapNcc(a, placeInput(b, { tx: 6, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, sx: 1, sy: 1, sz: 1, flipX: false, flipY: false, flipZ: false }))!;
    expect(bad.ncc).toBeLessThan(good.ncc - 0.05);
  });

  it("重なる点が少なすぎれば判定しない", () => {
    expect(overlapNcc(a, makeIn(100, field))).toBeNull();
  });
});

describe("自動の位置合わせ（既知のずれの復元）", () => {
  const a = makeIn(0, field);
  const I = mat4FromEulerDeg(0, 0, 0);
  const pivot = [36, 36, 33];

  it("平行移動のずれ (3, −2, 1.5) mm を、逆向きの移動として復元する", () => {
    const b = misplaced(20, I, [3, -2, 1.5], pivot);
    const before = overlapNcc(a, b)!.ncc;
    const { move } = align(a, b, "translation");
    // 移動を適用した B は、元の位置（内容 = field）に戻る
    const fixed = applyMove(b, move);
    const after = overlapNcc(a, fixed)!.ncc;
    expect(after).toBeGreaterThan(before + 0.05);
    for (const p of [[20, 20, 30], [40, 30, 36], [30, 45, 40]]) {
      const moved = mul(move, mul([1, 0, 0, 3, 0, 1, 0, -2, 0, 0, 1, 1.5], p));
      expect(Math.hypot(moved[0] - p[0], moved[1] - p[1], moved[2] - p[2])).toBeLessThan(0.8);
    }
  });

  it("回転 2°＋平行移動のずれも、剛体で復元する", () => {
    const R = mat4FromEulerDeg(0, 0, 2);
    const t: [number, number, number] = [2, 1, -1];
    const b = misplaced(20, R, t, pivot);
    const before = overlapNcc(a, b)!.ncc;
    const { move } = align(a, b, "rigid");
    const aft = overlapNcc(a, applyMove(b, move))!;
    expect(aft.ncc).toBeGreaterThan(before + 0.03);
    expect(accepted(before, aft.ncc, aft.count)).toBe(true);
    // 内容の点 p は err(p) にある。move で p に戻る
    const err = (p: number[]) => {
      const d = [p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]];
      return [0, 1, 2].map((r) => pivot[r] + R[r * 4] * d[0] + R[r * 4 + 1] * d[1] + R[r * 4 + 2] * d[2] + t[r]);
    };
    for (const p of [[20, 20, 30], [40, 30, 36], [30, 45, 40]]) {
      const moved = mul(move, err(p));
      expect(Math.hypot(moved[0] - p[0], moved[1] - p[1], moved[2] - p[2])).toBeLessThan(1.2);
    }
  });

  it("「平行移動のみ」では回転しない", () => {
    const b = misplaced(20, mat4FromEulerDeg(0, 0, 2), [2, 1, -1], pivot);
    const { move } = align(a, b, "translation");
    expect(Math.abs(move[1])).toBeLessThan(1e-9);
    expect(Math.abs(move[4])).toBeLessThan(1e-9);
    expect(Math.abs(move[0] - 1)).toBeLessThan(1e-9);
  });

  it("分解して欄の値にしても同じ移動になる（体積中心まわり）", () => {
    const b = misplaced(20, mat4FromEulerDeg(0, 0, 2), [2, 1, -1], pivot);
    const { move } = align(a, b, "rigid");
    const c = volumeCenter(b);
    const p = placementFromRigid(move, c);
    const direct = applyMove(b, move);
    const viaPlacement = placeInput(b, p);
    for (let n = 0; n < 12; n++) expect(Math.abs(direct.volume.indexToWorld[n] - viaPlacement.volume.indexToWorld[n])).toBeLessThan(1e-6);
  });

  it("無関係な内容どうしでは NCC が上がらず、適用しない（負例）", () => {
    const r = rng(99);
    const noise = makeIn(20, () => r() * 1000);
    const before = overlapNcc(a, noise)!;
    const { move } = align(a, noise, "rigid");
    const after = overlapNcc(a, applyMove(noise, move))!;
    expect(accepted(before.ncc, after.ncc, after.count)).toBe(false);
  });
});
