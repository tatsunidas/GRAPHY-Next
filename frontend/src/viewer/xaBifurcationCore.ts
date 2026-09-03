/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 分岐部の「核」を**幾何から**決める（`fw/angio-design.md` §21.4 の段 4）。
 *
 * <h3>なぜ要るのか — いまのカリーナは利用者が線を引き終えた場所である</h3>
 * 現行の `analyzeBifurcation` は **カリーナ ＝ 3 本の中心線のカリーナ側端点の重心**としている。
 * これは「利用者が 3 本の線をどこで描き終えたか」であって、**解剖学的な分岐の位置ではない**。
 * 実際に次の 2 つが起きている:
 *
 * - 端点がそろわないと `endpointsApart` で警告するしかない（**ずれない作りにできない**）
 * - **端点を触る改善が必ず幾何を壊す**——2026-09-02 に「カリーナ側の汚染された点を削る」を
 *   試したところ、削った端点でカリーナが動き、除外域も角度の窓も別の場所を指した（§21.4.0）
 *
 * <h3>ここでの定義 — 3 本に接する最大の内接球</h3>
 * 文献（EBC）の **POB は「3 本の輪郭に接する最大円の中心」**である。輪郭の一括検出は
 * 段 6 の仕事なので、ここでは**中心線と実測径から作る管**でそれを近似する:
 *
 * ```
 *   POB = argmax_p  min_i ( r_i(p) − d_i(p) )
 * ```
 *
 * `d_i(p)` は点 p から枝 i の中心線までの距離、`r_i(p)` はその最近点での半径。
 * 括弧の中は「枝 i の管の中にどれだけ余裕を持って入っているか」で、その **最小**を最大化する
 * ＝ **3 本すべての管に同時に入る最大の球**。この球は 3 本の壁に接する（＝どれかが束縛になる）ので、
 * 文献の「3 本の輪郭に接する最大円」と同じ考え方になる。
 *
 * 🔴 **`min` を `max` にしてはいけない。** `max_i` は「どれか 1 本の管の中で最も太いところ」を
 * 返すので、**母血管の真ん中**が答えになる。カリーナではない。
 *
 * <h3>🚨 交わらないときに嘘をつかない</h3>
 * 3 本が実際には交わっていない（利用者が短く引いた・別々の場所を引いた）とき、最大値は**負**になる。
 * そのときも「いちばんマシな点」は返るが、**それは分岐ではない**。`clearanceMm` が負であることを
 * 呼び出し側へ返し、**カリーナとして使わせない**。黙って最良点を返すと、
 * **どこにも無い分岐**を測ることになる（現行の重心方式が抱えている問題そのもの）。
 */
import type { Vec3 } from "./xaGeometry";

/** 中心線＋その点ごとの半径で表した枝。半径が取れない点は null。 */
export interface TubeBranch {
  id: string;
  points: readonly Vec3[];
  /** `points` と同じ長さ。半径 [mm]。 */
  radiiMm: readonly (number | null)[];
}

export interface PointOfBifurcation {
  /** 内接球の中心（患者 LPS mm）＝ POB の近似。 */
  point: Vec3;
  /** 内接球の半径 [mm]。**3 本すべてに入っている余裕**なので、これが核の大きさになる。 */
  radiusMm: number;
  /** 枝ごとの余裕 [mm]（`r_i − d_i`）。最小値が `radiusMm`。 */
  clearanceMm: { id: string; value: number }[];
  /**
   * 3 本が実際に交わっているか（`radiusMm > 0`）。
   * 🔴 **false のときは分岐として扱わない。**
   */
  overlapping: boolean;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * 点から折れ線への最短距離と、そこでの半径。
 *
 * <p>半径は線分上の位置で**線形内挿**する（端点の値をそのまま使うと、テーパーのある血管で
 * 段が付く）。半径が欠けている点は、その線分を半径の無いものとして扱わず、
 * **もう一方の端の値を使う**（片側だけでも内挿の代わりになる）。両方欠けていれば null。
 */
export function nearestOnTube(
  p: Vec3,
  branch: TubeBranch,
): { distanceMm: number; radiusMm: number | null; index: number; t: number } | null {
  const { points, radiiMm } = branch;
  if (points.length === 0) return null;
  let best = { distanceMm: Infinity, radiusMm: null as number | null, index: 0, t: 0 };
  if (points.length === 1) {
    return { distanceMm: dist(p, points[0]), radiusMm: radiiMm[0] ?? null, index: 0, t: 0 };
  }
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const ab = sub(b, a);
    const len2 = dot(ab, ab);
    // 同じ点が続く（間引きの結果）ときは線分として扱わない。
    const t = len2 > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / len2)) : 0;
    const q: Vec3 = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t];
    const d = dist(p, q);
    if (d < best.distanceMm) {
      const ra = radiiMm[i];
      const rb = radiiMm[i + 1];
      const r =
        ra != null && rb != null ? ra + (rb - ra) * t : ra != null ? ra : rb != null ? rb : null;
      best = { distanceMm: d, radiusMm: r, index: i, t };
    }
  }
  return best;
}

/** 点 p が 3 本すべての管に入っている余裕（最小値）。半径不明の枝は束縛にしない。 */
function clearance(p: Vec3, branches: readonly TubeBranch[]): { min: number; per: { id: string; value: number }[] } {
  const per: { id: string; value: number }[] = [];
  let min = Infinity;
  for (const b of branches) {
    const near = nearestOnTube(p, b);
    if (!near || near.radiusMm == null) continue;
    const v = near.radiusMm - near.distanceMm;
    per.push({ id: b.id, value: v });
    if (v < min) min = v;
  }
  return { min: per.length ? min : -Infinity, per };
}

