/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion のリサンプルの「計画」（float64 の純関数）。
 *
 * <p>背景画素 (bx, by) → 前景の (u, v, w_mm) の写像を、GPU に渡せる小さな段の列に畳む。
 * world の大きな座標は GPU（float32）に渡さない: 背景スライスの中心 c0 を原点とする**局所座標**で持ち、
 * アフィンは [bx, by, 1] から一度に畳む（桁落ちを避ける）。DVF は局所座標の格子として持つ。
 *
 * <p>同じ写像の誤差上界（{@link evaluatePlanWithBound}）も出す。GPU との一致の基準（E）の座標側の項。
 * 上界は丸め誤差の標準的な評価（n 回の演算の累積 γₙ = n·u / (1 − n·u)、u = 2⁻²⁴）に従う。
 *
 * <p>幾何は患者 LPS mm のまま。画素・テクスチャの添字は bx, by と、格子座標 g の中だけ。
 */
import type { BackgroundSliceMeta, FusionVolume } from "../fusionEngine";
import type { CompositeTransform, DvfTransform, LinearTransform, Vec3, WorldTransform } from "../regTransform";

/** float32 の丸めの単位 u = 2⁻²⁴（GLSL ES 3.00 の highp の相対精度の要求は仕様の表で段 2 の前に確かめる）。 */
export const U32 = 2 ** -24;

/** γₙ = n·u / (1 − n·u)。 */
export function gamma(n: number): number {
  return (n * U32) / (1 - n * U32);
}

/**
 * 演算数（誤差上界の n）。affine・interp は **GPU のシェーダ（gpuShader.ts）の式から数えた値**で、
 * シェーダを変えたら数え直す（gpuShader.test.ts がシェーダの要約値で強制する）。
 * - affine: 3 項の積和（乗算 3・加算 2）＋ float64 → float32 に丸めて渡す係数の誤差 1 回分 = 4
 * - interp: シェーダの補間の連鎖は 11 段（gpuShader.ts の冒頭に内訳）。上界には余裕を持たせて 16
 * - gridCoord・dvf: DVF（第 3 段）の見積もり。シェーダがまだ無いので上限の暫定値（DVF のシェーダを書くときに数え直す）
 */
export const OP_COUNTS = { affine: 4, gridCoord: 2, dvf: 16, interp: 16 } as const;

export interface AffineQ {
  /** row-major 3×3。 */
  M: Float64Array;
  t: Vec3;
}

export interface DvfStagePlan {
  /** 局所座標での格子原点（world の origin − c0）。 */
  originLocal: Vec3;
  spacing: Vec3;
  dims: readonly [number, number, number];
  /** `(k*ny + j)*nx + i` の順に x,y,z。 */
  displacements: Float32Array;
}

export interface ResamplePlan {
  /** 局所座標の原点（背景スライスの中心、world）。 */
  c0: Vec3;
  /** row-major 3×3。q = first · [bx, by, 1]。DVF が無ければ (u, v, w_mm) そのもの。 */
  first: Float64Array;
  /** DVF の段とその後ろのアフィン。最後の after が (u, v, w_mm) を出す。 */
  stages: { dvf: DvfStagePlan; after: AffineQ }[];
}

function leavesOf(xf: WorldTransform | null | undefined): WorldTransform[] {
  if (!xf || xf.kind === "identity") return [];
  if (xf.kind === "composite") return (xf as CompositeTransform).chain.flatMap(leavesOf);
  return [xf];
}

/** out = a · b（3×3 row-major）。 */
function mul33(a: Float64Array, b: Float64Array): Float64Array {
  const o = new Float64Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    o[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  }
  return o;
}

