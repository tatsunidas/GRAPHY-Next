/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MIND-SSC 記述子（設計: `fw/registration-design.md` §5.3）。
 *
 * <p>`regGeometry` / `regMetrics` と同じく**純関数のみ**。DOM も cornerstone も import しない。
 *
 * <h3>なぜ記述子を使うのか</h3>
 *
 * <p>MIND-SSC は「その点のまわりで、近傍どうしがどれくらい似ているか」を並べたもの。
 * **画像の値そのものではなく局所構造の関係**を符号化するので、PET と CT のように
 * 強度の対応関係が単調ですらない組み合わせでも、記述子空間では単純な二乗差（SSD）で
 * 比較できる。非剛体の各制御点に MI を当てるより桁違いに安定かつ軽い。
 *
 * <h3>成立条件（性能最適化ではない）★</h3>
 *
 * <p>記述子は 12 チャンネル。`float32` で全解像度に持つと 512×512×300 で **3.8 GB** になり
 * 成立しない。**半解像度 ＋ `uint8` 量子化**が前提であり、設計 §5.3 は
 * 「実装時にまず float32 全解像度で書いて後で最適化する、をやると開発機で必ず落ちる」と
 * 明記している。本ファイルは最初からその形で書いてある。
 * `uint8` で十分なのは MIND が 0〜1 に正規化されるため。
 */

import { gaussianSmooth } from "./regGeometry";

/** 記述子のチャンネル数（SSC の 12 ペア）。 */
export const MIND_CHANNELS = 12;

/**
 * 6 近傍（±x, ±y, ±z）のうち**直交する**組み合わせ 12 通り。
 *
 * <p>SSC（Self-Similarity Context）は、中心と近傍の差ではなく
 * **近傍どうしの差**を使う。こうすると中心のノイズが全チャンネルに乗らず、
 * MIND より雑音に強い。対向する組（例 +x と −x）は構造情報が薄いので除く。
 */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/** 直交ペアの索引（`NEIGHBOURS` の添字）。 */
const PAIRS: ReadonlyArray<readonly [number, number]> = (() => {
  const out: [number, number][] = [];
  for (let a = 0; a < 6; a++) {
    for (let b = a + 1; b < 6; b++) {
      const na = NEIGHBOURS[a], nb = NEIGHBOURS[b];
      // 対向（和がゼロ）は除く。残りが直交ペアで、ちょうど 12 通りになる。
      if (na[0] + nb[0] === 0 && na[1] + nb[1] === 0 && na[2] + nb[2] === 0) continue;
      out.push([a, b]);
    }
  }
  return out;
})();

export interface MindDescriptors {
  /** `((k*ny + j)*nx + i) * MIND_CHANNELS + c` の順。0..255 に量子化済み。 */
  readonly data: Uint8Array;
  readonly dims: readonly [number, number, number];
}

/** 端を複製して読む（境界で記述子が壊れないように）。 */
function clampIndex(v: number, n: number): number {
  return v < 0 ? 0 : v >= n ? n - 1 : v;
}

/**
 * MIND-SSC 記述子を計算する。
 *
 * @param volume 入力（等方格子であること。ピラミッドの段をそのまま渡す想定）
 * @param dims [nx, ny, nz]
 * @param sigma 事前平滑の σ（ボクセル）。ノイズが記述子に乗るのを抑える。
 * @param delta 近傍までの距離（ボクセル）。設計の既定は 1。
 */
