/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D の ROI の表示用メッシュ。体積を求めた形（`roiVolumeMesh`）と同じ「各スライスを実際の位置と幅で
 * 立ち上げた形」を、閉じた三角形の面で作る。純関数（`fw/slice-depth-policy.md` §4）。
 *
 * <p>前景の画素ごとの箱（列 × 行 × その層の奥行きの範囲）の、外に面した面だけを出す。
 * 1 枚だけの ROI も、そのスライスの幅の板になる（マーチングキューブ＋平滑化では紙のように薄くなっていた）。
 *
 * <p>座標は局所（列・行は画素の中心が index × 間隔、奥行き z は格子の先頭を 0 とした mm）。
 * 患者座標へは `roiMesh` が origin と direction で直す。
 */

export interface SlabRange {
  z0: number;
  z1: number;
}

/**
 * 層ごとの奥行きの範囲。
 * - `orig` が無い（均一な体積）: 層 k は k·s ± s/2。
 * - `orig` がある（補間した格子）: 元のスライス i の範囲は、前後のスライスとの中点まで（端は隣への距離の半分を外にも）。
 *   元のスライスでない層は、元のスライスの範囲に含まれるので null（ただし `fallbackFor` に入れた層は k·s ± s/2）。
 */
export function slabRanges(
  nz: number,
  s: number,
  orig?: { gridIndexOf: ReadonlyArray<number>; positions: ReadonlyArray<number> },
  fallbackFor?: ReadonlySet<number>,
): (SlabRange | null)[] {
  const uniform = (k: number): SlabRange => ({ z0: k * s - s / 2, z1: k * s + s / 2 });
  if (!orig || orig.gridIndexOf.length === 0) return Array.from({ length: nz }, (_, k) => uniform(k));
  const out: (SlabRange | null)[] = Array.from({ length: nz }, () => null);
  const p = orig.positions;
  const m = p.length;
  for (let i = 0; i < m; i++) {
    const k = orig.gridIndexOf[i];
    if (k < 0 || k >= nz) continue;
    if (m === 1) {
      out[k] = uniform(k);
      continue;
    }
    const lo = i === 0 ? p[0] - (p[1] - p[0]) / 2 : (p[i - 1] + p[i]) / 2;
    const hi = i === m - 1 ? p[m - 1] + (p[m - 1] - p[m - 2]) / 2 : (p[i] + p[i + 1]) / 2;
    out[k] = { z0: lo, z1: hi };
  }
  if (fallbackFor) for (const k of fallbackFor) if (k >= 0 && k < nz && !out[k]) out[k] = uniform(k);
  return out;
}

export interface SlabMeshResult {
  /** 頂点（局所座標 x, y, z の並び）。 */
  points: Float64Array;
  /** 三角形（頂点番号 3 つずつ）。外向きが表。 */
  triangles: Uint32Array;
}

const EPS = 1e-6;

/**
 * 塗りのラベル（nx × ny × nz、行優先・層ごと）から、閉じた面を作る。
 * `segment` を渡すとその番号だけ、省略すると 0 より大きい画素すべて。範囲が null の層は描かない。
 */
export function slabMesh(
  labels: ArrayLike<number>,
  dims: readonly [number, number, number],
  sx: number,
  sy: number,
  ranges: ReadonlyArray<SlabRange | null>,
  segment?: number,
): SlabMeshResult {
  const [nx, ny, nz] = dims;
  const fg = (x: number, y: number, k: number): boolean => {
    if (x < 0 || y < 0 || k < 0 || x >= nx || y >= ny || k >= nz || !ranges[k]) return false;
    const v = labels[k * nx * ny + y * nx + x];
    return segment === undefined ? v > 0 : v === segment;
  };
  // 範囲が接している隣の層（上下の面を出すかの判定に使う）。
  const below: number[][] = Array.from({ length: nz }, () => []);
  const above: number[][] = Array.from({ length: nz }, () => []);
  for (let a = 0; a < nz; a++) {
    const ra = ranges[a];
    if (!ra) continue;
    for (let b = 0; b < nz; b++) {
      const rb = ranges[b];
      if (!rb || a === b) continue;
      if (Math.abs(rb.z0 - ra.z1) <= EPS) above[a].push(b);
      if (Math.abs(rb.z1 - ra.z0) <= EPS) below[a].push(b);
    }
  }

  const pts: number[] = [];
  const tri: number[] = [];
  const index = new Map<string, number>();
  const vid = (x: number, y: number, z: number): number => {
    const key = `${x.toFixed(6)},${y.toFixed(6)},${z.toFixed(6)}`;
    let i = index.get(key);
    if (i === undefined) {
      i = pts.length / 3;
      pts.push(x, y, z);
      index.set(key, i);
    }
    return i;
  };
  // 四角形 a→b→c→d（外から見て反時計回り）を 2 つの三角形にする。
  const quad = (a: number, b: number, c: number, d: number) => tri.push(a, b, c, a, c, d);

  for (let k = 0; k < nz; k++) {
    const r = ranges[k];
    if (!r) continue;
    const { z0, z1 } = r;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (!fg(x, y, k)) continue;
        const x0 = (x - 0.5) * sx, x1 = (x + 0.5) * sx;
        const y0 = (y - 0.5) * sy, y1 = (y + 0.5) * sy;
        if (!fg(x - 1, y, k)) quad(vid(x0, y0, z0), vid(x0, y0, z1), vid(x0, y1, z1), vid(x0, y1, z0));
        if (!fg(x + 1, y, k)) quad(vid(x1, y0, z0), vid(x1, y1, z0), vid(x1, y1, z1), vid(x1, y0, z1));
        if (!fg(x, y - 1, k)) quad(vid(x0, y0, z0), vid(x1, y0, z0), vid(x1, y0, z1), vid(x0, y0, z1));
        if (!fg(x, y + 1, k)) quad(vid(x0, y1, z0), vid(x0, y1, z1), vid(x1, y1, z1), vid(x1, y1, z0));
        if (!below[k].some((b) => fg(x, y, b))) quad(vid(x0, y0, z0), vid(x0, y1, z0), vid(x1, y1, z0), vid(x1, y0, z0));
        if (!above[k].some((b) => fg(x, y, b))) quad(vid(x0, y0, z1), vid(x1, y0, z1), vid(x1, y1, z1), vid(x0, y1, z1));
      }
    }
  }
  return { points: Float64Array.from(pts), triangles: Uint32Array.from(tri) };
}

/** 閉じた面の体積（発散定理: 原点との符号付き四面体の和）。 */
export function closedMeshVolume(m: SlabMeshResult): number {
  const p = m.points, t = m.triangles;
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i] * 3, b = t[i + 1] * 3, c = t[i + 2] * 3;
    v +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}
