/*
 * float32 の演算を Math.fround で再現した Fusion リサンプル（GPU のシェーダを書く前の、独立した写し）。
 * 一致検査器の**正例**に使う: 実際に float32 で計算した結果が E 以内に収まること。
 * 本番コードから import しない。
 */
import type { BackgroundSliceMeta, FusionVolume } from "../fusionEngine";
import { planResample, type ResamplePlan } from "./resamplePlan";
import type { Vec3, WorldTransform } from "../regTransform";

const f = Math.fround;

export function evaluatePlanF32(plan: ResamplePlan, bx: number, by: number): Vec3 {
  const aff = (M: Float64Array, v: Vec3, t: Vec3): Vec3 => {
    const o: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      o[k] = f(f(f(f(M[k * 3]) * v[0]) + f(f(M[k * 3 + 1]) * v[1])) + f(f(M[k * 3 + 2]) * v[2]));
      o[k] = f(o[k] + f(t[k]));
    }
    return o;
  };
  const q: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    q[k] = f(f(f(f(plan.first[k * 3]) * bx) + f(f(plan.first[k * 3 + 1]) * by)) + f(plan.first[k * 3 + 2]));
  }
  let cur: Vec3 = q;
  for (const st of plan.stages) {
    const s = st.dvf;
    const [nx, ny, nz] = s.dims;
    const n = [nx, ny, nz];
    const g: number[] = [];
    for (let k = 0; k < 3; k++) {
      let gk = f(f(cur[k] - f(s.originLocal[k])) / f(s.spacing[k]));
      if (gk < 0) gk = 0; else if (gk > n[k] - 1) gk = n[k] - 1;
      g.push(gk);
    }
    const i0 = Math.floor(g[0]), j0 = Math.floor(g[1]), k0 = Math.floor(g[2]);
    const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1), k1 = Math.min(k0 + 1, nz - 1);
    const fi = f(g[0] - i0), fj = f(g[1] - j0), fk = f(g[2] - k0);
    const D = s.displacements;
    const at = (i: number, j: number, k: number, c: number) => D[((k * ny + j) * nx + i) * 3 + c];
    const lerp = (a: number, b: number, t: number) => f(a + f(f(b - a) * t));
    const d: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const c00 = lerp(at(i0, j0, k0, c), at(i1, j0, k0, c), fi);
      const c10 = lerp(at(i0, j1, k0, c), at(i1, j1, k0, c), fi);
      const c01 = lerp(at(i0, j0, k1, c), at(i1, j0, k1, c), fi);
      const c11 = lerp(at(i0, j1, k1, c), at(i1, j1, k1, c), fi);
      d[c] = lerp(lerp(c00, c10, fj), lerp(c01, c11, fj), fk);
    }
    cur = [f(cur[0] + d[0]), f(cur[1] + d[1]), f(cur[2] + d[2])];
    cur = aff(st.after.M, cur, st.after.t);
  }
  return cur;
}

/** float32 で計算した背景スライス 1 枚分の前景値（範囲外は NaN）。 */
export function computeFusionSliceF32(fg: FusionVolume, bg: BackgroundSliceMeta, xf?: WorldTransform | null): Float32Array {
  const out = new Float32Array(bg.rows * bg.cols).fill(NaN);
  const d = fg.slices.length;
  if (d === 0) return out;
  const plan = planResample(fg, bg, xf);
  const ip = fg.slices[0].ipp;
  const fRs: Vec3 = [
    fg.iop[1] * fg.iop[5] - fg.iop[2] * fg.iop[4],
    fg.iop[2] * fg.iop[3] - fg.iop[0] * fg.iop[5],
    fg.iop[0] * fg.iop[4] - fg.iop[1] * fg.iop[3],
  ];
  const wPos = fg.slices.map((s) => f((s.ipp[0] - ip[0]) * fRs[0] + (s.ipp[1] - ip[1]) * fRs[1] + (s.ipp[2] - ip[2]) * fRs[2]));
  const W = fg.cols, H = fg.rows;
  const lerp = (a: number, b: number, t: number) => f(a + f(f(b - a) * t));
  const bil = (s: (typeof fg.slices)[number], u: number, v: number) => {
    const iu = Math.floor(u), iv = Math.floor(v);
    const iu0 = Math.max(0, iu), iu1 = Math.min(iu + 1, W - 1);
    const iv0 = Math.max(0, iv), iv1 = Math.min(iv + 1, H - 1);
    const uu = Math.min(1, Math.max(0, f(u - iu))), vv = Math.min(1, Math.max(0, f(v - iv)));
    const p = s.pixels;
    const top = lerp(p[iv0 * W + iu0], p[iv0 * W + iu1], uu);
    const bot = lerp(p[iv1 * W + iu0], p[iv1 * W + iu1], uu);
    return f(f(lerp(top, bot, vv) * f(s.slope)) + f(s.intercept));
  };
  for (let by = 0; by < bg.rows; by++) for (let bx = 0; bx < bg.cols; bx++) {
    const [u, v, w] = evaluatePlanF32(plan, bx, by);
    if (u < -0.5 || u > W - 0.5 || v < -0.5 || v > H - 0.5) continue;
    let iw = -1;
    if (w >= wPos[0]) { iw = 0; while (iw < d - 1 && wPos[iw + 1] <= w) iw++; }
    let val: number;
    if (iw < 0) val = bil(fg.slices[0], u, v);
    else if (iw >= d - 1) val = bil(fg.slices[d - 1], u, v);
    else {
      const dw = f(wPos[iw + 1] - wPos[iw]);
      const t = dw > 0 ? f(f(w - wPos[iw]) / dw) : 0;
      val = lerp(bil(fg.slices[iw], u, v), bil(fg.slices[iw + 1], u, v), t);
    }
    out[by * bg.cols + bx] = val;
  }
  return out;
}
