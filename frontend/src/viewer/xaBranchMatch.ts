/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2 方向の**枝の対応づけと、位置ずれ（検出器面）の補正**を提案する純関数（GN-XA-001 P3a）。
 *
 * <p>方式は合成検証済みの原型（`fw/xa-auto-pairing-3-0-results.md` の M2-b / 3-0d）の移植:
 * 各枝を弧長で再標本化 → A の各サンプルの視線（深さ ±{@link BranchMatchOptions.depthBandMm}）を B 画像へ投影した線分と、
 * B のサンプル（位置ずれ δ を引いたもの）の LCSS（動的計画法）を両向きで取り、小さいほうを得点にする →
 * δ を粗く・精密に掃引して、枝ごとの最良の相手の得点の和が最大の δ を採る。
 *
 * <h3>補正は感度のある 1 方向だけ</h3>
 * 位置ずれの 2 成分のうち、エピポーラ線に**平行**な成分は画像から決まらない（原型の測定で確認済み）。
 * そこで補正するのは**エピポーラ線の法線方向（感度軸）の成分だけ**で、感度軸は幾何から求める（真値の点は要らない）。
 * 補正量が上限（{@link BranchMatchOptions.correctionCapPx}、**暫定の運用基準**）を超えたら**適用せず**警告する
 * （誤った幾何が大きな補正量として現れる、という原型の負例の検出）。
 *
 * <p>対応は**提案**で、採否は人が決める（`fw/xa-confirm-ui-design.md`）。1 本の A 枝に複数の A 枝が同じ B 枝を指すことがある
 * （原型と同じ。`manyToOne` の警告を付ける）。
 */
import { pixelToRay, projectToPixel, type Ray, type XaViewGeometry } from "./xaGeometry";

type P = readonly [number, number];

export interface MatchBranch {
  id: string;
  /** 画像 px（x, y）。 */
  pointsPx: readonly P[];
}

export interface BranchMatchOptions {
  /** エピポーラ線の深さ範囲（アイソセンタ ±）[mm]。視野の物理幅から導いた値（原型の 3-0d で ±100 → ±55）。 */
  depthBandMm?: number;
  /** LCSS で「同じ点」とみなす距離 [px]（既存の再投影許容と同じ 2 px）。 */
  tauPx?: number;
  /** 再標本化の弧長間隔 [px]。0 以下なら再標本化せず、渡された点列をそのまま使う（原型との照合用）。 */
  stepPx?: number;
  /** 粗い掃引の半幅・刻み [px]。 */
  coarse?: { half: number; step: number };
  /** 精密な掃引の半幅・刻み [px]。 */
  fine?: { half: number; step: number };
  /** 対応として採る最小の得点（LCSS のサンプル数）。 */
  minScore?: number;
  /** 補正量の上限 [px]。**暫定**（ユーザーが決める数値）。 */
  correctionCapPx?: number;
}

export const DEFAULT_BRANCH_MATCH: Required<BranchMatchOptions> = {
  depthBandMm: 55,
  tauPx: 2,
  stepPx: 3,
  coarse: { half: 30, step: 6 },
  fine: { half: 3, step: 1 },
  minScore: 5,
  correctionCapPx: 15,
};

export type PairingState = "proposed" | "confirmed" | "excluded";

export interface BranchPairing {
  aId: string;
  bId: string;
  /** LCSS の一致サンプル数（A→B と B→A の小さいほう）。 */
  score: number;
  /** score / A の枝のサンプル数。 */
  coverage: number;
  state: PairingState;
}

export type BranchMatchWarning = "correctionOverCap" | "manyToOne" | "noPairs";

export interface BranchMatchResult {
  status: "ok" | "noBranches";
  /** 推定した 2 成分の位置ずれ（B の観測 − 真）[px]。**平行成分は決まらない**ので参考値（適用しない）。 */
  rawShiftPx: [number, number];
  /** 感度軸（単位ベクトル。B 画像内。向きは x 成分が正になるよう固定）。 */
  sensitiveAxis: [number, number];
  /** 感度軸方向の位置ずれ [px]。 */
  sensitiveShiftPx: number;
  /** 適用する補正（B の観測から引く量）。上限を超えたら null。 */
  correctionPx: [number, number] | null;
  pairings: BranchPairing[];
  /** 提案された対応の一致サンプルでの、エピポーラ線までの距離の中央値 [px]（補正前・補正後）。 */
  residualBeforePx: number | null;
  residualAfterPx: number | null;
  warnings: BranchMatchWarning[];
  /** 得点が最大だった δ の候補数（粗い掃引 + 精密な掃引）。実行時間の目安。 */
  evaluatedShifts: number;
}

