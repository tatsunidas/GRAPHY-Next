/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DSA（デジタルサブトラクション血管造影）の**純ロジック**（`fw/angio-design.md` §6）。
 *
 * <p>ここには「差分の数式」「マスクの平均」「サブピクセル・シフト」「マスクフレームの自動選択」
 * 「ピクセルシフトの残差評価」だけを置く。Cornerstone への注入は {@link ./dsaLoader} が担当する。
 * こうしておくと、DSA の正しさ（＝数値）を UI 抜きで vitest で守れる。
 */

/** 差分の取り方。 */
export interface DsaOptions {
  /** マスクを (dx, dy) [px] だけずらしてから引く（体動補正）。サブピクセル可。 */
  dx: number;
  dy: number;
  /**
   * true なら対数変換してから差分（`PixelIntensityRelationship = LIN` の装置）。
   * false は線形差分（`LOG`。XA の多くはこちら）。
   */
  logarithmic: boolean;
}

/** 対数を取るときのゼロ除け。 */
const LOG_EPS = 1e-3;

/**
 * `PixelIntensityRelationship (0028,1040)` から「対数変換が要るか」を決める。
 *
 * <p>`LOG` … 画素値が既に減衰の対数 → **線形差分でよい**。
 * `LIN` … 画素値が線量に比例 → **log を取ってから差分**。
 * 記載が無い装置は XA の慣行に従い `LOG` とみなす（UI で切り替えられるようにしてある）。
 */
export function needsLogTransform(pixelIntensityRelationship?: string | null): boolean {
  const v = pixelIntensityRelationship?.trim().toUpperCase();
  return v === "LIN";
}

/** 複数フレームの画素平均（マスク平均・ライブ側平均の両方に使う）。 */
export function averageFrames(frames: readonly Float32Array[]): Float32Array | null {
  if (!frames.length) return null;
  const size = frames[0].length;
  const out = new Float32Array(size);
  for (const f of frames) {
    if (f.length !== size) return null;
    for (let i = 0; i < size; i++) out[i] += f[i];
  }
  const inv = 1 / frames.length;
  for (let i = 0; i < size; i++) out[i] *= inv;
  return out;
}

/**
 * 双線形補間による平行移動（サブピクセル）。範囲外は端の値で埋める（clamp）。
 *
 * <p>最近傍で妥協しないこと — DSA のエッジが 1px 単位でギザつくと QCA の径が跳ねる。
 *
 * @param dx 正で右へ、dy 正で下へずらす
 */
export function shiftBilinear(
  src: Float32Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
): Float32Array {
  const out = new Float32Array(src.length);
  if (dx === 0 && dy === 0) {
    out.set(src);
    return out;
  }
  const clampI = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v);
  for (let y = 0; y < height; y++) {
    // 出力 (x,y) には入力 (x-dx, y-dy) が来る。
    const sy = y - dy;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    const y0c = clampI(y0, height - 1);
    const y1c = clampI(y0 + 1, height - 1);
    for (let x = 0; x < width; x++) {
      const sx = x - dx;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const x0c = clampI(x0, width - 1);
      const x1c = clampI(x0 + 1, width - 1);
      const v00 = src[y0c * width + x0c];
      const v01 = src[y0c * width + x1c];
      const v10 = src[y1c * width + x0c];
      const v11 = src[y1c * width + x1c];
      const top = v00 + (v01 - v00) * fx;
      const bottom = v10 + (v11 - v10) * fx;
      out[y * width + x] = top + (bottom - top) * fy;
    }
  }
  return out;
}

/**
 * サブトラクション本体。`out = mask' − live`（LOG）または
 * `out = log(mask'+ε) − log(live+ε)`（LIN）。mask' は (dx,dy) シフト後のマスク。
 *
 * <p>血管（＝より減衰する＝画素値が小さい）は差が**正**になるので、そのままでは
 * 「血管が明るい」画像になる。慣行の「白背景に黒い血管」は W/L の反転で作る
 * （値の符号をここでひっくり返さない — 反転は表示の話であって値の話ではない）。
 */
export function subtractFrames(
  mask: Float32Array,
  live: Float32Array,
  width: number,
  height: number,
  opts: DsaOptions,
): Float32Array | null {
  if (mask.length !== live.length || mask.length !== width * height) return null;
  const m = shiftBilinear(mask, width, height, opts.dx, opts.dy);
  const out = new Float32Array(mask.length);
  if (opts.logarithmic) {
    for (let i = 0; i < out.length; i++) {
      out[i] = Math.log(Math.max(m[i], 0) + LOG_EPS) - Math.log(Math.max(live[i], 0) + LOG_EPS);
    }
  } else {
    for (let i = 0; i < out.length; i++) out[i] = m[i] - live[i];
  }
  return out;
}

/** マスク自動選択の結果。 */
export interface MaskPick {
  /** 平均してマスクにするフレーム番号（0 origin, 昇順）。 */
  frames: number[];
  /** 造影が到達したと判断したフレーム（見つからなければ null）。 */
  onset: number | null;
}

/**
 * 造影剤到達前のフレームを自動で選ぶ（`fw/angio-design.md` §6.3）。
 *
 * <p>各フレームの平均輝度の時系列を見て、**最初に基線から大きく外れたフレーム（onset）の手前**を
 * マスクにする。自動＝提案であり、UI から必ず直せるようにすること。
 *
 * @param mean    フレームごとの平均輝度
 * @param maxMask マスクに使う最大枚数（既定 5）
 * @param k       基線の標準偏差の何倍で「外れた」とみなすか（既定 4）
 */
