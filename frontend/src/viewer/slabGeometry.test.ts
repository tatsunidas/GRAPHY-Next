import { describe, expect, it } from "vitest";
import {
  clampSlabDepth,
  depthAlongView,
  maxSlabDepthMm,
  pickSlabPoint,
  slabPlaneFromCamera,
  spinStep,
  targetForDepth,
  translateCameraTo,
  type Vec3,
} from "./slabGeometry";
import { snapCamera } from "./cameraSnap";

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

describe("スラブ面・深さ", () => {
  it("面は焦点を通り、法線は視線方向の単位ベクトル", () => {
    const { origin, normal } = slabPlaneFromCamera([10, 20, 30], [0, 0, -2]);
    expect(origin).toEqual([10, 20, 30]);
    expect(normal).toEqual([0, 0, -1]);
  });
  it("深さはボリューム中心からの視線方向の符号付き距離", () => {
    expect(depthAlongView([0, 0, 5], [0, 0, 0], [0, 0, 1])).toBe(5);
    expect(depthAlongView([0, 0, 5], [0, 0, 0], [0, 0, -1])).toBe(-5);
    expect(depthAlongView([7, 0, 0], [0, 0, 0], [0, 0, 1])).toBe(0);
  });
  it("targetForDepth は視線方向だけ動かし、画面上の位置（垂直成分）は保つ・可動域で丸める", () => {
    const t = targetForDepth([3, 4, 1], [0, 0, 1], [0, 0, 0], 10, 100);
    expect(t).toEqual([3, 4, 10]);
    expect(targetForDepth([3, 4, 1], [0, 0, 1], [0, 0, 0], 1e6, 20)).toEqual([3, 4, 20]);
  });
  it("translateCameraTo は焦点と位置を同じベクトルだけ動かす", () => {
    const r = translateCameraTo([0, 0, 0], [0, 0, -100], [1, 2, 3]);
    expect(r.focal).toEqual([1, 2, 3]);
    expect(r.position).toEqual([1, 2, -97]);
  });
  it("可動域と丸め", () => {
    expect(maxSlabDepthMm([0, 3, 0, 4, 0, 0])).toBeCloseTo(2.5);
    expect(clampSlabDepth(-100, 2.5)).toBe(-2.5);
    expect(clampSlabDepth(Number.NaN, 2.5)).toBe(0);
  });
});

describe("pickSlabPoint（ダブルクリックの中心指定）", () => {
  // z=+3 に高値、z=-2 に低値、それ以外 0 の合成ボリューム（x,y は無関係）。
  const sample = (w: Vec3) => (Math.abs(w[2] - 3) < 0.26 ? 1000 : Math.abs(w[2] + 2) < 0.26 ? -1000 : 0);
  const ray = { origin: [5, 6, -50], dir: [0, 0, 1] };
  it("MIP はスラブ内で最大値の深さ", () => {
    const p = pickSlabPoint(ray, sample, [0, 0, 0], [0, 0, 1], 10, "MIP", 0.5)!;
    expect(p[0]).toBe(5);
    expect(p[1]).toBe(6);
    expect(p[2]).toBeCloseTo(3, 1);
  });
  it("MinIP はスラブ内で最小値の深さ", () => {
    expect(pickSlabPoint(ray, sample, [0, 0, 0], [0, 0, 1], 10, "MINIP", 0.5)![2]).toBeCloseTo(-2, 1);
  });
  it("AvgIP は中心面上の交点", () => {
    expect(pickSlabPoint(ray, sample, [0, 0, 1], [0, 0, 1], 10, "AVG", 0.5)).toEqual([5, 6, 1]);
  });
  it("スラブ外の構造は拾わない（薄いスラブなら中心面寄りの 0 の点）", () => {
    const p = pickSlabPoint(ray, sample, [0, 0, 0], [0, 0, 1], 2, "MIP", 0.5)!;
    expect(Math.abs(p[2])).toBeLessThanOrEqual(1);
    expect(sample(p)).toBe(0);
  });
  it("レイが面と平行なら null", () => {
    expect(pickSlabPoint({ origin: [0, 0, 0], dir: [1, 0, 0] }, sample, [0, 0, 0], [0, 0, 1], 5, "MIP", 0.5)).toBeNull();
  });
});

describe("spinStep（自動回転）", () => {
  it("360° 連続は速度×時間ずつ進む", () => {
    const r = spinStep({ angle: 0, dir: 1 }, 0.5, { axis: "horizontal", degPerSec: 30, rangeDeg: null });
    expect(r.delta).toBe(15);
    expect(r.next.angle).toBe(15);
  });
  it("往復は ±range で折り返す", () => {
    const r = spinStep({ angle: 25, dir: 1 }, 0.5, { axis: "horizontal", degPerSec: 30, rangeDeg: 30 });
    expect(r.next.angle).toBe(20); // 25→40 を 30 で反射
    expect(r.next.dir).toBe(-1);
    expect(r.delta).toBe(-5);
    const b = spinStep({ angle: -28, dir: -1 }, 0.2, { axis: "vertical", degPerSec: 30, rangeDeg: 30 });
    expect(b.next.angle).toBe(-26);
    expect(b.next.dir).toBe(1);
  });
});

describe("snapCamera（向きスナップ）", () => {
  it("Axial/Coronal は画面右が患者 L(+X)、Sagittal は画面右が P(+Y)", () => {
    const right = (k: "AX" | "COR" | "SAG") => {
      const { dop, viewUp } = snapCamera(k);
      return cross(dop, viewUp).map((v) => v + 0);
    };
    expect(right("AX")).toEqual([1, 0, 0]);
    expect(right("COR")).toEqual([1, 0, 0]);
    expect(right("SAG")).toEqual([0, 1, 0]);
  });
  it("反対側からは視線だけ反転", () => {
    expect(snapCamera("AX", true)).toEqual({ dop: [0, 0, -1], viewUp: [0, -1, 0] });
  });
});
