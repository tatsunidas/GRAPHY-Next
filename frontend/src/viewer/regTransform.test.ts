/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { describe, it, expect } from "vitest";
import {
  ZERO_ADJUST,
  applyTransform,
  composeTransforms,
  identityTransform,
  isIdentityTransform,
  isZeroAdjust,
  linearTransform,
  manualAdjustToTransform,
  mat4FromEulerDeg,
  mat4Identity,
  mat4InvertAffine,
  mat4Multiply,
  type LinearTransform,
  type ManualAdjust,
  type Vec3,
} from "./regTransform";

/** 手動微調整の「順方向」（moving をどう動かすか）。pull-back の正しさをこれと突き合わせる。 */
function forwardManual(a: ManualAdjust, center: Vec3, p: Vec3): Vec3 {
  const R = mat4FromEulerDeg(a.rx, a.ry, a.rz);
  const d: Vec3 = [p[0] - center[0], p[1] - center[1], p[2] - center[2]];
  return [
    center[0] + R[0] * d[0] + R[1] * d[1] + R[2] * d[2] + a.tx,
    center[1] + R[4] * d[0] + R[5] * d[1] + R[6] * d[2] + a.ty,
    center[2] + R[8] * d[0] + R[9] * d[1] + R[10] * d[2] + a.tz,
  ];
}

function expectVecClose(actual: Vec3, expected: Vec3, digits = 9) {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

describe("mat4 ユーティリティ", () => {
  it("単位行列との積は元の行列", () => {
    const m = mat4FromEulerDeg(11, -23, 47);
    m[3] = 5; m[7] = -6; m[11] = 7;
    const r = mat4Multiply(m, mat4Identity());
    for (let i = 0; i < 16; i++) expect(r[i]).toBeCloseTo(m[i], 12);
  });

  it("アフィン逆行列は M·M⁻¹ = I を満たす", () => {
    const m = mat4FromEulerDeg(17, 33, -5);
    m[3] = 12.5; m[7] = -3.25; m[11] = 88;
    const inv = mat4InvertAffine(m)!;
    expect(inv).not.toBeNull();
    const id = mat4Multiply(m, inv);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(id[r * 4 + c]).toBeCloseTo(r === c ? 1 : 0, 10);
      }
    }
  });

  it("スケール付きアフィンも反転できる", () => {
    const m = mat4Identity();
    m[0] = 2; m[5] = 0.5; m[10] = 3; m[3] = 10; m[7] = -4; m[11] = 1;
    const inv = mat4InvertAffine(m)!;
    const id = mat4Multiply(m, inv);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) expect(id[r * 4 + c]).toBeCloseTo(r === c ? 1 : 0, 10);
    }
  });

  it("特異行列は例外ではなく null を返す（描画を止めないため）", () => {
    const m = mat4Identity();
    m[10] = 0; // z 方向が潰れている
    expect(mat4InvertAffine(m)).toBeNull();
  });

  it("オイラー角の規約は Rz·Ry·Rx（X 軸まわりを先に適用）", () => {
    // Rz(90°) は X 軸 (1,0,0) を Y 軸 (0,1,0) へ写す。
    const m = mat4FromEulerDeg(0, 0, 90);
    expect(m[0]).toBeCloseTo(0, 12);
    expect(m[4]).toBeCloseTo(1, 12);
    expect(m[8]).toBeCloseTo(0, 12);

    // 規約が Rz·Ry·Rx であることを、合成順を変えた行列と突き合わせて固定する。
    const rx = mat4FromEulerDeg(20, 0, 0);
    const ry = mat4FromEulerDeg(0, -35, 0);
    const rz = mat4FromEulerDeg(0, 0, 50);
    const composed = mat4Multiply(rz, mat4Multiply(ry, rx));
    const direct = mat4FromEulerDeg(20, -35, 50);
    for (let i = 0; i < 16; i++) expect(direct[i]).toBeCloseTo(composed[i], 12);
  });
});