/* ------------------------------------------------------------------ */
/* 標本化と投影                                                         */
/* ------------------------------------------------------------------ */

/** 弧長 step 間隔の再標本化（始点から。終点は含めない）。 */
function resample(pts: readonly P[], step: number): [number, number][] {
  if (pts.length === 0) return [];
  if (!(step > 0)) return pts.map((p) => [p[0], p[1]]);
  const out: [number, number][] = [[pts[0][0], pts[0][1]]];
  let next = step;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const L = Math.hypot(dx, dy);
    while (L > 0 && acc + L >= next - 1e-9) {
      const t = (next - acc) / L;
      out.push([pts[i - 1][0] + dx * t, pts[i - 1][1] + dy * t]);
      next += step;
    }
    acc += L;
  }
  return out;
}

interface Packed {
  /** x, y 交互。 */
  pts: Float64Array;
  /** 枝ごとの開始サンプル添字（長さ n+1）。 */
  off: Int32Array;
}

function pack(branches: readonly (readonly P[])[]): Packed {
  const off = new Int32Array(branches.length + 1);
  for (let i = 0; i < branches.length; i++) off[i + 1] = off[i] + branches[i].length;
  const pts = new Float64Array(off[branches.length] * 2);
  let k = 0;
  for (const b of branches) for (const p of b) { pts[k++] = p[0]; pts[k++] = p[1]; }
  return { pts, off };
}

/** 画素 → 視線上の 2 点（アイソセンタ距離 ± depth）→ 相手画像の線分 [x0,y0,x1,y1]。 */
function epiSegment(px: number, py: number, from: XaViewGeometry, to: XaViewGeometry, depth: number): [number, number, number, number] | null {
  const r: Ray = pixelToRay([px, py], from);
  const at = (s: number): [number, number] | null =>
    projectToPixel([r.origin[0] + r.direction[0] * s, r.origin[1] + r.direction[1] * s, r.origin[2] + r.direction[2] * s], to);
  const p0 = at(from.sodMm - depth);
  const p1 = at(from.sodMm + depth);
  return p0 && p1 ? [p0[0], p0[1], p1[0], p1[1]] : null;
}

function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const L = dx * dx + dy * dy + 1e-12;
  let s = ((px - x0) * dx + (py - y0) * dy) / L;
  s = s < 0 ? 0 : s > 1 ? 1 : s;
  return Math.hypot(x0 + s * dx - px, y0 + s * dy - py);
}

/* ------------------------------------------------------------------ */
/* LCSS                                                                */
/* ------------------------------------------------------------------ */

/**
 * 線分列（segs の ns 本）と点列（pts の np 点。(sx, sy) を引いてから比べる）の LCSS の長さ。
 * `reversePts` で点列を逆向きにも当てる（枝の向きは不定）。
 */