export function pickMaskFrames(mean: readonly number[], maxMask = 5, k = 4): MaskPick {
  const n = mean.length;
  if (n === 0) return { frames: [], onset: null };
  if (n === 1) return { frames: [0], onset: null };

  // 基線 = 先頭 min(5, n-1) フレーム。
  const baseCount = Math.max(1, Math.min(5, n - 1));
  let sum = 0;
  for (let i = 0; i < baseCount; i++) sum += mean[i];
  const base = sum / baseCount;
  let varSum = 0;
  for (let i = 0; i < baseCount; i++) varSum += (mean[i] - base) ** 2;
  const sd = Math.sqrt(varSum / baseCount);
  // 基線が完全に平坦（sd=0）だと閾値が 0 になり、量子化ノイズでも onset になってしまう。
  // 平均値の 0.5% を下限にする。
  const threshold = Math.max(k * sd, Math.abs(base) * 0.005);

  let onset: number | null = null;
  for (let i = baseCount; i < n; i++) {
    if (Math.abs(mean[i] - base) > threshold) {
      onset = i;
      break;
    }
  }
  const end = onset != null ? onset - 1 : n - 1;
  const start = Math.max(0, end - maxMask + 1);
  const frames: number[] = [];
  for (let i = start; i <= end; i++) frames.push(i);
  return { frames: frames.length ? frames : [0], onset };
}

/**
 * ピクセルシフトが合っているかの指標（差分画像の「背景」の RMS）。
 *
 * <p>ずれが残っていると骨・軟部のエッジが差し引き残り、背景の RMS が大きくなる。
 * 血管（信号そのもの）に引っ張られないよう、**絶対値の大きい上位 `excludeTopFraction` を除外**
 * してから RMS を取る。数値で判断できるようにするための指標であり、最適化の目的関数でもある。
 */
export function backgroundRms(diff: Float32Array, excludeTopFraction = 0.1): number {
  const n = diff.length;
  if (n === 0) return 0;
  const abs = new Float32Array(n);
  for (let i = 0; i < n; i++) abs[i] = Math.abs(diff[i]);
  const sorted = Float32Array.from(abs).sort();
  // 上位 excludeTopFraction を「含めない」ための閾値インデックス。
  // floor だと境界値（除外したい先頭値）が閾値になってしまい 1 画素も除外されない。
  const cutIdx = Math.max(0, Math.min(n - 1, Math.ceil(n * (1 - excludeTopFraction)) - 1));
  const cut = sorted[cutIdx];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (abs[i] <= cut) {
      sum += diff[i] * diff[i];
      count++;
    }
  }
  return count ? Math.sqrt(sum / count) : 0;
}

/**
 * ピクセルシフトの自動推定（背景 RMS 最小化）。
 *
 * <p>整数グリッドで粗探索 → 最良点の周りを 0.1px 刻みで詰める、の 2 段。血管領域は
 * {@link backgroundRms} が上位を除外することで自然に効きにくくなる。
 *
 * @param range 探索半径 [px]（既定 4）
 */
export function estimateShift(
  mask: Float32Array,
  live: Float32Array,
  width: number,
  height: number,
  logarithmic: boolean,
  range = 4,
): { dx: number; dy: number; rms: number } {
  const evaluate = (dx: number, dy: number): number => {
    const d = subtractFrames(mask, live, width, height, { dx, dy, logarithmic });
    return d ? backgroundRms(d) : Number.POSITIVE_INFINITY;
  };
  let best = { dx: 0, dy: 0, rms: evaluate(0, 0) };
  for (let dy = -range; dy <= range; dy++) {
    for (let dx = -range; dx <= range; dx++) {
      if (dx === 0 && dy === 0) continue;
      const rms = evaluate(dx, dy);
      if (rms < best.rms) best = { dx, dy, rms };
    }
  }
  // 粗探索の周り ±0.9px を 0.1px 刻みで詰める。
  const cx = best.dx;
  const cy = best.dy;
  for (let iy = -9; iy <= 9; iy++) {
    for (let ix = -9; ix <= 9; ix++) {
      const dx = cx + ix / 10;
      const dy = cy + iy / 10;
      if (dx === cx && dy === cy) continue;
      const rms = evaluate(dx, dy);
      if (rms < best.rms) best = { dx, dy, rms };
    }
  }
  return best;
}

/** DICOM Mask Subtraction Module から読み取った既定値（`fw/angio-design.md` §6.3）。 */
export interface MaskModuleSpec {
  /** MaskOperation (0028,6101)。"AVG_SUB" / "TID"。 */
  operation: "AVG_SUB" | "TID" | null;
  /** MaskFrameNumbers (0028,6110) を 0 origin に直したもの。 */
  maskFrames: number[] | null;
  /** ContrastFrameAveraging (0028,6112)。ライブ側の平均枚数。 */
  contrastFrameAveraging: number | null;
  /** MaskSubPixelShift (0028,6114) [row, col] → {dy, dx}。 */
  subPixelShift: { dx: number; dy: number } | null;
  /** TIDOffset (0028,6120)。TID モードのオフセットフレーム数。 */
  tidOffset: number | null;
  /** ApplicableFrameRange (0028,6102) を 0 origin の [start, end] に直したもの。 */
  applicableFrameRange: [number, number] | null;
}

/** DICOM の 1 origin フレーム番号列（"3\\4\\5"）を 0 origin の配列に。 */
export function parseFrameNumbers(raw?: string | null): number[] | null {
  if (!raw) return null;
  const out = raw
    .split("\\")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((v) => Number.isFinite(v) && v >= 1)
    .map((v) => v - 1);
  return out.length ? out : null;
}
