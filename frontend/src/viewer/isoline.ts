/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 等値線（等高線）の抽出（純関数・DOM も cornerstone も import しない）。
 *
 * <p>Fusion の前景は `computeFusionSlice` が背景スライスの画素格子に載せた物理値
 * （前景の範囲外は NaN）になっている。等値線はその配列から marching squares で取る。
 * 状態バーの値・描画・等値線が同じ 1 本の配列を見るので、三者は必ず一致する。
 *
 * <p>座標は背景格子の連続 index（画素中心 = 整数、左上の画素中心が (0,0)）。mm への写像は
 * {@link isolineToWorld} だけが行い、描画と入出力の薄い層に index を閉じ込める。
 */
import type { BackgroundSliceMeta } from "./fusionEngine";
import type { Vec3 } from "./regTransform";

export interface Isoline {
  /** x0,y0,x1,y1,… 背景格子の連続 index。閉曲線でも始点を末尾に重ねない。 */
  points: Float32Array;
  closed: boolean;
}

/** 値 a（画素 A）と b（画素 B）の間で等値 level をとる位置の割合 t∈(0,1)。 */
export type EdgeInterp = (a: number, b: number, level: number) => number;

const linearInterp: EdgeInterp = (a, b, level) => (level - a) / (b - a);

/**
 * `values`（cols×rows、行優先）の等値 level の線を求める。
 *
 * <p>NaN を 1 つでも含むセルには線を出さない（前景の範囲外の縁に偽の輪郭を作らないため）。
 * 画素値が level 以上を「内」とする。両義セル（鞍点）は 4 隅の平均で接続を決める。
 *
 * @param interp 辺上の交点位置。既定は線形補間。検査器の識別力を確かめるために差し替えられる。
 */