describe("manualAdjustToTransform（向き＝fixed→moving の pull-back）", () => {
  const center: Vec3 = [30, -20, 55];

  it("全ゼロなら恒等変換そのものを返す", () => {
    const t = manualAdjustToTransform(ZERO_ADJUST, center);
    expect(isIdentityTransform(t)).toBe(true);
    expect(t).toBe(identityTransform());
    expect(manualAdjustToTransform(null, center)).toBe(identityTransform());
  });

  it("平行移動は逆符号で引かれる（moving を +X へ動かす＝fixed 点は −X を引きに行く）", () => {
    const t = manualAdjustToTransform({ ...ZERO_ADJUST, tx: 10 }, center);
    expectVecClose(applyTransform(t, [0, 0, 0]), [-10, 0, 0]);
    expectVecClose(applyTransform(t, [7, 3, -2]), [-3, 3, -2]);
  });

  it("回転中心は動かない", () => {
    const t = manualAdjustToTransform({ ...ZERO_ADJUST, rx: 13, ry: -7, rz: 21 }, center);
    expectVecClose(applyTransform(t, center), center);
  });

  it("順方向で動かした先を写すと元の点に戻る（回転＋平行移動）", () => {
    const a: ManualAdjust = { tx: 4.5, ty: -8.25, tz: 12, rx: 6, ry: -11, rz: 23 };
    const t = manualAdjustToTransform(a, center);
    for (const p of [[0, 0, 0], [100, -50, 200], [30, -20, 55], [-12.5, 77, 3]] as Vec3[]) {
      const moved = forwardManual(a, center, p);
      expectVecClose(applyTransform(t, moved), p, 8);
    }
  });

  it("回転のみのとき中心からの距離が保存される", () => {
    const t = manualAdjustToTransform({ ...ZERO_ADJUST, rx: 35, ry: 12, rz: -60 }, center);
    const p: Vec3 = [130, -70, 105];
    const q = applyTransform(t, p);
    const dp = Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]);
    const dq = Math.hypot(q[0] - center[0], q[1] - center[1], q[2] - center[2]);
    expect(dq).toBeCloseTo(dp, 8);
  });

  it("dof は 6（剛体）として記録される", () => {
    const t = manualAdjustToTransform({ ...ZERO_ADJUST, tx: 1 }, center);
    expect(t.kind).toBe("linear");
    expect((t as LinearTransform).dof).toBe(6);
  });
});

describe("composeTransforms", () => {
  it("恒等だけなら恒等を返す", () => {
    expect(composeTransforms(identityTransform(), null, undefined)).toBe(identityTransform());
    expect(composeTransforms()).toBe(identityTransform());
  });

  it("恒等は取り除かれ、1 つだけなら素通しになる", () => {
    const t = manualAdjustToTransform({ ...ZERO_ADJUST, tz: 3 }, [0, 0, 0]);
    expect(composeTransforms(identityTransform(), t, null)).toBe(t);
  });

  it("線形どうしは 1 つの行列に畳まれる", () => {
    const t1 = manualAdjustToTransform({ ...ZERO_ADJUST, tx: 5 }, [0, 0, 0]);
    const t2 = manualAdjustToTransform({ ...ZERO_ADJUST, ty: 7 }, [0, 0, 0]);
    const c = composeTransforms(t1, t2);
    expect(c.kind).toBe("linear"); // composite ではなく畳まれている
    expectVecClose(applyTransform(c, [0, 0, 0]), [-5, -7, 0]);
  });

  it("適用順は配列順（先頭から）", () => {
    // 先に「X を −10」してから「Y 軸まわり 90°」を適用する pull-back を、手で追った結果と比べる。
    const shift = linearTransform((() => {
      const m = mat4Identity();
      m[3] = -10;
      return m;
    })());
    const rot = linearTransform(mat4FromEulerDeg(0, 0, 90));
    const c = composeTransforms(shift, rot);
    // (10,0,0) --shift--> (0,0,0) --rot--> (0,0,0)
    expectVecClose(applyTransform(c, [10, 0, 0]), [0, 0, 0]);
    // (11,0,0) --shift--> (1,0,0) --rot--> (0,1,0)
    expectVecClose(applyTransform(c, [11, 0, 0]), [0, 1, 0]);
  });
});

describe("補助判定", () => {
  it("isZeroAdjust", () => {
    expect(isZeroAdjust(null)).toBe(true);
    expect(isZeroAdjust(undefined)).toBe(true);
    expect(isZeroAdjust(ZERO_ADJUST)).toBe(true);
    expect(isZeroAdjust({ ...ZERO_ADJUST, rz: 0.1 })).toBe(false);
  });

  it("isIdentityTransform", () => {
    expect(isIdentityTransform(null)).toBe(true);
    expect(isIdentityTransform(identityTransform())).toBe(true);
    expect(isIdentityTransform(linearTransform(mat4Identity()))).toBe(false); // 種別で判定する
  });
});
