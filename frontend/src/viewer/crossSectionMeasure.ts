/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 血管の断面（中心線に直交する 2D 格子上の 2 値マスク）の幾何計測。純関数。
 *
 * <p>格子は一辺 `n`（奇数）の正方で、中心セル `(c, c)`（`c = (n-1)/2`）が中心線上の点。1 セルの一辺が `stepMm`。
 * 数えるのは**中心セルを含む 4 連結成分だけ**——隣り合う別の血管・静脈・石灰化が同じ断面に入っても、
 * 中心線の血管の径に混ぜない。
 *
 * <p>値の意味（HU・造影濃度）は解釈しない。2 値マスクの形だけを測る。
 */
import { convexHull, type PointPx } from "./roiRead";

export interface CrossSectionMeasure {
  /** 中心セルが前景か。偽なら他の値はすべて null（外れた中心線を、近くの別の構造の径で埋めない）。 */
  centerInMask: boolean;
  /** 中心を含む成分が格子の縁に触れた。真なら他の値はすべて null（走査半径が足りず、成分が切れている）。 */
  touchesBoundary: boolean;
  areaMm2: number | null;
  /** 面積と同じ円の直径 `2√(A/π)`。 */
  equivalentDiameterMm: number | null;
  /** 全方位の最小幅（最小 Feret 径）。セルの角の凸包に対する回転キャリパ。 */
  minWidthMm: number | null;
}

const NULLS = { areaMm2: null, equivalentDiameterMm: null, minWidthMm: null } as const;

/** 凸包の最小幅: 各辺について最遠の頂点までの距離を取り、その最小。 */
export function minWidthOfHull(hull: ReadonlyArray<PointPx>): number {
  const n = hull.length;
  if (n < 3) return 0;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % n];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len === 0) continue;
    let far = 0;
    for (let k = 0; k < n; k++) {
      const d = Math.abs(ex * (hull[k][1] - a[1]) - ey * (hull[k][0] - a[0])) / len;
      if (d > far) far = d;
    }
    if (far < best) best = far;
  }
  return Number.isFinite(best) ? best : 0;
}

export function measureCrossSection(grid: Uint8Array, n: number, stepMm: number): CrossSectionMeasure {
  const c = (n - 1) / 2;
  if (grid[c * n + c] === 0) return { centerInMask: false, touchesBoundary: false, ...NULLS };

  const seen = new Uint8Array(n * n);
  const stack: number[] = [c * n + c];
  seen[c * n + c] = 1;
  const cells: number[] = [];
  let touches = false;
  while (stack.length) {
    const g = stack.pop() as number;
    cells.push(g);
    const y = Math.floor(g / n);
    const x = g - y * n;
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) touches = true;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const ng = ny * n + nx;
      if (seen[ng] || grid[ng] === 0) continue;
      seen[ng] = 1;
      stack.push(ng);
    }
  }
  if (touches) return { centerInMask: true, touchesBoundary: true, ...NULLS };

  const areaMm2 = cells.length * stepMm * stepMm;
  // 凸包は成分の外周セルの角だけで足りる（内部のセルは包に効かない）。
  const half = stepMm / 2;
  const corners: PointPx[] = [];
  for (const g of cells) {
    const y = Math.floor(g / n);
    const x = g - y * n;
    const inner =
      seen[g - 1] === 1 && seen[g + 1] === 1 && seen[g - n] === 1 && seen[g + n] === 1; // 縁に触れない成分なので添字は範囲内
    if (inner) continue;
    const u = (x - c) * stepMm;
    const v = (y - c) * stepMm;
    corners.push([u - half, v - half], [u + half, v - half], [u - half, v + half], [u + half, v + half]);
  }
  return {
    centerInMask: true,
    touchesBoundary: false,
    areaMm2,
    equivalentDiameterMm: 2 * Math.sqrt(areaMm2 / Math.PI),
    minWidthMm: minWidthOfHull(convexHull(corners)),
  };
}