export function extractIsolines(
  values: ArrayLike<number>,
  cols: number,
  rows: number,
  level: number,
  interp: EdgeInterp = linearInterp,
): Isoline[] {
  if (!(cols >= 2 && rows >= 2) || !Number.isFinite(level)) return [];
  // 辺 ID: 水平辺 (x,y)-(x+1,y) = 2*(y*cols+x)、垂直辺 (x,y)-(x,y+1) = 2*(y*cols+x)+1。
  const hEdge = (x: number, y: number) => 2 * (y * cols + x);
  const vEdge = (x: number, y: number) => 2 * (y * cols + x) + 1;

  const segs: number[] = []; // [edgeA, edgeB, ...]
  for (let y = 0; y < rows - 1; y++) {
    for (let x = 0; x < cols - 1; x++) {
      const v00 = values[y * cols + x];
      const v10 = values[y * cols + x + 1];
      const v01 = values[(y + 1) * cols + x];
      const v11 = values[(y + 1) * cols + x + 1];
      if (Number.isNaN(v00) || Number.isNaN(v10) || Number.isNaN(v01) || Number.isNaN(v11)) continue;
      const idx = (v00 >= level ? 1 : 0) | (v10 >= level ? 2 : 0) | (v11 >= level ? 4 : 0) | (v01 >= level ? 8 : 0);
      if (idx === 0 || idx === 15) continue;
      const T = hEdge(x, y);
      const B = hEdge(x, y + 1);
      const L = vEdge(x, y);
      const R = vEdge(x + 1, y);
      switch (idx) {
        case 1: case 14: segs.push(L, T); break;
        case 2: case 13: segs.push(T, R); break;
        case 3: case 12: segs.push(L, R); break;
        case 4: case 11: segs.push(R, B); break;
        case 6: case 9: segs.push(T, B); break;
        case 7: case 8: segs.push(L, B); break;
        case 5: // 00 と 11 が内
        case 10: { // 10 と 01 が内
          const centerInside = (v00 + v10 + v01 + v11) / 4 >= level;
          // idx 5 で中心が内 → 外の 2 隅（10・01）が孤立。idx 10 で中心が内 → 外の 2 隅（00・11）が孤立。
          const isolateOutside = centerInside;
          const around00and11 = idx === 5 ? !isolateOutside : isolateOutside;
          if (around00and11) segs.push(L, T, R, B);
          else segs.push(T, R, L, B);
          break;
        }
      }
    }
  }
  if (segs.length === 0) return [];

  // 辺 → その辺を端にもつ線分
  const nSeg = segs.length / 2;
  const adj = new Map<number, number[]>();
  for (let s = 0; s < nSeg; s++) {
    for (const e of [segs[2 * s], segs[2 * s + 1]]) {
      const a = adj.get(e);
      if (a) a.push(s);
      else adj.set(e, [s]);
    }
  }
  const used = new Uint8Array(nSeg);
  const otherEnd = (s: number, e: number) => (segs[2 * s] === e ? segs[2 * s + 1] : segs[2 * s]);
  const nextSeg = (e: number): number => {
    for (const s of adj.get(e) ?? []) if (!used[s]) return s;
    return -1;
  };

  const point = (e: number, out: number[]) => {
    const cell = e >> 1;
    const x = cell % cols;
    const y = (cell - x) / cols;
    if ((e & 1) === 0) {
      const t = interp(values[y * cols + x], values[y * cols + x + 1], level);
      out.push(x + t, y);
    } else {
      const t = interp(values[y * cols + x], values[(y + 1) * cols + x], level);
      out.push(x, y + t);
    }
  };

  const lines: Isoline[] = [];
  for (let s0 = 0; s0 < nSeg; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const chain: number[] = [segs[2 * s0], segs[2 * s0 + 1]];
    let closed = false;
    for (;;) { // 末尾へ延ばす
      const last = chain[chain.length - 1];
      const s = nextSeg(last);
      if (s < 0) break;
      used[s] = 1;
      const e = otherEnd(s, last);
      if (e === chain[0]) { closed = true; break; }
      chain.push(e);
    }
    if (!closed) {
      for (;;) { // 始点側へ延ばす
        const first = chain[0];
        const s = nextSeg(first);
        if (s < 0) break;
        used[s] = 1;
        chain.unshift(otherEnd(s, first));
      }
    }
    const pts: number[] = [];
    for (const e of chain) point(e, pts);
    lines.push({ points: Float32Array.from(pts), closed });
  }
  return lines;
}

/**
 * index 座標の線を LPS mm へ写す（検証と将来の書き出し用）。
 * `computeFusionSlice` が背景画素 (列 bx, 行 by) を world に置く式と同じ:
 * world = ipp + bx·pixelSpacingCol·iop[0..2] + by·pixelSpacingRow·iop[3..5]。
 */
export function isolineToWorld(lines: readonly Isoline[], bg: BackgroundSliceMeta): Vec3[][] {
  const { iop, ipp, pixelSpacingCol, pixelSpacingRow } = bg;
  return lines.map((ln) => {
    const out: Vec3[] = [];
    for (let i = 0; i < ln.points.length; i += 2) {
      const u = ln.points[i] * pixelSpacingCol;
      const v = ln.points[i + 1] * pixelSpacingRow;
      out.push([
        ipp[0] + u * iop[0] + v * iop[3],
        ipp[1] + u * iop[1] + v * iop[4],
        ipp[2] + u * iop[2] + v * iop[5],
      ]);
    }
    return out;
  });
}

/** SVG path の d 属性（index 座標のまま）。 */
export function isolinesToPath(lines: readonly Isoline[]): string {
  const parts: string[] = [];
  for (const ln of lines) {
    const p = ln.points;
    if (p.length < 4) continue;
    let d = `M${p[0]} ${p[1]}`;
    for (let i = 2; i < p.length; i += 2) d += `L${p[i]} ${p[i + 1]}`;
    parts.push(ln.closed ? d + "Z" : d);
  }
  return parts.join("");
}