export function computeMindSsc(
  volume: Float32Array,
  dims: readonly [number, number, number],
  sigma = 0.8,
  delta = 1,
): MindDescriptors {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const src = sigma > 0 ? gaussianSmooth(volume, dims, [sigma, sigma, sigma]) : volume;

  // 各ペアの距離 D_k。float32 × 12 だが**入力解像度がすでに半分**である前提。
  // ここを全解像度で回すと設計 §5.3 の見積りどおり破綻する。
  const dist = new Float32Array(n * MIND_CHANNELS);

  // 箱型フィルタ（半径 1）で patch SSD にする。分離可能なので 3 回の 1 次元走査。
  const tmp = new Float32Array(n);
  const acc = new Float32Array(n);

  for (let p = 0; p < PAIRS.length; p++) {
    const [ia, ib] = PAIRS[p];
    const a = NEIGHBOURS[ia], b = NEIGHBOURS[ib];

    // (I(x+a) - I(x+b))^2
    let o = 0;
    for (let k = 0; k < nz; k++) {
      const ka = clampIndex(k + a[2] * delta, nz), kb = clampIndex(k + b[2] * delta, nz);
      for (let j = 0; j < ny; j++) {
        const ja = clampIndex(j + a[1] * delta, ny), jb = clampIndex(j + b[1] * delta, ny);
        const rowA = (ka * ny + ja) * nx, rowB = (kb * ny + jb) * nx;
        for (let i = 0; i < nx; i++) {
          const va = src[rowA + clampIndex(i + a[0] * delta, nx)];
          const vb = src[rowB + clampIndex(i + b[0] * delta, nx)];
          const d = va - vb;
          acc[o++] = d * d;
        }
      }
    }
    boxFilter3(acc, tmp, dims, 1);
    for (let x = 0; x < n; x++) dist[x * MIND_CHANNELS + p] = acc[x];
  }

  // 正規化と量子化。V(x) は 12 チャンネルの平均（局所分散の推定）。
  const out = new Uint8Array(n * MIND_CHANNELS);
  for (let x = 0; x < n; x++) {
    const base = x * MIND_CHANNELS;
    let mean = 0;
    for (let c = 0; c < MIND_CHANNELS; c++) mean += dist[base + c];
    mean /= MIND_CHANNELS;
    // 平坦な領域（空気など）では mean ≈ 0。ここで 0 割りすると全チャンネルが
    // 同じ値になり「どの向きにも等しく似ている」という無意味な記述子になる。
    // 下限を入れて、平坦な場所は素直に「全部似ている（=1）」に落とす。
    const v = mean > 1e-12 ? mean : 1e-12;
    let max = 0;
    for (let c = 0; c < MIND_CHANNELS; c++) {
      const e = Math.exp(-dist[base + c] / v);
      dist[base + c] = e;
      if (e > max) max = e;
    }
    const inv = max > 0 ? 255 / max : 0;
    for (let c = 0; c < MIND_CHANNELS; c++) {
      out[base + c] = Math.round(dist[base + c] * inv);
    }
  }
  return { data: out, dims };
}

/** 分離可能な箱型フィルタ（半径 r、端は複製）。`data` を書き換える。 */
function boxFilter3(
  data: Float32Array,
  tmp: Float32Array,
  dims: readonly [number, number, number],
  r: number,
): void {
  const [nx, ny, nz] = dims;
  const w = 2 * r + 1;

  // x
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      const row = (k * ny + j) * nx;
      for (let i = 0; i < nx; i++) {
        let s = 0;
        for (let t = -r; t <= r; t++) s += data[row + clampIndex(i + t, nx)];
        tmp[row + i] = s / w;
      }
    }
  }
  // y
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let s = 0;
        for (let t = -r; t <= r; t++) s += tmp[(k * ny + clampIndex(j + t, ny)) * nx + i];
        data[(k * ny + j) * nx + i] = s / w;
      }
    }
  }
  // z
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let s = 0;
        for (let t = -r; t <= r; t++) s += data[(clampIndex(k + t, nz) * ny + j) * nx + i];
        tmp[(k * ny + j) * nx + i] = s / w;
      }
    }
  }
  data.set(tmp);
}

/**
 * 2 点の記述子間の距離（L1）。`uint8` のまま整数演算で回す。
 *
 * <p>コストボリューム構築のホットループから制御点 × 変位候補の回数だけ呼ばれる。
 * ここを浮動小数にすると目に見えて遅くなる。
 */
export function descriptorDistance(a: Uint8Array, ao: number, b: Uint8Array, bo: number): number {
  let s = 0;
  for (let c = 0; c < MIND_CHANNELS; c++) {
    const d = a[ao + c] - b[bo + c];
    s += d < 0 ? -d : d;
  }
  return s;
}
