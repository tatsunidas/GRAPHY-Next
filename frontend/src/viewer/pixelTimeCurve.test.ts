import { describe, expect, it } from "vitest";
import { pixelToWorld, sampleBilinear, timeCurveAt, worldToPixel, type PlaneMeta, type PlaneSlice } from "./pixelTimeCurve";
import type { Vec3 } from "./regTransform";

const A = 10;
const B = 3; // 時間の傾き
const G = 0.25; // 空間の傾き（単位ベクトル U 方向）
const U: Vec3 = (() => {
  const v: Vec3 = [0.6, -0.48, 0.64];
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
})();
const field = (w: Vec3, t: number) => A + B * t + G * (w[0] * U[0] + w[1] * U[1] + w[2] * U[2]);

function planeAxial(z: number): PlaneMeta {
  return { iop: [1, 0, 0, 0, 1, 0], ipp: [-20, -15, z], pixelSpacingCol: 0.7, pixelSpacingRow: 0.9, cols: 60, rows: 50 };
}
function planeOblique(z: number): PlaneMeta {
  const a = (30 * Math.PI) / 180; // 面内で 30° 回し、さらに列方向を z 側へ 30° 倒す
  return {
    iop: [Math.cos(a), Math.sin(a), 0, -Math.sin(a) * Math.cos(a), Math.cos(a) * Math.cos(a), Math.sin(a)],
    ipp: [-18 + z * 0.1, -14, z],
    pixelSpacingCol: 0.7,
    pixelSpacingRow: 0.9,
    cols: 60,
    rows: 50,
  };
}
/** 画素中心で f を解析的に評価した合成画像（float32）。 */
function render(plane: PlaneMeta, t: number): PlaneSlice {
  const values = new Float32Array(plane.cols * plane.rows);
  for (let y = 0; y < plane.rows; y++) {
    for (let x = 0; x < plane.cols; x++) values[y * plane.cols + x] = field(pixelToWorld(plane, x, y), t);
  }
  return { plane, values };
}
const NT = 8;
/** float32 の相対丸め × 値の大きさ × 演算段数（双一次の足し算・掛け算を 8 段で見る）。 */
const eps = (mag: number) => 8 * 2 ** -24 * mag;

describe("pixelTimeCurve", () => {
  const cases: Array<[string, (z: number) => PlaneMeta]> = [
    ["軸位（異方画素 0.7/0.9 mm）", planeAxial],
    ["斜位（30° 回転＋30° 傾斜）", planeOblique],
  ];
  for (const [name, mk] of cases) {
    it(`${name}: 小数画素の点の時間曲線が解析値に一致する`, () => {
      const slices = Array.from({ length: NT }, (_, t) => render(mk(5), t));
      const world = pixelToWorld(slices[0].plane, 21.37, 17.62);
      const curve = timeCurveAt(world, slices, 2);
      expect(curve).toHaveLength(NT);
      curve.forEach((c, t) => {
        const truth = field(world, t);
        expect(Math.abs(c.value - truth)).toBeLessThanOrEqual(eps(Math.abs(truth)) + 1e-9);
        expect(Math.abs(c.outOfPlaneMm)).toBeLessThan(1e-9);
      });
      expect(curve[NT - 1].value - curve[0].value).toBeCloseTo(B * (NT - 1), 4); // 傾き B で単調増加
    });
  }

  it("負例: 1 時相の IPP を 1 スライスぶんずらすと、その時相は NaN（隣の断面で埋めない）", () => {
    const dz = 4; // スライス間隔
    const slices: PlaneSlice[] = Array.from({ length: NT }, (_, t) => render(planeAxial(5 + (t === 3 ? dz : 0)), t));
    const world = pixelToWorld(planeAxial(5), 20.5, 10.5);
    const curve = timeCurveAt(world, slices, dz / 2);
    expect(Number.isNaN(curve[3].value)).toBe(true);
    expect(curve[3].outOfPlaneMm).toBeCloseTo(-dz, 9); // 点は画像の面から 1 スライスぶん離れている
    curve.filter((_, t) => t !== 3).forEach((c) => expect(Number.isFinite(c.value)).toBe(true));
    // 【識別力】上限を渡さなければ距離で弾かないので、ずれた時相にも値が出る＝上限の検査が効いている。
    expect(Number.isFinite(timeCurveAt(world, slices, null)[3].value)).toBe(true);
  });

  it("負例: 行と列の間隔を取り違えると照合が落ちる（異方格子で検出できる）", () => {
    const slices = Array.from({ length: NT }, (_, t) => render(planeAxial(5), t));
    const world = pixelToWorld(slices[0].plane, 21.37, 17.62);
    const swapped = slices.map((s) => ({
      ...s,
      plane: { ...s.plane, pixelSpacingCol: s.plane.pixelSpacingRow, pixelSpacingRow: s.plane.pixelSpacingCol },
    }));
    const bad = timeCurveAt(world, swapped, 2)[0].value;
    expect(Math.abs(bad - field(world, 0))).toBeGreaterThan(eps(Math.abs(field(world, 0))) * 100);
  });

  it("画像の外・画像が無い時相は NaN", () => {
    const slices: Array<PlaneSlice | null> = [render(planeAxial(5), 0), null];
    const out = timeCurveAt(pixelToWorld(planeAxial(5), 200, 5), slices, 2);
    expect(Number.isNaN(out[0].value)).toBe(true);
    expect(Number.isNaN(out[1].value) && Number.isNaN(out[1].outOfPlaneMm)).toBe(true);
  });

  it("pixelToWorld と worldToPixel は往復で戻る", () => {
    for (const p of [planeAxial(5), planeOblique(5)]) {
      const r = worldToPixel(p, pixelToWorld(p, 12.25, 30.75));
      expect(r.x).toBeCloseTo(12.25, 9);
      expect(r.y).toBeCloseTo(30.75, 9);
      expect(r.outOfPlaneMm).toBeCloseTo(0, 9);
    }
  });

  it("sampleBilinear: 端の画素中心は読め、半画素外は NaN", () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(sampleBilinear(v, 2, 2, 1, 1)).toBe(4);
    expect(sampleBilinear(v, 2, 2, 0.5, 0.5)).toBeCloseTo(2.5, 9);
    expect(Number.isNaN(sampleBilinear(v, 2, 2, 1.01, 0))).toBe(true);
    expect(Number.isNaN(sampleBilinear(v, 2, 2, -0.01, 0))).toBe(true);
  });
});
