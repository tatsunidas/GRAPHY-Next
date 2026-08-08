/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * レジストレーションの幾何とピラミッド（設計: `fw/registration-design.md` §5.2 / §7）。
 *
 * <p>`regTransform.ts` と同じく**純関数のみ**。DOM も cornerstone も import しない
 * （node の vitest からブラウザ無しで動かせる状態を保つ。`fw/registration-design.md` §11）。
 *
 * <h3>なぜ自前のボリューム型を持つのか</h3>
 *
 * <p>Cornerstone3D の 3D ジオメトリには既知のバグがあり、確定計算は患者 LPS mm の
 * 自前・単一幾何で完結させる方針になっている（`fw/cornerstone-3d-geometry-caveat.md`、
 * `CLAUDE.md` 絶対ルール 3）。レジストレーションは幾何そのものを推定する処理なので、
 * ここで借り物の幾何を使うと**何を推定したのかが定義できなくなる**。
 * {@link RegVolume} は index→world の 4×4 を自分で持ち、斜め（oblique）でも
 * 異方性でもそのまま扱える。
 */

import type { Vec3 } from "./regTransform";

/**
 * レジストレーション用のボリューム。
 *
 * <p>データは `data[k * ny * nx + j * nx + i]`（i=列, j=行, k=スライス）。
 * これは DICOM の 1 スライスをそのまま並べた順で、`fusionEngine` の扱いとも一致する。
 */
export interface RegVolume {
  readonly data: Float32Array;
  /** [nx, ny, nz] = [columns, rows, slices]。 */
  readonly dims: readonly [number, number, number];
  /** index (i,j,k,1) → 患者 LPS mm。row-major 4×4。 */
  readonly indexToWorld: Float64Array;
  /** world → index。`indexToWorld` の逆行列（毎ボクセル使うので持っておく）。 */
  readonly worldToIndex: Float64Array;
  /** 各軸方向の実効間隔 [mm]（列方向・行方向・スライス方向）。ピラミッドの σ 決定に使う。 */
  readonly spacing: readonly [number, number, number];
}

// ── 4×4 ユーティリティ（regTransform と同じ row-major 規約） ───────────────

function mat4Identity(): Float64Array {
  const m = new Float64Array(16);
  m[0] = 1; m[5] = 1; m[10] = 1; m[15] = 1;
  return m;
}

/**
 * アフィン 4×4 の逆行列。
 *
 * <p>`regTransform.mat4InvertAffine` と同じ計算だが、あちらは変換モデルの API であり
 * 特異なら `null` を返して描画を止めない契約になっている。こちらは**幾何の構築時**に
 * 一度だけ使うもので、特異な index→world は入力データが壊れているということなので
 * 例外にする。片方の契約をもう片方に持ち込まないため、意図して分けてある。
 */
function invertAffine(m: Float64Array): Float64Array {
  const a = m[0], b = m[1], c = m[2];
  const d = m[4], e = m[5], f = m[6];
  const g = m[8], h = m[9], i = m[10];

  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) {
    throw new Error("regGeometry: index→world が特異（ボリュームの幾何が壊れている）");
  }
  const inv = 1 / det;
  const r00 = A * inv;
  const r01 = -(b * i - c * h) * inv;
  const r02 = (b * f - c * e) * inv;
  const r10 = B * inv;
  const r11 = (a * i - c * g) * inv;
  const r12 = -(a * f - c * d) * inv;
  const r20 = C * inv;
  const r21 = -(a * h - b * g) * inv;
  const r22 = (a * e - b * d) * inv;

  const tx = m[3], ty = m[7], tz = m[11];
  const out = new Float64Array(16);
  out[0] = r00; out[1] = r01; out[2] = r02; out[3] = -(r00 * tx + r01 * ty + r02 * tz);
  out[4] = r10; out[5] = r11; out[6] = r12; out[7] = -(r10 * tx + r11 * ty + r12 * tz);
  out[8] = r20; out[9] = r21; out[10] = r22; out[11] = -(r20 * tx + r21 * ty + r22 * tz);
  out[15] = 1;
  return out;
}

/** 点に 4×4 を適用して `out` に書く（割り付けを避けるため out 引数）。 */
export function applyMat4(m: Float64Array, x: number, y: number, z: number, out: Vec3): void {
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}

// ── 構築 ─────────────────────────────────────────────────────────────────

