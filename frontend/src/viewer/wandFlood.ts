/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Wand のフラッド（シードからの連結領域）の芯。純関数で、Cornerstone に依存しない。
 *
 * - 判定に使う値は `read(z, idx)` が返す。どの方式も同じ「判定値」で判定する（{@link makeValueReader}）。
 * - 2D は `depth=1`・`seed.z=0` で呼び、`read` 側でシードスライスへ写す。返る index は `z*cols*rows + y*cols + x`。
 * - 上限に達して未処理の「条件を満たす候補」が残るときだけ `truncated` を立てる。
 */

export interface FloodDims {
  cols: number;
  rows: number;
  depth: number;
}
export interface FloodSeed {
  x: number;
  y: number;
  z: number;
}
export interface FloodResult {
  indices: number[];
  truncated: boolean;
  seedRejected: boolean;
}

/** 2D 近傍オフセット。4=辺, 8=辺＋角。 */
export function offsets2D(conn: number): [number, number][] {
  const four: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (conn === 4) return four;
  return [...four, [1, 1], [1, -1], [-1, 1], [-1, -1]];
}

/**
 * 3D 近傍オフセット。6=面(manh1)、12=面+辺(manh1,2)、8=面+角(manh1,3)、26=全て。
 * いずれも面(manh1)を必ず含める。面を含めない辺/角のみの近傍は、格子をパリティで2分割してしまい
 * （市松模様）、フラッド結果が網目状になる（`roiBooleanOps.ts` の `splitOffsets` と同様）。
 */
export function offsets3D(conn: number): [number, number, number][] {
  const all: { o: [number, number, number]; m: number }[] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        all.push({ o: [dx, dy, dz], m: Math.abs(dx) + Math.abs(dy) + Math.abs(dz) });
      }
  if (conn === 6) return all.filter((a) => a.m === 1).map((a) => a.o);
  if (conn === 12) return all.filter((a) => a.m === 1 || a.m === 2).map((a) => a.o);
  if (conn === 8) return all.filter((a) => a.m === 1 || a.m === 3).map((a) => a.o);
  return all.map((a) => a.o);
}

/**
 * 1 スライスの画素配列から「判定値」を読む関数を作る。
 * - 1 チャネル: `px*scale+offset`（`getModalityCalibration` の係数。Rescale のタグが無ければ {1,0} で保存値そのもの）。
 * - 3 チャネル以上（カラー）: 輝度（ITU-R BT.601。`readModalitySlice` と同じ式）。校正は掛けない。
 */
export function makeValueReader(px: ArrayLike<number>, comps: number, scale: number, offset: number): (i: number) => number {
  if (comps >= 3) {
    return (i) => {
      const o = i * comps;
      return 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
    };
  }
  return (i) => px[i] * scale + offset;
}

/** 許容差（|v − シード値| ≤ th）。 */
export const acceptTolerance = (seed: number, th: number) => (v: number) => Math.abs(v - seed) <= th;
/** v ≥ t（t を含む）。 */
export const acceptGe = (t: number) => (v: number) => v >= t;
/** v ≤ t（t を含む）。 */
export const acceptLe = (t: number) => (v: number) => v <= t;
/** 値の範囲判定（両端を含む）。範囲判定はここ 1 か所に置く。 */
export function inRange(v: number, lo: number, hi: number): boolean {
  return v >= lo && v <= hi;
}
export const acceptRange = (lo: number, hi: number) => (v: number) => inRange(v, lo, hi);

/**
 * シードから連結で広がる領域を返す（スタックで走査）。
 * @param read (z, idx) → 判定値。そのスライスが無ければ null（条件外として扱う）
 * @param offsets 近傍。要素は [dx, dy] または [dx, dy, dz]（2D は dz 省略）
 */
export function floodRegion(
  read: (z: number, idx: number) => number | null,
  dims: FloodDims,
  seed: FloodSeed,
  accept: (v: number) => boolean,
  offsets: ReadonlyArray<readonly number[]>,
  maxVoxels: number,
): FloodResult {
  const { cols, rows, depth } = dims;
  const sliceLen = cols * rows;
  const indices: number[] = [];
  const startG = seed.z * sliceLen + seed.y * cols + seed.x;
  const sv = read(seed.z, seed.y * cols + seed.x);
  if (sv === null || !accept(sv)) return { indices, truncated: false, seedRejected: true };

  const ok = (g: number): boolean => {
    const z = Math.floor(g / sliceLen);
    const v = read(z, g - z * sliceLen);
    return v !== null && accept(v);
  };

  const visited = new Set<number>([startG]);
  const stack: number[] = [startG];
  while (stack.length && indices.length < maxVoxels) {
    const g = stack.pop() as number;
    if (!ok(g)) continue;
    indices.push(g);
    const z = Math.floor(g / sliceLen);
    const rem = g - z * sliceLen;
    const y = Math.floor(rem / cols);
    const x = rem - y * cols;
    for (const o of offsets) {
      const nx = x + o[0];
      const ny = y + o[1];
      const nz = z + (o[2] ?? 0);
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || nz < 0 || nz >= depth) continue;
      const ng = nz * sliceLen + ny * cols + nx;
      if (!visited.has(ng)) {
        visited.add(ng);
        stack.push(ng);
      }
    }
  }
  // 上限で止まったときだけ、残りの候補に条件を満たすものがあるかを見る（尽きていれば打ち切りではない）。
  const truncated = indices.length >= maxVoxels && stack.some(ok);
  return { indices, truncated, seedRejected: false };
}