function mulVec(m: Float64Array, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** 局所座標で q' = Lq + (L·c0 + l − c0) と書ける世界のアフィン p' = L p + l を返す。 */
function localAffine(L: Float64Array, l: Vec3, c0: Vec3): AffineQ {
  const Lc = mulVec(L, c0);
  return { M: L, t: [Lc[0] + l[0] - c0[0], Lc[1] + l[1] - c0[1], Lc[2] + l[2] - c0[2]] };
}

function applyToFirst(first: Float64Array, a: AffineQ): Float64Array {
  const o = mul33(a.M, first);
  o[2] += a.t[0]; o[5] += a.t[1]; o[8] += a.t[2];
  return o;
}

function applyToAfter(after: AffineQ, a: AffineQ): AffineQ {
  const t = mulVec(a.M, after.t);
  return { M: mul33(a.M, after.M), t: [t[0] + a.t[0], t[1] + a.t[1], t[2] + a.t[2]] };
}

/** 背景スライスの中心（world）。局所座標の原点。 */
export function bgCenter(bg: BackgroundSliceMeta): Vec3 {
  const sx = ((bg.cols - 1) / 2) * bg.pixelSpacingCol;
  const sy = ((bg.rows - 1) / 2) * bg.pixelSpacingRow;
  return [
    bg.ipp[0] + sx * bg.iop[0] + sy * bg.iop[3],
    bg.ipp[1] + sx * bg.iop[1] + sy * bg.iop[4],
    bg.ipp[2] + sx * bg.iop[2] + sy * bg.iop[5],
  ];
}

export function planResample(
  fg: FusionVolume,
  bg: BackgroundSliceMeta,
  xf?: WorldTransform | null,
): ResamplePlan {
  const c0 = bgCenter(bg);
  const bPx = bg.pixelSpacingCol, bPy = bg.pixelSpacingRow;
  // q = first · [bx, by, 1]（局所座標）
  let first: Float64Array = new Float64Array([
    bPx * bg.iop[0], bPy * bg.iop[3], bg.ipp[0] - c0[0],
    bPx * bg.iop[1], bPy * bg.iop[4], bg.ipp[1] - c0[1],
    bPx * bg.iop[2], bPy * bg.iop[5], bg.ipp[2] - c0[2],
  ]);
  const stages: ResamplePlan["stages"] = [];
  let after: AffineQ | null = null;

  const push = (a: AffineQ) => {
    if (after) after = applyToAfter(after, a);
    else first = applyToFirst(first, a);
  };

  for (const leaf of leavesOf(xf)) {
    if (leaf.kind === "linear") {
      const m = (leaf as LinearTransform).matrix;
      push(localAffine(
        new Float64Array([m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]),
        [m[3], m[7], m[11]],
        c0,
      ));
    } else if (leaf.kind === "dvf") {
      const d = leaf as DvfTransform;
      if (after) stages[stages.length - 1].after = after;
      stages.push({
        dvf: {
          originLocal: [d.origin[0] - c0[0], d.origin[1] - c0[1], d.origin[2] - c0[2]],
          spacing: [d.spacing[0], d.spacing[1], d.spacing[2]],
          dims: d.dims,
          displacements: d.displacements,
        },
        after: { M: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, 0] },
      });
      after = stages[stages.length - 1].after;
    } else {
      throw new Error(`planResample: 未対応の変換 ${leaf.kind}`);
    }
  }

  // 出口: ワールド → 前景の (u, v, w_mm)。
  const fRr: Vec3 = [fg.iop[0], fg.iop[1], fg.iop[2]];
  const fRc: Vec3 = [fg.iop[3], fg.iop[4], fg.iop[5]];
  const fRs: Vec3 = [
    fRr[1] * fRc[2] - fRr[2] * fRc[1],
    fRr[2] * fRc[0] - fRr[0] * fRc[2],
    fRr[0] * fRc[1] - fRr[1] * fRc[0],
  ];
  const X = new Float64Array([
    fRr[0] / fg.pixelSpacingCol, fRr[1] / fg.pixelSpacingCol, fRr[2] / fg.pixelSpacingCol,
    fRc[0] / fg.pixelSpacingRow, fRc[1] / fg.pixelSpacingRow, fRc[2] / fg.pixelSpacingRow,
    fRs[0], fRs[1], fRs[2],
  ]);
  const ip = fg.slices.length > 0 ? fg.slices[0].ipp : ([0, 0, 0] as Vec3);
  const t = mulVec(X, [c0[0] - ip[0], c0[1] - ip[1], c0[2] - ip[2]]);
  push({ M: X, t });
  if (after) stages[stages.length - 1].after = after;

  return { c0, first, stages };
}

function lin(m: Float64Array, v: Vec3, t?: Vec3): Vec3 {
  const r = mulVec(m, v);
  return t ? [r[0] + t[0], r[1] + t[1], r[2] + t[2]] : r;
}

/** DVF の格子座標（クランプ済み）と、その変位（float64、regTransform.dvfTransform と同じ補間）。 */
function dvfDisplacement(s: DvfStagePlan, q: Vec3): { d: Vec3; cell: [number, number, number]; g: Vec3 } {
  const [nx, ny, nz] = s.dims;
  const g: Vec3 = [0, 0, 0];
  const n = [nx, ny, nz];
  for (let k = 0; k < 3; k++) {
    let gk = (q[k] - s.originLocal[k]) / s.spacing[k];
    if (gk < 0) gk = 0; else if (gk > n[k] - 1) gk = n[k] - 1;
    g[k] = gk;
  }
  const i0 = Math.floor(g[0]), j0 = Math.floor(g[1]), k0 = Math.floor(g[2]);
  const i1 = i0 + 1 < nx ? i0 + 1 : i0;
  const j1 = j0 + 1 < ny ? j0 + 1 : j0;
  const k1 = k0 + 1 < nz ? k0 + 1 : k0;
  const fi = g[0] - i0, fj = g[1] - j0, fk = g[2] - k0;
  const D = s.displacements;
  const at = (i: number, j: number, k: number, c: number) => D[((k * ny + j) * nx + i) * 3 + c];
  const d: Vec3 = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = at(i0, j0, k0, c) + (at(i1, j0, k0, c) - at(i0, j0, k0, c)) * fi;
    const c10 = at(i0, j1, k0, c) + (at(i1, j1, k0, c) - at(i0, j1, k0, c)) * fi;
    const c01 = at(i0, j0, k1, c) + (at(i1, j0, k1, c) - at(i0, j0, k1, c)) * fi;
    const c11 = at(i0, j1, k1, c) + (at(i1, j1, k1, c) - at(i0, j1, k1, c)) * fi;
    const c0v = c00 + (c10 - c00) * fj;
    const c1v = c01 + (c11 - c01) * fj;
    d[c] = c0v + (c1v - c0v) * fk;
  }
  return { d, cell: [i0, j0, k0], g };
}