/**
 * 探索の種。**端点は使わない**（それを使うのをやめるのがこの関数の目的）。
 *
 * <p>枝の 2 本ずつについて**互いに最も近い点の中点**を取り、3 組の平均を種にする。
 * 3 本が同じ場所へ集まっているなら、この点は必ず分岐の近くに来る。
 */
function seedPoint(branches: readonly TubeBranch[]): Vec3 | null {
  const mids: Vec3[] = [];
  for (let i = 0; i < branches.length; i++) {
    for (let j = i + 1; j < branches.length; j++) {
      let best = { d: Infinity, mid: null as Vec3 | null };
      for (const p of branches[i].points) {
        const near = nearestOnTube(p, branches[j]);
        if (!near) continue;
        if (near.distanceMm < best.d) {
          // 最近点そのものは持っていないので、p を種として使う（中点の代用として十分）。
          best = { d: near.distanceMm, mid: p };
        }
      }
      if (best.mid) mids.push(best.mid);
    }
  }
  if (!mids.length) return null;
  return [
    mids.reduce((s, m) => s + m[0], 0) / mids.length,
    mids.reduce((s, m) => s + m[1], 0) / mids.length,
    mids.reduce((s, m) => s + m[2], 0) / mids.length,
  ];
}

/**
 * 枝の両端を接線方向へ `mm` だけ延ばす。
 *
 * <h3>🔴 なぜ延ばすのか — 血管は「描くのをやめた場所」で終わっていない</h3>
 * 管を折れ線 ± 半径で表すと、**端の外側は球の帽子**になって急に細くなる。すると
 * **利用者がカリーナ手前で描き終えるほど内接球が小さくなり、位置まで動く**。
 * 実測: 端を 2mm 削ると POB が **0.60mm** 動いた（延長を入れる前）。
 * これでは「端点から幾何を決めるのをやめる」という目的を果たせない。
 *
 * <p>両端とも延ばす。**どちらがカリーナ側かは POB を決めるまで分からない**（それを決めるのが
 * この計算である）ので、先に片側だけ選ぶことはできない。遠位側へ延ばしても分岐の近くには
 * 来ないので害は無い。
 *
 * ⚠️ 延長は**測定には使わない**。あくまで「核の位置を決める」ためだけの補外であり、
 * ここで作った点の上で径を読んではいけない（実測が無い場所の値になる）。
 */
export function extendTube(branch: TubeBranch, mm: number): TubeBranch {
  const { points, radiiMm } = branch;
  if (points.length < 2 || mm <= 0) return branch;
  const along = (from: Vec3, to: Vec3): Vec3 | null => {
    const v = sub(to, from);
    const n = Math.hypot(v[0], v[1], v[2]);
    if (n < 1e-9) return null;
    return [to[0] + (v[0] / n) * mm, to[1] + (v[1] / n) * mm, to[2] + (v[2] / n) * mm];
  };
  const head = along(points[1], points[0]);
  const tail = along(points[points.length - 2], points[points.length - 1]);
  const outPts: Vec3[] = [];
  const outR: (number | null)[] = [];
  if (head) {
    outPts.push(head);
    outR.push(radiiMm[0] ?? null);
  }
  outPts.push(...points);
  outR.push(...radiiMm);
  if (tail) {
    outPts.push(tail);
    outR.push(radiiMm[radiiMm.length - 1] ?? null);
  }
  return { id: branch.id, points: outPts, radiiMm: outR };
}

const REFINE_STEPS: readonly Vec3[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/**
 * 3 本に同時に入る最大の球を探す（＝ POB の近似）。
 *
 * <p>目的関数は区分的に滑らかなだけで微分できる保証が無いので、**格子を縮めるパターン探索**で
 * 解く（勾配法は折れ線の最近点が切り替わる境目で暴れる）。初期歩幅は種のまわりの管の太さ、
 * 停止は 0.01mm ＝ **測っている量（mm 単位の径）より 2 桁細かい**ので、これ以上詰めても意味は無い。
 *
 * @param branches 3 本（近位・遠位・側枝）。順不同。
 */
export function findPointOfBifurcation(
  input: readonly TubeBranch[],
  opts: { initialStepMm?: number; minStepMm?: number; extensionMm?: number } = {},
): PointOfBifurcation | null {
  if (input.length < 3) return null;
  if (input.some((b) => b.points.length === 0)) return null;
  // 端を接線方向へ延ばしてから探す（`extendTube` の説明を参照）。
  const ext = opts.extensionMm ?? 5;
  const branches = input.map((b) => extendTube(b, ext));
  let p = seedPoint(branches);
  if (!p) return null;

  let step = opts.initialStepMm ?? 4;
  const minStep = opts.minStepMm ?? 0.01;
  let cur = clearance(p, branches);
  if (!Number.isFinite(cur.min)) return null;

  while (step >= minStep) {
    let improved = false;
    for (const d of REFINE_STEPS) {
      const q: Vec3 = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step];
      const c = clearance(q, branches);
      if (c.min > cur.min) {
        p = q;
        cur = c;
        improved = true;
      }
    }
    if (!improved) step /= 2;
  }

  return {
    point: p,
    radiusMm: cur.min,
    clearanceMm: cur.per,
    overlapping: cur.min > 0,
  };
}
