import { describe, expect, it } from "vitest";
import { snapCamera } from "./cameraSnap";
import { MAX_CLIP_PLANES, cameraFromView, validateClipPlanes, type ViewResult } from "./viewer3dCamera";
import type { Vec3 } from "./slabGeometry";

const near = (a: readonly number[], b: readonly number[], tol = 1e-9) => {
  expect(a.length).toBe(b.length);
  a.forEach((x, i) => expect(Math.abs(x - b[i])).toBeLessThan(tol));
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const ok = (r: ViewResult) => {
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("cameraFromView", () => {
  const F: Vec3 = [10, -20, 30];

  it("z 軸視線・上 −y: 位置・上・画面右が式どおり（画面右 = L）", () => {
    const r = ok(cameraFromView({ direction: [0, 0, 1], up: [0, -1, 0], focalPoint: F, distanceMm: 300 }));
    near(r.position, [10, -20, -270]);
    near(r.viewUp, [0, -1, 0]);
    near(r.right, [1, 0, 0]);
  });

  it("視線の長さを変えても同じ（長さ 2 を渡す）", () => {
    const a = ok(cameraFromView({ direction: [0, 0, 1], up: [0, -1, 0], focalPoint: F, distanceMm: 300 }));
    const b = ok(cameraFromView({ direction: [0, 0, 2], up: [0, -1, 0], focalPoint: F, distanceMm: 300 }));
    near(a.position, b.position);
    near(a.viewUp, b.viewUp);
  });

  it("AX・COR・SAG（反対側も）が cameraSnap と一致する", () => {
    for (const kind of ["AX", "COR", "SAG"] as const) {
      for (const flip of [false, true]) {
        const s = snapCamera(kind, flip);
        const r = ok(cameraFromView({ direction: s.dop, up: s.viewUp, focalPoint: F, distanceMm: 250 }));
        near(r.position, [F[0] - 250 * s.dop[0], F[1] - 250 * s.dop[1], F[2] - 250 * s.dop[2]]);
        near(r.viewUp, s.viewUp);
      }
    }
  });

  it("軸に平行でない一般の向き: 直交・単位・右手系（画面右 = 視線 × 上）", () => {
    const dir: Vec3 = [1 / 3, 2 / 3, -2 / 3];
    const upIn: Vec3 = [0.3, 0.1, 0.9]; // 視線に直交でない
    const r = ok(cameraFromView({ direction: dir, up: upIn, focalPoint: F, distanceMm: 100 }));
    expect(Math.abs(dot(r.viewUp, r.direction))).toBeLessThan(1e-9); // 直交化された
    near([Math.hypot(...r.viewUp), Math.hypot(...r.right), Math.hypot(...r.direction)], [1, 1, 1]);
    near(r.right, [
      r.direction[1] * r.viewUp[2] - r.direction[2] * r.viewUp[1],
      r.direction[2] * r.viewUp[0] - r.direction[0] * r.viewUp[2],
      r.direction[0] * r.viewUp[1] - r.direction[1] * r.viewUp[0],
    ]);
    // up の符号を反転すると viewUp・right がともに反転する（検出器が反転を見分けられる）
    const flipped = ok(cameraFromView({ direction: dir, up: [-upIn[0], -upIn[1], -upIn[2]], focalPoint: F, distanceMm: 100 }));
    near(flipped.viewUp, r.viewUp.map((x) => -x));
    near(flipped.right, r.right.map((x) => -x));
    // 視線の反転は位置と右だけを反転する（上は同じ。「反対側から」）
    const back = ok(cameraFromView({ direction: dir.map((x) => -x) as Vec3, up: upIn, focalPoint: F, distanceMm: 100 }));
    near(back.viewUp, r.viewUp);
    near(back.right, r.right.map((x) => -x));
  });

  it("不正な入力は理由つきで拒否する（既定値に置き換えない）", () => {
    const base = { direction: [0, 0, 1] as Vec3, up: [0, -1, 0] as Vec3, focalPoint: F, distanceMm: 100 };
    const bad: [string, Partial<typeof base>][] = [
      ["視線 0", { direction: [0, 0, 0] }],
      ["視線 NaN", { direction: [NaN, 0, 1] }],
      ["視線 無限", { direction: [Infinity, 0, 1] }],
      ["上 0", { up: [0, 0, 0] }],
      ["上 NaN", { up: [0, NaN, 0] }],
      ["上が視線と平行", { up: [0, 0, 5] }],
      ["上が視線と逆平行", { up: [0, 0, -1] }],
      ["注視点 NaN", { focalPoint: [0, NaN, 0] }],
      ["距離 0", { distanceMm: 0 }],
      ["距離 負", { distanceMm: -1 }],
      ["距離 NaN", { distanceMm: NaN }],
    ];
    for (const [label, patch] of bad) {
      const r = cameraFromView({ ...base, ...patch });
      expect(r.ok, label).toBe(false);
      if (!r.ok) expect(r.reason.length, label).toBeGreaterThan(0);
    }
  });
});

describe("validateClipPlanes", () => {
  it("法線を正規化して返し、残す側（法線の向き）は変えない", () => {
    const r = validateClipPlanes([{ origin: [1, 2, 3], normal: [0, 0, -4] }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      near(r.planes[0].normal, [0, 0, -1]);
      near(r.planes[0].origin, [1, 2, 3]);
    }
  });
  it("空配列は ok（全部消す）", () => {
    expect(validateClipPlanes([])).toEqual({ ok: true, planes: [] });
  });
  it("法線 0・NaN、原点 NaN、7 枚は拒否", () => {
    expect(validateClipPlanes([{ origin: [0, 0, 0], normal: [0, 0, 0] }]).ok).toBe(false);
    expect(validateClipPlanes([{ origin: [0, 0, 0], normal: [NaN, 0, 1] }]).ok).toBe(false);
    expect(validateClipPlanes([{ origin: [0, Infinity, 0], normal: [0, 0, 1] }]).ok).toBe(false);
    const seven = Array.from({ length: MAX_CLIP_PLANES + 1 }, () => ({ origin: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 }));
    expect(validateClipPlanes(seven).ok).toBe(false);
    expect(validateClipPlanes(seven.slice(0, MAX_CLIP_PLANES)).ok).toBe(true);
  });
});
