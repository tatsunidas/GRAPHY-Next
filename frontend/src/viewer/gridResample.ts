/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 格子の再サンプル（設計: `fw/volume-regrid-design.md`）。
 *
 * <p>**cornerstone に依存しない純関数のみ**（`regGeometry` と同じ方針）。患者 LPS mm の単一幾何で完結する。
 * プラグイン host API のリサンプル（`plugins/pluginResample.ts`）も、ここへ委譲して答えを 1 つにする。
 */
import { sampleTrilinear, sampleWorld, type RegVolume } from "./regGeometry";
import type { WorldTransform } from "./regTransform";

/** 出力格子（データを持たない {@link RegVolume}）。direction は正規直交。 */
export interface Grid {
  readonly dims: readonly [number, number, number];
  /** [列方向, 行方向, スライス方向] の間隔 [mm]。 */
  readonly spacing: readonly [number, number, number];
  readonly indexToWorld: ArrayLike<number>;
  readonly worldToIndex: ArrayLike<number>;
}

type V3 = [number, number, number];

function unit(x: number, y: number, z: number): V3 {
  const n = Math.hypot(x, y, z);
  if (!(n > 0)) throw new Error("degenerate source geometry");
  return [x / n, y / n, z / n];
}

function checkSpacing(s: number, name: string): void {
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) {
    throw new Error(`invalid spacing (${name}): ${s}`);
  }
}

/** 軸の長さ L [mm] と間隔 s から点数。末尾が元の範囲を超えないよう内側に収める。 */
function axisCount(length: number, s: number): number {
  return Math.floor(Math.max(0, length) / s + 1e-9) + 1;
}

/**
 * 元と同じ向き（列・行方向と、その外積の法線）で、軸ごとの間隔 `[列方向, 行方向, スライス方向]` の格子を作る。
 * 原点は元の先頭ボクセル中心。ガントリチルトの元は法線方向へ直交化される。
 */
export function axisGrid(src: RegVolume, spacing: readonly [number, number, number]): Grid {
  checkSpacing(spacing[0], "column");
  checkSpacing(spacing[1], "row");
  checkSpacing(spacing[2], "slice");
  const m = src.indexToWorld;
  const colDir = unit(m[0], m[4], m[8]);
  const rowDir = unit(m[1], m[5], m[9]);
  // 法線 = 列方向 × 行方向（`loadRegVolume` と同じ。IOP 先頭 3 要素 × 後ろ 3 要素）
  const normal: V3 = [
    colDir[1] * rowDir[2] - colDir[2] * rowDir[1],
    colDir[2] * rowDir[0] - colDir[0] * rowDir[2],
    colDir[0] * rowDir[1] - colDir[1] * rowDir[0],
  ];
  const [nx, ny, nz] = src.dims;
  const lenCol = (nx - 1) * Math.hypot(m[0], m[4], m[8]);
  const lenRow = (ny - 1) * Math.hypot(m[1], m[5], m[9]);
  // 先頭〜末尾の IPP 差を法線へ射影（チルトでも法線方向の長さを使う）
  const lenSlice = (nz - 1) * (m[2] * normal[0] + m[6] * normal[1] + m[10] * normal[2]);
  const dims: [number, number, number] = [
    axisCount(lenCol, spacing[0]),
    axisCount(lenRow, spacing[1]),
    axisCount(lenSlice, spacing[2]),
  ];
  const o: V3 = [m[3], m[7], m[11]];
  const i2w = new Float64Array(16);
  const dirs: V3[] = [colDir, rowDir, normal];
  for (let a = 0; a < 3; a++) {
    for (let r = 0; r < 3; r++) i2w[r * 4 + a] = dirs[a][r] * spacing[a];
  }
  i2w[3] = o[0]; i2w[7] = o[1]; i2w[11] = o[2]; i2w[15] = 1;
  // 正規直交なので逆は転置 / 間隔
  const w2i = new Float64Array(16);
  for (let a = 0; a < 3; a++) {
    for (let r = 0; r < 3; r++) w2i[a * 4 + r] = dirs[a][r] / spacing[a];
    w2i[a * 4 + 3] = -(dirs[a][0] * o[0] + dirs[a][1] * o[1] + dirs[a][2] * o[2]) / spacing[a];
  }
  w2i[15] = 1;
  return { dims, spacing: [spacing[0], spacing[1], spacing[2]], indexToWorld: i2w, worldToIndex: w2i };
}

/** 等方間隔 `s` mm の格子。 */
export function isotropicGrid(src: RegVolume, s: number): Grid {
  return axisGrid(src, [s, s, s]);
}

/**
 * `src` を `grid` へ再サンプルする（線形補間）。変換は fixed(grid) world → moving(src) world（pull-back）。
 * 範囲外は `NaN`（0 で埋めない）。
 *
 * @param edgeTolerance 元の範囲の縁から **この voxel 数以内**の外れは縁へ寄せて採る（既定 0 ＝従来どおり）。
 *   元の先頭・末尾のボクセル中心ちょうどに載る格子点は、index→world→index の往復で ±1e-15 ほど外れ、
 *   `sampleTrilinear` が NaN を返す。**範囲内の格子で縁が NaN になるのを防ぐ**ための許容（1e-6 程度）。
 */
export function resampleToGrid(
  src: RegVolume,
  transform: WorldTransform | null,
  grid: Grid,
  edgeTolerance = 0,
): Float32Array {
  const [nx, ny, nz] = grid.dims;
  const out = new Float32Array(nx * ny * nz);
  const m = grid.indexToWorld;
  const p: [number, number, number] = [0, 0, 0];
  const w = src.worldToIndex;
  const [sx, sy, sz] = src.dims;
  const snap = (v: number, n: number) =>
    v < 0 && v >= -edgeTolerance ? 0 : v > n - 1 && v <= n - 1 + edgeTolerance ? n - 1 : v;
  const sample = (x: number, y: number, z: number): number => {
    if (edgeTolerance <= 0) return sampleWorld(src, x, y, z);
    return sampleTrilinear(
      src,
      snap(w[0] * x + w[1] * y + w[2] * z + w[3], sx),
      snap(w[4] * x + w[5] * y + w[6] * z + w[7], sy),
      snap(w[8] * x + w[9] * y + w[10] * z + w[11], sz),
    );
  };
  let o = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = m[0] * i + m[1] * j + m[2] * k + m[3];
        const y = m[4] * i + m[5] * j + m[6] * k + m[7];
        const z = m[8] * i + m[9] * j + m[10] * k + m[11];
        if (transform) {
          transform.mapPoint(x, y, z, p);
          out[o++] = sample(p[0], p[1], p[2]);
        } else {
          out[o++] = sample(x, y, z);
        }
      }
    }
  }
  return out;
}

/** 再格子化（保存）で使う縁の許容 [voxel]。 */
export const GRID_EDGE_TOLERANCE = 1e-6;

/** 出力（Float32）のバイト数。 */
export function estimateGridBytes(grid: Pick<Grid, "dims">): number {
  return grid.dims[0] * grid.dims[1] * grid.dims[2] * 4;
}
