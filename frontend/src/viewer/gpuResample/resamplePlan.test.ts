/*
 * 計画層（float64）が computeFusionPixel の (u, v, w_mm) と一致すること、
 * 座標誤差の上界が float32 で同じ式を計算したときの実際の誤差を覆うこと。
 */
import { describe, it, expect } from "vitest";
import { fusionNeighborhood, prepareFusionSlice } from "../fusionEngine";
import { evaluatePlan, evaluatePlanWithBound, planResample, OP_COUNTS, U32, gamma } from "./resamplePlan";
import { dvfTransform } from "../regTransform";
import {
  BG_COLS, BG_ROWS, fusionFixtureTransforms, makeFusionFixtureBg, makeFusionFixtureFg,
} from "./parityFixtures.testutil";

// 許容 1e-12（相対）: float64 の丸め 2⁻⁵³ ≈ 1.1e-16 に、段数 ≤ 3・各段の積和 ≤ 数十演算と、
// 局所座標 ↔ world の引き算による桁落ち（座標 ~1e2、差 ~1e0 → 1e2 倍）を見込んだ上限。
const REL = 1e-12;

describe("計画層の評価が CPU の経路の (u, v, w_mm) と一致する", () => {
  const fg = makeFusionFixtureFg();
  for (const { name, xf } of fusionFixtureTransforms()) {
    it(name, () => {
      let compared = 0;
      for (const z of [-6, 0, 5]) {
        const bg = makeFusionFixtureBg(z);
        const ctx = prepareFusionSlice(fg, bg, xf)!;
        const plan = planResample(fg, bg, xf);
        for (let by = 0; by < BG_ROWS; by += 3) for (let bx = 0; bx < BG_COLS; bx += 3) {
          const nb = fusionNeighborhood(ctx, bx, by);
          const p = evaluatePlan(plan, bx, by);
          // nb は面内範囲外で null。範囲外の画素は (u, v) を直接は比べられないので、範囲内だけ比べる
          if (!nb) continue;
          const sc = (a: number) => Math.max(1, Math.abs(a));
          expect(Math.abs(p[0] - nb.u) / sc(nb.u)).toBeLessThan(REL);
          expect(Math.abs(p[1] - nb.v) / sc(nb.v)).toBeLessThan(REL);
          expect(Math.abs(p[2] - nb.w_mm) / sc(nb.w_mm)).toBeLessThan(REL);
          compared++;
        }
      }
      expect(compared).toBeGreaterThan(100);
    });
  }

  it("負例: 計画の行列の 1 成分を 1e-6 ずらすと一致しない", () => {
    const bg = makeFusionFixtureBg(0);
    const { xf } = fusionFixtureTransforms()[1];
    const ctx = prepareFusionSlice(fg, bg, xf)!;
    const plan = planResample(fg, bg, xf);
    plan.first[0] += 1e-6;
    let bad = 0;
    for (let by = 0; by < BG_ROWS; by += 3) for (let bx = 0; bx < BG_COLS; bx += 3) {
      const nb = fusionNeighborhood(ctx, bx, by);
      if (!nb) continue;
      const p = evaluatePlan(plan, bx, by);
      if (Math.abs(p[0] - nb.u) / Math.max(1, Math.abs(nb.u)) > REL) bad++;
    }
    expect(bad).toBeGreaterThan(0);
  });
});

describe("DVF の格子の外は端の変位で延長する（regTransform と同じ）", () => {
  it("格子の外の点でも一致する", () => {
    const fg = makeFusionFixtureFg();
    const bg = makeFusionFixtureBg(0);
    const d = new Float32Array(3 * 3 * 3 * 3).map((_, i) => ((i * 7) % 11) - 5);
    // 格子を背景スライスの一部だけに置く → 多くの画素が格子の外
    const xf = dvfTransform(d, [3, 3, 3], [-5, -5, -5], [4, 4, 4]);
    const ctx = prepareFusionSlice(fg, bg, xf)!;
    const plan = planResample(fg, bg, xf);
    let n = 0;
    for (let by = 0; by < BG_ROWS; by++) for (let bx = 0; bx < BG_COLS; bx++) {
      const nb = fusionNeighborhood(ctx, bx, by);
      if (!nb) continue;
      const p = evaluatePlan(plan, bx, by);
      expect(Math.abs(p[0] - nb.u)).toBeLessThan(1e-9);
      expect(Math.abs(p[2] - nb.w_mm)).toBeLessThan(1e-9);
      n++;
    }
    expect(n).toBeGreaterThan(100);
  });
});