/**
 * DICOM の幾何（IOP / IPP / PixelSpacing）からボリュームを組む。
 *
 * @param iop ImageOrientationPatient（[行方向 3, 列方向 3]。DICOM の並びそのまま）
 * @param ipp0 先頭スライスの ImagePositionPatient
 * @param pixelSpacingCol 列が 1 進むときの移動量 [mm]（＝ iop[0..2] 方向）
 * @param pixelSpacingRow 行が 1 進むときの移動量 [mm]（＝ iop[3..5] 方向）
 * @param sliceStep スライスが 1 進むときの移動ベクトル [mm]。**法線 × 間隔ではなく実測の
 *   IPP 差を渡すこと**。ギャップや傾きのあるスタックで法線から作ると z がずれる。
 */
export function makeVolume(
  data: Float32Array,
  dims: readonly [number, number, number],
  iop: readonly number[],
  ipp0: Vec3,
  pixelSpacingCol: number,
  pixelSpacingRow: number,
  sliceStep: Vec3,
): RegVolume {
  const [nx, ny, nz] = dims;
  if (data.length !== nx * ny * nz) {
    throw new Error(`regGeometry: データ長 ${data.length} が dims ${nx}x${ny}x${nz} と合わない`);
  }
  const rc: Vec3 = [iop[0], iop[1], iop[2]]; // 列が進む向き
  const rr: Vec3 = [iop[3], iop[4], iop[5]]; // 行が進む向き

  const m = mat4Identity();
  m[0] = rc[0] * pixelSpacingCol; m[1] = rr[0] * pixelSpacingRow; m[2] = sliceStep[0]; m[3] = ipp0[0];
  m[4] = rc[1] * pixelSpacingCol; m[5] = rr[1] * pixelSpacingRow; m[6] = sliceStep[1]; m[7] = ipp0[1];
  m[8] = rc[2] * pixelSpacingCol; m[9] = rr[2] * pixelSpacingRow; m[10] = sliceStep[2]; m[11] = ipp0[2];

  const sliceSpacing = Math.hypot(sliceStep[0], sliceStep[1], sliceStep[2]);
  return {
    data,
    dims,
    indexToWorld: m,
    worldToIndex: invertAffine(m),
    spacing: [pixelSpacingCol, pixelSpacingRow, sliceSpacing],
  };
}

// ── サンプリング ─────────────────────────────────────────────────────────

/**
 * index 座標での trilinear 補間。範囲外は `NaN`。
 *
 * <p>**範囲外を 0 で埋めない**。0 は CT では水よりずっと低い実在の値で、
 * 埋めると「視野の外」と「空気」が区別できなくなり、類似度が視野の重なりに
 * 引きずられる（既存 Fusion の規約とも揃えてある。設計 §8.1 / §13-7）。
 */
export function sampleTrilinear(vol: RegVolume, i: number, j: number, k: number): number {
  const [nx, ny, nz] = vol.dims;
  if (i < 0 || j < 0 || k < 0 || i > nx - 1 || j > ny - 1 || k > nz - 1) return NaN;

  const i0 = Math.floor(i), j0 = Math.floor(j), k0 = Math.floor(k);
  const i1 = i0 + 1 < nx ? i0 + 1 : i0;
  const j1 = j0 + 1 < ny ? j0 + 1 : j0;
  const k1 = k0 + 1 < nz ? k0 + 1 : k0;
  const fi = i - i0, fj = j - j0, fk = k - k0;

  const d = vol.data;
  const sxy = nx * ny;
  const o00 = k0 * sxy + j0 * nx;
  const o01 = k0 * sxy + j1 * nx;
  const o10 = k1 * sxy + j0 * nx;
  const o11 = k1 * sxy + j1 * nx;

  const c000 = d[o00 + i0], c100 = d[o00 + i1];
  const c010 = d[o01 + i0], c110 = d[o01 + i1];
  const c001 = d[o10 + i0], c101 = d[o10 + i1];
  const c011 = d[o11 + i0], c111 = d[o11 + i1];

  const c00 = c000 + (c100 - c000) * fi;
  const c10 = c010 + (c110 - c010) * fi;
  const c01 = c001 + (c101 - c001) * fi;
  const c11 = c011 + (c111 - c011) * fi;
  const c0 = c00 + (c10 - c00) * fj;
  const c1 = c01 + (c11 - c01) * fj;
  return c0 + (c1 - c0) * fk;
}

/** world 座標でのサンプリング。範囲外は `NaN`。 */
export function sampleWorld(vol: RegVolume, x: number, y: number, z: number): number {
  const m = vol.worldToIndex;
  const i = m[0] * x + m[1] * y + m[2] * z + m[3];
  const j = m[4] * x + m[5] * y + m[6] * z + m[7];
  const k = m[8] * x + m[9] * y + m[10] * z + m[11];
  return sampleTrilinear(vol, i, j, k);
}