function lcssLength(
  segs: Float64Array, s0: number, ns: number,
  pts: Float64Array, p0: number, np: number,
  sx: number, sy: number, tau: number, reversePts: boolean,
): number {
  let prev = new Int32Array(np + 1);
  let cur = new Int32Array(np + 1);
  for (let k = 0; k < ns; k++) {
    const si = (s0 + k) * 4;
    const x0 = segs[si], y0 = segs[si + 1], x1 = segs[si + 2], y1 = segs[si + 3];
    cur[0] = 0;
    for (let l = 0; l < np; l++) {
      const ll = reversePts ? np - 1 - l : l;
      const pi = (p0 + ll) * 2;
      const d = segDist(pts[pi] - sx, pts[pi + 1] - sy, x0, y0, x1, y1);
      let v = d <= tau ? prev[l] + 1 : 0;
      if (prev[l + 1] > v) v = prev[l + 1];
      if (cur[l] > v) v = cur[l];
      cur[l + 1] = v;
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[np];
}

/** 上と同じで、一致した (線分添字, 点添字) の対を返す（逆向きのときの点添字は元の向きの添字）。 */
function lcssTrace(
  segs: Float64Array, s0: number, ns: number,
  pts: Float64Array, p0: number, np: number,
  sx: number, sy: number, tau: number, reversePts: boolean,
): [number, number][] {
  const W = np + 1;
  const T = new Int32Array((ns + 1) * W);
  for (let k = 0; k < ns; k++) {
    const si = (s0 + k) * 4;
    const x0 = segs[si], y0 = segs[si + 1], x1 = segs[si + 2], y1 = segs[si + 3];
    for (let l = 0; l < np; l++) {
      const ll = reversePts ? np - 1 - l : l;
      const pi = (p0 + ll) * 2;
      const d = segDist(pts[pi] - sx, pts[pi + 1] - sy, x0, y0, x1, y1);
      let v = d <= tau ? T[k * W + l] + 1 : 0;
      if (T[k * W + l + 1] > v) v = T[k * W + l + 1];
      if (T[(k + 1) * W + l] > v) v = T[(k + 1) * W + l];
      T[(k + 1) * W + l + 1] = v;
    }
  }
  const out: [number, number][] = [];
  let k = ns, l = np;
  while (k > 0 && l > 0) {
    const cur = T[k * W + l];
    if (cur === T[(k - 1) * W + l]) k--;
    else if (cur === T[k * W + l - 1]) l--;
    else {
      out.push([k - 1, reversePts ? np - l : l - 1]);
      k--; l--;
    }
  }
  return out.reverse();
}

/* ------------------------------------------------------------------ */
/* 本体                                                                 */
/* ------------------------------------------------------------------ */

function grid(cx: number, cy: number, half: number, step: number): [number, number][] {
  const out: [number, number][] = [];
  const n = Math.round(half / step);
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) out.push([cx + i * step, cy + j * step]);
  return out;
}

/** 感度軸: A の視線の B 上のエピポーラ線の法線方向の 2 次モーメント行列の主固有ベクトル。 */
function sensitiveAxisOf(E: Float64Array, n: number): [number, number] {
  let mxx = 0, mxy = 0, myy = 0;
  for (let i = 0; i < n; i++) {
    const dx = E[i * 4 + 2] - E[i * 4];
    const dy = E[i * 4 + 3] - E[i * 4 + 1];
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) continue;
    const nx = -dy / L, ny = dx / L;
    mxx += nx * nx; mxy += nx * ny; myy += ny * ny;
  }
  // 2×2 対称行列の主固有ベクトル。
  const theta = 0.5 * Math.atan2(2 * mxy, mxx - myy);
  let ax = Math.cos(theta), ay = Math.sin(theta);
  if (ax < 0 || (Math.abs(ax) < 1e-12 && ay < 0)) { ax = -ax; ay = -ay; }
  return [ax, ay];
}