describe("座標誤差の上界", () => {
  it("OP_COUNTS は正の整数で γ が 1 より十分小さい", () => {
    for (const v of Object.values(OP_COUNTS)) {
      expect(Number.isInteger(v) && v > 0).toBe(true);
      expect(gamma(v)).toBeLessThan(1e-5);
    }
    expect(U32).toBe(2 ** -24);
  });

  it("float32 で同じ式を計算した座標の誤差が上界以内（全変換・全画素）", () => {
    const fg = makeFusionFixtureFg();
    for (const { name, xf } of fusionFixtureTransforms()) {
      const bg = makeFusionFixtureBg(0);
      const plan = planResample(fg, bg, xf);
      let maxRatio = 0, n = 0;
      for (let by = 0; by < BG_ROWS; by++) for (let bx = 0; bx < BG_COLS; bx++) {
        const b = evaluatePlanWithBound(plan, bx, by);
        const e = evaluatePlanF32(plan, bx, by);
        const r = [Math.abs(e[0] - b.u) / b.du, Math.abs(e[1] - b.v) / b.dv, Math.abs(e[2] - b.w_mm) / b.dw];
        for (const x of r) { if (x > maxRatio) maxRatio = x; }
        n++;
      }
      console.info(`[座標誤差] ${name}: 実誤差/上界の最大 = ${maxRatio.toExponential(2)}`);
      // 上界の中に入っていること（比 ≤ 1）と、上界が実際の誤差の桁を外れていない（比 > 1e-3）こと
      expect(maxRatio, name).toBeLessThanOrEqual(1);
      expect(maxRatio, name).toBeGreaterThan(1e-3);
      expect(n).toBe(BG_COLS * BG_ROWS);
    }
  });
});

/** float32 のエミュレーション（Math.fround を各演算に掛ける）。シェーダを書く前の独立した写し。 */
function evaluatePlanF32(plan: ReturnType<typeof planResample>, bx: number, by: number): [number, number, number] {
  const f = Math.fround;
  const aff = (M: Float64Array, v: [number, number, number], t: [number, number, number]) => {
    const o: [number, number, number] = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      o[k] = f(f(f(f(M[k * 3]) * v[0]) + f(f(M[k * 3 + 1]) * v[1])) + f(f(M[k * 3 + 2]) * v[2]));
      o[k] = f(o[k] + f(t[k]));
    }
    return o;
  };
  // first は [bx, by, 1] に掛ける（第 3 列が定数項）
  let q: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    q[k] = f(f(f(f(plan.first[k * 3]) * bx) + f(f(plan.first[k * 3 + 1]) * by)) + f(plan.first[k * 3 + 2]));
  }
  for (const st of plan.stages) {
    const s = st.dvf;
    const [nx, ny, nz] = s.dims;
    const n = [nx, ny, nz];
    const g: number[] = [];
    for (let k = 0; k < 3; k++) {
      let gk = f(f(q[k] - f(s.originLocal[k])) / f(s.spacing[k]));
      if (gk < 0) gk = 0; else if (gk > n[k] - 1) gk = n[k] - 1;
      g.push(gk);
    }
    const i0 = Math.floor(g[0]), j0 = Math.floor(g[1]), k0 = Math.floor(g[2]);
    const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1), k1 = Math.min(k0 + 1, nz - 1);
    const fi = f(g[0] - i0), fj = f(g[1] - j0), fk = f(g[2] - k0);
    const D = s.displacements;
    const at = (i: number, j: number, k: number, c: number) => D[((k * ny + j) * nx + i) * 3 + c];
    const lerp = (a: number, b: number, t: number) => f(a + f(f(b - a) * t));
    const d: [number, number, number] = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c00 = lerp(at(i0, j0, k0, c), at(i1, j0, k0, c), fi);
      const c10 = lerp(at(i0, j1, k0, c), at(i1, j1, k0, c), fi);
      const c01 = lerp(at(i0, j0, k1, c), at(i1, j0, k1, c), fi);
      const c11 = lerp(at(i0, j1, k1, c), at(i1, j1, k1, c), fi);
      d[c] = lerp(lerp(c00, c10, fj), lerp(c01, c11, fj), fk);
    }
    q = [f(q[0] + d[0]), f(q[1] + d[1]), f(q[2] + d[2])];
    q = aff(st.after.M, q, st.after.t);
  }
  return q;
}