// ── 平滑化 ───────────────────────────────────────────────────────────────

/**
 * 分離可能 Gaussian 平滑（σ は voxel 単位、軸ごと）。端は複製（edge clamp）。
 *
 * <p>間引きの前に必ず通す。平滑せずに間引くとエイリアスして**偽の極小**ができ、
 * 粗い段でそこへ落ちると細かい段でも戻ってこない（設計 §5.2）。
 */
export function gaussianSmooth(
  data: Float32Array,
  dims: readonly [number, number, number],
  sigmaVox: readonly [number, number, number],
): Float32Array {
  const [nx, ny, nz] = dims;
  let src = data;
  for (let axis = 0; axis < 3; axis++) {
    const sigma = sigmaVox[axis];
    if (!(sigma > 1e-3)) continue;
    const radius = Math.max(1, Math.ceil(3 * sigma));
    const kernel = new Float64Array(2 * radius + 1);
    let sum = 0;
    for (let t = -radius; t <= radius; t++) {
      const w = Math.exp(-0.5 * (t / sigma) ** 2);
      kernel[t + radius] = w;
      sum += w;
    }
    for (let t = 0; t < kernel.length; t++) kernel[t] /= sum;

    const dst = new Float32Array(src.length);
    const stride = axis === 0 ? 1 : axis === 1 ? nx : nx * ny;
    const len = axis === 0 ? nx : axis === 1 ? ny : nz;

    // 走査は「その軸に沿った 1 本の線」単位。線の本数は全要素数 / 線の長さ。
    const nLines = (nx * ny * nz) / len;
    for (let line = 0; line < nLines; line++) {
      // line 番号から線の起点オフセットを復元する。
      let base: number;
      if (axis === 0) base = line * nx;
      else if (axis === 1) {
        const k = Math.floor(line / nx), i = line % nx;
        base = k * nx * ny + i;
      } else {
        const j = Math.floor(line / nx), i = line % nx;
        base = j * nx + i;
      }
      for (let t = 0; t < len; t++) {
        let acc = 0;
        for (let r = -radius; r <= radius; r++) {
          let tt = t + r;
          if (tt < 0) tt = 0;
          else if (tt >= len) tt = len - 1;
          acc += kernel[r + radius] * src[base + tt * stride];
        }
        dst[base + t * stride] = acc;
      }
    }
    src = dst;
  }
  // 平滑が一度も走らなければ入力をそのまま返さずコピーを返す（呼び出し側が
  // 返り値を書き換えても入力が壊れないようにする）。
  return src === data ? Float32Array.from(data) : src;
}

// ── ピラミッド ───────────────────────────────────────────────────────────

/** ピラミッドの各段（等方・世界軸に平行）。 */
export interface PyramidLevel {
  readonly volume: RegVolume;
  /** この段の等方間隔 [mm]。 */
  readonly spacingMm: number;
}

/** 設計 §5.2 の既定: 粗い順に 8 → 4 → 2 mm。 */
export const DEFAULT_PYRAMID_MM: readonly number[] = [8, 4, 2];

/**
 * 等方・世界軸平行のピラミッドを作る。
 *
 * <p>元のボリュームが斜めでも異方でも、各段は**世界軸に平行な等方格子**になる。
 * こうしておくと類似度も最適化も入力の幾何に依存しなくなり、
 * 「斜めのシリーズだけ挙動が違う」という種類の不具合が原理的に発生しない。
 *
 * <p>各段は元のボリュームから直接作る（前の段を間引かない）。段を重ねて作ると
 * 補間誤差が段ごとに積み上がり、粗い段の誤差が細かい段の初期値を汚す。
 */