const medianOf = (v: number[]): number | null => {
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function matchBranches(
  gA: XaViewGeometry, gB: XaViewGeometry,
  branchesA: readonly MatchBranch[], branchesB: readonly MatchBranch[],
  options: BranchMatchOptions = {},
): BranchMatchResult {
  const o = { ...DEFAULT_BRANCH_MATCH, ...options };
  const empty: BranchMatchResult = {
    status: "noBranches", rawShiftPx: [0, 0], sensitiveAxis: [1, 0], sensitiveShiftPx: 0, correctionPx: null,
    pairings: [], residualBeforePx: null, residualAfterPx: null, warnings: [], evaluatedShifts: 0,
  };
  const rsA = branchesA.map((b) => resample(b.pointsPx, o.stepPx)).map((r, i) => ({ id: branchesA[i].id, pts: r })).filter((b) => b.pts.length >= 2);
  const rsB = branchesB.map((b) => resample(b.pointsPx, o.stepPx)).map((r, i) => ({ id: branchesB[i].id, pts: r })).filter((b) => b.pts.length >= 2);
  if (rsA.length === 0 || rsB.length === 0) return empty;
  const A = pack(rsA.map((b) => b.pts));
  const B = pack(rsB.map((b) => b.pts));
  const nA = A.off[rsA.length], nB = B.off[rsB.length];

  // A → B のエピポーラ線分（δ に依らない）。
  const E = new Float64Array(nA * 4);
  for (let i = 0; i < nA; i++) {
    const s = epiSegment(A.pts[i * 2], A.pts[i * 2 + 1], gA, gB, o.depthBandMm);
    if (!s) return empty;
    E.set(s, i * 4);
  }

  /** δ ごとの得点行列 S[i][j] = min(A→B, B→A)。 */
  const scoreAt = (sx: number, sy: number): Int32Array => {
    const S = new Int32Array(rsA.length * rsB.length);
    // B → A（B のサンプルから δ を引いた画素の視線を A へ）
    const Erev = new Float64Array(nB * 4);
    for (let l = 0; l < nB; l++) {
      const s = epiSegment(B.pts[l * 2] - sx, B.pts[l * 2 + 1] - sy, gB, gA, o.depthBandMm);
      if (!s) return S;
      Erev.set(s, l * 4);
    }
    for (let i = 0; i < rsA.length; i++) {
      const a0 = A.off[i], na = A.off[i + 1] - a0;
      for (let j = 0; j < rsB.length; j++) {
        const b0 = B.off[j], nb = B.off[j + 1] - b0;
        let s1 = 0;
        for (const rev of [false, true]) s1 = Math.max(s1, lcssLength(E, a0, na, B.pts, b0, nb, sx, sy, o.tauPx, rev));
        if (s1 === 0) continue;
        let s2 = 0;
        for (const rev of [false, true]) s2 = Math.max(s2, lcssLength(Erev, b0, nb, A.pts, a0, na, 0, 0, o.tauPx, rev));
        S[i * rsB.length + j] = Math.min(s1, s2);
      }
    }
    return S;
  };
  const total = (S: Int32Array): number => {
    let t = 0;
    for (let i = 0; i < rsA.length; i++) {
      let m = 0;
      for (let j = 0; j < rsB.length; j++) m = Math.max(m, S[i * rsB.length + j]);
      t += m;
    }
    return t;
  };

  let evaluated = 0;
  let best: { x: [number, number]; S: Int32Array; tot: number } | null = null;
  for (const x of grid(0, 0, o.coarse.half, o.coarse.step)) {
    const S = scoreAt(x[0], x[1]);
    evaluated++;
    const tot = total(S);
    if (!best || tot > best.tot) best = { x, S, tot };
  }
  const x0 = best!.x;
  best = null;
  for (const x of grid(x0[0], x0[1], o.fine.half, o.fine.step)) {
    const S = scoreAt(x[0], x[1]);
    evaluated++;
    const tot = total(S);
    if (!best || tot > best.tot) best = { x, S, tot };
  }
  const { x, S } = best!;

  // 対応: A の各枝の最良の相手。
  const warnings: BranchMatchWarning[] = [];
  const pairings: BranchPairing[] = [];
  const pairIdx: [number, number][] = [];
  for (let i = 0; i < rsA.length; i++) {
    let bj = 0, bs = -1;
    for (let j = 0; j < rsB.length; j++) if (S[i * rsB.length + j] > bs) { bs = S[i * rsB.length + j]; bj = j; }
    if (bs >= o.minScore) {
      pairings.push({ aId: rsA[i].id, bId: rsB[bj].id, score: bs, coverage: bs / rsA[i].pts.length, state: "proposed" });
      pairIdx.push([i, bj]);
    }
  }
  if (pairings.length === 0) warnings.push("noPairs");
  if (new Set(pairings.map((p) => p.bId)).size < pairings.length) warnings.push("manyToOne");

  // 感度軸と補正。
  const axis = sensitiveAxisOf(E, nA);
  const c = x[0] * axis[0] + x[1] * axis[1];
  const over = Math.abs(c) > o.correctionCapPx;
  if (over) warnings.push("correctionOverCap");
  const correction: [number, number] | null = over ? null : [axis[0] * c, axis[1] * c];

  // 補正前後の残差（提案された対応の一致サンプルでの、エピポーラ線までの距離の中央値）。
  const before: number[] = [];
  const after: number[] = [];
  for (const [i, j] of pairIdx) {
    const a0 = A.off[i], na = A.off[i + 1] - a0;
    const b0 = B.off[j], nb = B.off[j + 1] - b0;
    let bestM: [number, number][] = [];
    for (const rev of [false, true]) {
      const m = lcssTrace(E, a0, na, B.pts, b0, nb, x[0], x[1], o.tauPx, rev);
      if (m.length > bestM.length) bestM = m;
    }
    for (const [k, l] of bestM) {
      const si = (a0 + k) * 4;
      const pi = (b0 + l) * 2;
      before.push(segDist(B.pts[pi], B.pts[pi + 1], E[si], E[si + 1], E[si + 2], E[si + 3]));
      const cx = correction ? correction[0] : 0, cy = correction ? correction[1] : 0;
      after.push(segDist(B.pts[pi] - cx, B.pts[pi + 1] - cy, E[si], E[si + 1], E[si + 2], E[si + 3]));
    }
  }

  return {
    status: "ok",
    rawShiftPx: [x[0], x[1]],
    sensitiveAxis: axis,
    sensitiveShiftPx: c,
    correctionPx: correction,
    pairings,
    residualBeforePx: medianOf(before),
    residualAfterPx: medianOf(after),
    warnings,
    evaluatedShifts: evaluated,
  };
}