/** 計画を float64 で評価する。`computeFusionPixel` の (u, v, w_mm) と相対 1e-12 程度で一致する。 */
export function evaluatePlan(plan: ResamplePlan, bx: number, by: number): Vec3 {
  let q = lin(plan.first, [bx, by, 1]);
  for (const st of plan.stages) {
    const { d } = dvfDisplacement(st.dvf, q);
    q = [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
    q = lin(st.after.M, q, st.after.t);
  }
  return q;
}

export interface PlanPoint {
  u: number;
  v: number;
  w_mm: number;
  /** (u, v) は前景のボクセル単位、w は mm の、float32 で計算したときの座標誤差の上界。 */
  du: number;
  dv: number;
  dw: number;
}

const abs3 = (m: Float64Array) => m.map(Math.abs) as Float64Array;

/**
 * 計画を評価しつつ、float32 で同じ式を計算したときの座標誤差の上界を出す。
 * - アフィン段: δ_out = |M|·δ_in + γ_affine·(|M||q| + |t|)（q は float64 で評価した途中の値）
 * - DVF 段: 格子座標の誤差 δg = δq/間隔 + γ_gridCoord·(|q|+|原点|)/間隔。変位の誤差は
 *   Σ_a L_{c,a}·δg_a（L は引いた 2×2×2 の隣同士の変位差の最大）＋ γ_dvf·max|d|。足し込みの丸めに u·|q'|。
 */
export function evaluatePlanWithBound(plan: ResamplePlan, bx: number, by: number): PlanPoint {
  const gA = gamma(OP_COUNTS.affine);
  const F = plan.first;
  let q = lin(F, [bx, by, 1]);
  let dq: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    dq[k] = gA * (Math.abs(F[k * 3]) * Math.abs(bx) + Math.abs(F[k * 3 + 1]) * Math.abs(by) + Math.abs(F[k * 3 + 2]));
  }
  for (const st of plan.stages) {
    const s = st.dvf;
    const [nx, ny, nz] = s.dims;
    const { d, cell, g } = dvfDisplacement(s, q);
    const dg: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      dg[k] = dq[k] / s.spacing[k] + (gamma(OP_COUNTS.gridCoord) * (Math.abs(q[k]) + Math.abs(s.originLocal[k]))) / s.spacing[k];
    }
    // 引いたセルの隣同士の変位差の最大（成分 c × 格子の軸 a）
    const [i0, j0, k0] = cell;
    const i1 = Math.min(i0 + 1, nx - 1), j1 = Math.min(j0 + 1, ny - 1), k1 = Math.min(k0 + 1, nz - 1);
    const D = s.displacements;
    const at = (i: number, j: number, k: number, c: number) => D[((k * ny + j) * nx + i) * 3 + c];
    const dd: Vec3 = [0, 0, 0];
    let dmax = 0;
    for (let c = 0; c < 3; c++) {
      let Lx = 0, Ly = 0, Lz = 0;
      for (const j of [j0, j1]) for (const k of [k0, k1]) Lx = Math.max(Lx, Math.abs(at(i1, j, k, c) - at(i0, j, k, c)));
      for (const i of [i0, i1]) for (const k of [k0, k1]) Ly = Math.max(Ly, Math.abs(at(i, j1, k, c) - at(i, j0, k, c)));
      for (const i of [i0, i1]) for (const j of [j0, j1]) Lz = Math.max(Lz, Math.abs(at(i, j, k1, c) - at(i, j, k0, c)));
      dd[c] = Lx * dg[0] + Ly * dg[1] + Lz * dg[2];
      for (const i of [i0, i1]) for (const j of [j0, j1]) for (const k of [k0, k1]) dmax = Math.max(dmax, Math.abs(at(i, j, k, c)));
    }
    void g;
    const qn: Vec3 = [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
    const gD = gamma(OP_COUNTS.dvf) * dmax;
    dq = [
      dq[0] + dd[0] + gD + U32 * Math.abs(qn[0]),
      dq[1] + dd[1] + gD + U32 * Math.abs(qn[1]),
      dq[2] + dd[2] + gD + U32 * Math.abs(qn[2]),
    ];
    q = qn;
    const A = abs3(st.after.M);
    const aq = lin(A, [Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2])]);
    const ndq = lin(A, dq);
    dq = [
      ndq[0] + gA * (aq[0] + Math.abs(st.after.t[0])),
      ndq[1] + gA * (aq[1] + Math.abs(st.after.t[1])),
      ndq[2] + gA * (aq[2] + Math.abs(st.after.t[2])),
    ];
    q = lin(st.after.M, q, st.after.t);
  }
  return { u: q[0], v: q[1], w_mm: q[2], du: dq[0], dv: dq[1], dw: dq[2] };
}