export function buildPyramid(
  vol: RegVolume,
  spacingsMm: readonly number[] = DEFAULT_PYRAMID_MM,
): PyramidLevel[] {
  const bounds = worldBounds(vol);
  return spacingsMm.map((spacingMm) => {
    // 反エイリアス: 目標間隔の半分を σ とし、元のボクセル単位に直す
    // （σ_world = spacing/2 は間引き前平滑の定石）。
    const sigmaVox: Vec3 = [
      Math.max(0, spacingMm / 2 / vol.spacing[0]),
      Math.max(0, spacingMm / 2 / vol.spacing[1]),
      Math.max(0, spacingMm / 2 / vol.spacing[2]),
    ];
    const smoothed = gaussianSmooth(vol.data, vol.dims, sigmaVox);
    const src: RegVolume = { ...vol, data: smoothed };

    const nx = Math.max(1, Math.ceil((bounds.max[0] - bounds.min[0]) / spacingMm) + 1);
    const ny = Math.max(1, Math.ceil((bounds.max[1] - bounds.min[1]) / spacingMm) + 1);
    const nz = Math.max(1, Math.ceil((bounds.max[2] - bounds.min[2]) / spacingMm) + 1);

    const out = new Float32Array(nx * ny * nz);
    let o = 0;
    for (let k = 0; k < nz; k++) {
      const z = bounds.min[2] + k * spacingMm;
      for (let j = 0; j < ny; j++) {
        const y = bounds.min[1] + j * spacingMm;
        for (let i = 0; i < nx; i++) {
          out[o++] = sampleWorld(src, bounds.min[0] + i * spacingMm, y, z);
        }
      }
    }

    const m = mat4Identity();
    m[0] = spacingMm; m[3] = bounds.min[0];
    m[5] = spacingMm; m[7] = bounds.min[1];
    m[10] = spacingMm; m[11] = bounds.min[2];
    const level: RegVolume = {
      data: out,
      dims: [nx, ny, nz],
      indexToWorld: m,
      worldToIndex: invertAffine(m),
      spacing: [spacingMm, spacingMm, spacingMm],
    };
    return { volume: level, spacingMm };
  });
}

/** ボリュームが占める world の軸平行バウンディングボックス（8 隅から）。 */
export function worldBounds(vol: RegVolume): { min: Vec3; max: Vec3 } {
  const [nx, ny, nz] = vol.dims;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p: Vec3 = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    applyMat4(
      vol.indexToWorld,
      c & 1 ? nx - 1 : 0,
      c & 2 ? ny - 1 : 0,
      c & 4 ? nz - 1 : 0,
      p,
    );
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }
  return { min, max };
}

// ── ボディマスク ─────────────────────────────────────────────────────────

/**
 * 「中身がある」ボクセルの索引一覧（＝サンプリング母集団）。
 *
 * <p>空気だけを見て動く最適化を防ぐためのもの。閾値は**モダリティに依存しない**
 * 分位点で決める: 有限値の下位 `airFraction` を空気とみなす。CT の −1000 HU 決め打ちに
 * すると PET や MR で機能しないし、疑似モダリティ（GNBP-2R のマルチモーダル系列など）でも
 * 破綻する。
 *
 * @returns `data` のフラット索引の配列（昇順）。空なら全ボクセルを母集団にする。
 */
export function bodyMaskIndices(vol: RegVolume, airFraction = 0.5): Int32Array {
  const d = vol.data;
  // 分位点は全走査せずに間引いた標本から求める（大きいボリュームで無駄に重くしない）。
  const step = Math.max(1, Math.floor(d.length / 200_000));
  const sample: number[] = [];
  for (let n = 0; n < d.length; n += step) {
    const v = d[n];
    if (Number.isFinite(v)) sample.push(v);
  }
  if (sample.length === 0) return new Int32Array(0);
  sample.sort((a, b) => a - b);
  const lo = sample[0];
  const hi = sample[sample.length - 1];
  if (hi - lo < 1e-9) return new Int32Array(0); // 一様なボリュームに母集団は定義できない

  const q = sample[Math.min(sample.length - 1, Math.floor(sample.length * airFraction))];
  // 分位点が最小値に張り付く（背景が半分以上を占める）場合は、そのすぐ上を閾値にする。
  const threshold = q > lo ? q : lo + (hi - lo) * 0.02;

  const idx: number[] = [];
  for (let n = 0; n < d.length; n++) {
    const v = d[n];
    if (Number.isFinite(v) && v > threshold) idx.push(n);
  }
  return Int32Array.from(idx);
}

/** 索引一覧の world 重心。粗合わせの初期化に使う（設計 §5.2 の FoR 不一致の分岐）。 */
export function centroidOfIndices(vol: RegVolume, indices: Int32Array): Vec3 {
  const [nx, ny] = vol.dims;
  const sxy = nx * ny;
  let sx = 0, sy = 0, sz = 0;
  const p: Vec3 = [0, 0, 0];
  for (let n = 0; n < indices.length; n++) {
    const f = indices[n];
    const k = Math.floor(f / sxy);
    const rem = f - k * sxy;
    const j = Math.floor(rem / nx);
    const i = rem - j * nx;
    applyMat4(vol.indexToWorld, i, j, k, p);
    sx += p[0]; sy += p[1]; sz += p[2];
  }
  const n = Math.max(1, indices.length);
  return [sx / n, sy / n, sz / n];
}
