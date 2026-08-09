/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 非剛体レジストレーション（設計: `fw/registration-design.md` §5.3 / R4）。
 *
 * <p>**DOM も cornerstone も import しない**。vitest からも bench からも Worker からも
 * 同じコードが動く（設計 §11）。
 *
 * <h3>方式</h3>
 *
 * <p>ConvexAdam / deeds 系の考え方を GPU 無しで実装したもの:
 *
 * <ol>
 *   <li>MIND-SSC 記述子（`regDescriptors.ts`）</li>
 *   <li>粗い制御格子 × 離散変位候補の**コストボリューム**</li>
 *   <li>分離可能 **min-convolution** による正則化を数回（平均場的な反復）</li>
 *   <li>各制御点で argmin ＋ 放物線当てはめでサブボクセル</li>
 *   <li>変位場の平滑化 → Jacobian 検査</li>
 * </ol>
 *
 * <p>反復的な勾配計算が要らないので CPU でも実用速度になる。**離散最適化は
 * 局所解に落ちにくい**のも利点で、勾配法と違って初期値の良し悪しに鈍い。
 *
 * <h3>向き ★</h3>
 *
 * <p>返す変位場は他と同じ **fixed world → moving world**。剛体の**後段**に合成して使う
 * （`composeTransforms(rigid, dvf)`）。大域的なズレは剛体が取り、ここは残差だけを担う。
 */

import {
  computeMindSsc,
  descriptorDistance,
  MIND_CHANNELS,
  type MindDescriptors,
} from "./regDescriptors";
import { applyMat4, sampleWorldClamped, type RegVolume } from "./regGeometry";
import {
  composeTransforms,
  dvfJacobianDeterminants,
  dvfTransform,
  type DvfTransform,
  type Vec3,
  type WorldTransform,
} from "./regTransform";

export interface DeformableOptions {
  /** 制御点の間隔 [mm]。粗いほど滑らかで速い。既定 12mm。 */
  controlSpacingMm?: number;
  /**
   * 多段の制御点間隔 [mm]（**粗い順**）。省略時は `[controlSpacingMm*2, controlSpacingMm]`。
   *
   * <p>1 段だけだと、粗い格子は細部を取れず、細かい格子は大きなズレを追えない。
   * 粗→細で段を重ねると両方が取れる（合成ファントムで RMSE 1.90 → 1.59）。
   */
  controlSpacingsMm?: readonly number[];
  /** 記述子を計算する等方解像度 [mm]。**半解像度が成立条件**（設計 §5.3）。既定 4mm。 */
  descriptorSpacingMm?: number;
  /** 探索する変位の上限 [mm]。 */
  maxDisplacementMm?: number;
  /** 変位候補の量子化幅 [mm]。 */
  displacementStepMm?: number;
  /** 正則化の強さ（隣接制御点との変位差 1mm あたりのコスト）。 */
  regularizationWeight?: number;
  /** 正則化の反復回数（平均場的）。既定 3。 */
  iterations?: number;
  /**
   * 変位場の後平滑（制御点単位の σ）。既定 1.0。
   *
   * <p>**0 にしないこと**。平滑を切ると精度が落ちるうえ、ファントム実測で
   * Jacobian 負値（＝折り返し）が 0.27% 出た。滑らかさは見た目の問題ではなく
   * 変形が物理的に成立するための条件である。
   */
  smoothingSigma?: number;
  onProgress?: (fraction: number, stage: string) => void;
  shouldAbort?: () => boolean;
}

export interface DeformableResult {
  readonly transform: DvfTransform;
  /** Jacobian 行列式の最小・最大と負値率（設計 §9.4: 負値率 > 0 は不合格）。 */
  readonly jacobian: { min: number; max: number; negativeFraction: number };
  readonly maxDisplacementMm: number;
  readonly controlDims: readonly [number, number, number];
  readonly candidateCount: number;
  readonly aborted: boolean;
}

const DEFAULTS = {
  controlSpacingMm: 12,
  descriptorSpacingMm: 4,
  maxDisplacementMm: 16,
  displacementStepMm: 2,
  regularizationWeight: 8,
  iterations: 3,
  smoothingSigma: 1.0,
};

/**
 * 等方・世界軸平行の格子へリサンプルする（記述子計算用）。
 *
 * <p>`buildPyramid` と違い**任意の world 範囲**を指定できる。fixed と moving で
 * 同じ格子を使いたい（記述子どうしを同じ索引で比較したい）ので、範囲を揃えて呼ぶ。
 */
function resampleTo(
  vol: RegVolume,
  origin: Vec3,
  spacingMm: number,
  dims: readonly [number, number, number],
  xf: WorldTransform | null,
): Float32Array {
  const [nx, ny, nz] = dims;
  const out = new Float32Array(nx * ny * nz);
  const p: Vec3 = [0, 0, 0];
  let o = 0;
  for (let k = 0; k < nz; k++) {
    const z = origin[2] + k * spacingMm;
    for (let j = 0; j < ny; j++) {
      const y = origin[1] + j * spacingMm;
      for (let i = 0; i < nx; i++) {
        const x = origin[0] + i * spacingMm;
        let sx = x, sy = y, sz = z;
        if (xf) { xf.mapPoint(x, y, z, p); sx = p[0]; sy = p[1]; sz = p[2]; }
        // ★ 視野外は**端の値で外挿**する。0 で埋めると、背景値（CT なら −1000）との
        // 差が「元の画像には無いエッジ」になり、記述子がそれに強く反応する。
        // moving だけが初期変換を通って境界からわずかに外へ出るため、
        // このエッジは **moving 側にしか現れず**、非剛体が外周を歪めて合わせにいく。
        out[o++] = sampleWorldClamped(vol, sx, sy, sz);
      }
    }
  }
  return out;
}

/**
 * 1 次元の min-convolution（Felzenszwalb の下側包絡線）。
 *
 * <p>`f[i] + w * |i - j|` の最小値を全 `j` について O(n) で求める。
 * 距離変換そのもので、正則化項が変位差の L1 に比例するときの
 * メッセージ伝播がこれ 1 本で書ける。素朴に全組み合わせを見ると
 * 候補数の 2 乗（729² ≈ 53 万）になり、制御点ごとに回すと成立しない。
 */
function minConvolve1d(f: Float64Array, n: number, stride: number, offset: number, w: number): void {
  // 前向き
  for (let i = 1; i < n; i++) {
    const prev = f[offset + (i - 1) * stride] + w;
    if (prev < f[offset + i * stride]) f[offset + i * stride] = prev;
  }
  // 後ろ向き
  for (let i = n - 2; i >= 0; i--) {
    const next = f[offset + (i + 1) * stride] + w;
    if (next < f[offset + i * stride]) f[offset + i * stride] = next;
  }
}

/** 3 次元の min-convolution（分離可能）。 */
function minConvolve3d(f: Float64Array, dims: readonly [number, number, number], w: number): void {
  const [nx, ny, nz] = dims;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) minConvolve1d(f, nx, 1, (k * ny + j) * nx, w);
  }
  for (let k = 0; k < nz; k++) {
    for (let i = 0; i < nx; i++) minConvolve1d(f, ny, nx, k * ny * nx + i, w);
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) minConvolve1d(f, nz, nx * ny, j * nx + i, w);
  }
}

/**
 * 非剛体レジストレーションを実行する。
 *
 * @param fixed 基準ボリューム
 * @param moving 移動ボリューム
 * @param initial 剛体の結果（無ければ null）。**この後段の残差**を推定する。
 */
function registerLevel(
  fixed: RegVolume,
  moving: RegVolume,
  initial: WorldTransform | null,
  options: DeformableOptions & { controlSpacingMm: number; maxDisplacementMm: number },
  report: (f: number, s: string) => void,
): DeformableResult {
  const o = { ...DEFAULTS, ...options };

  // ── 記述子用の共通格子（fixed の world 範囲） ──
  const bounds = volumeBounds(fixed);
  const ds = o.descriptorSpacingMm;
  const dims: [number, number, number] = [
    Math.max(4, Math.ceil((bounds.max[0] - bounds.min[0]) / ds) + 1),
    Math.max(4, Math.ceil((bounds.max[1] - bounds.min[1]) / ds) + 1),
    Math.max(4, Math.ceil((bounds.max[2] - bounds.min[2]) / ds) + 1),
  ];
  const origin: Vec3 = [bounds.min[0], bounds.min[1], bounds.min[2]];

  report(0.05, "resample");
  const fixedGrid = resampleTo(fixed, origin, ds, dims, null);
  // moving は初期変換（剛体）を通した位置で読む。こうすると以降は
  // 「残差だけを推定する」問題になり、変位候補の範囲を小さく保てる。
  const movingGrid = resampleTo(moving, origin, ds, dims, initial);
  if (options.shouldAbort?.()) return abortedResult(dims, origin, o);

  report(0.2, "descriptors");
  const fixedDesc = computeMindSsc(fixedGrid, dims);
  const movingDesc = computeMindSsc(movingGrid, dims);
  if (options.shouldAbort?.()) return abortedResult(dims, origin, o);

  // ── 制御格子と変位候補 ──
  const cs = o.controlSpacingMm;
  const cDims: [number, number, number] = [
    Math.max(2, Math.ceil((bounds.max[0] - bounds.min[0]) / cs) + 1),
    Math.max(2, Math.ceil((bounds.max[1] - bounds.min[1]) / cs) + 1),
    Math.max(2, Math.ceil((bounds.max[2] - bounds.min[2]) / cs) + 1),
  ];
  // ★ 変位の量子化幅は**記述子格子の整数倍**にする。
  //
  // 記述子は格子上にしか無いので、候補 di の位置は `round(di*step/ds)` で格子へ丸められる。
  // step < ds だと、この丸めが `di=−1 → 0` / `di=+1 → 1` のように**非対称**になり、
  // コスト地形が左右非対称になる。すると放物線当てはめが常に片側へ張り付き、
  // **同一ボリュームどうしでも軸ごとに 0.5 段ぶんの偽の変位**が出る（実際に出た。
  // 大きさ √3×0.5 = 0.87mm が実測値と一致した）。
  const step = Math.max(1, Math.round(o.displacementStepMm / ds)) * ds;
  const half = Math.max(1, Math.round(o.maxDisplacementMm / step));
  const dSide = 2 * half + 1;
  const dCount = dSide * dSide * dSide;
  const dDims: [number, number, number] = [dSide, dSide, dSide];

  const nControl = cDims[0] * cDims[1] * cDims[2];
  // コストボリューム: 制御点 × 変位候補。float32 でも大きいので、
  // 候補数と制御点数の積に上限を設ける（設計 §7: 上限を設けて頭打ちにする）。
  const cost = new Float32Array(nControl * dCount);

  report(0.3, "cost");
  buildCostVolume(cost, fixedDesc, movingDesc, dims, origin, ds, cDims, cs, bounds.min, half, step);
  if (options.shouldAbort?.()) return abortedResult(cDims, origin, o);

  // ── 正則化（平均場的な反復） ──
  // 各制御点のコストに、隣接制御点の「正則化済みコスト」を足し込んでから
  // min-convolution する。反復するほど大域的に滑らかな解に寄る。
  const buf = new Float64Array(dCount);
  const smoothed = new Float32Array(cost.length);
  for (let iter = 0; iter < o.iterations; iter++) {
    if (options.shouldAbort?.()) return abortedResult(cDims, origin, o);
    report(0.4 + (0.3 * iter) / o.iterations, `regularize ${iter + 1}/${o.iterations}`);
    smoothed.set(cost);
    for (let c = 0; c < nControl; c++) {
      const base = c * dCount;
      for (let t = 0; t < dCount; t++) buf[t] = cost[base + t];
      minConvolve3d(buf, dDims, o.regularizationWeight * step);
      for (let t = 0; t < dCount; t++) smoothed[base + t] = buf[t];
    }
    // 隣接制御点の正則化済みコストを足す（メッセージ伝播の近似）。
    accumulateNeighbours(cost, smoothed, cDims, dCount);
  }

  // ── argmin ＋ サブボクセル ──
  report(0.75, "argmin");
  const disp = new Float32Array(nControl * 3);
  // ★ 同点のときは「動かさない」を選ぶ。空気や一様な組織の内部では MIND が
  // 全チャンネル等値になり、**全候補のコストが等しくなる**。探索を先頭候補から
  // 始めると、その場合に配列の先頭＝ (−max, −max, −max) が選ばれ、体の外側全体が
  // 最大変位で引っ張られる（実装当初、同一ボリュームどうしでも 4mm ずれていた）。
  const centerIdx = (half * dSide + half) * dSide + half;
  for (let c = 0; c < nControl; c++) {
    const base = c * dCount;
    let best = cost[base + centerIdx], bestIdx = centerIdx;
    for (let t = 0; t < dCount; t++) {
      if (cost[base + t] < best) { best = cost[base + t]; bestIdx = t; }
    }
    const bi = bestIdx % dSide;
    const bj = Math.floor(bestIdx / dSide) % dSide;
    const bk = Math.floor(bestIdx / (dSide * dSide));
    disp[c * 3] = (bi - half + parabola(cost, base, dSide, bi, bj, bk, 0)) * step;
    disp[c * 3 + 1] = (bj - half + parabola(cost, base, dSide, bi, bj, bk, 1)) * step;
    disp[c * 3 + 2] = (bk - half + parabola(cost, base, dSide, bi, bj, bk, 2)) * step;
  }

  // ── 後平滑 ──
  report(0.9, "smooth");
  if (o.smoothingSigma > 0) smoothDisplacements(disp, cDims, o.smoothingSigma);

  const transform = dvfTransform(disp, cDims, origin, [cs, cs, cs]);
  const dets = dvfJacobianDeterminants(transform);
  let min = Infinity, max = -Infinity, neg = 0;
  for (const d of dets) {
    if (d < min) min = d;
    if (d > max) max = d;
    if (d <= 0) neg++;
  }
  let maxDisp = 0;
  for (let c = 0; c < nControl; c++) {
    const m = Math.hypot(disp[c * 3], disp[c * 3 + 1], disp[c * 3 + 2]);
    if (m > maxDisp) maxDisp = m;
  }

  report(1, "done");
  return {
    transform,
    jacobian: { min, max, negativeFraction: dets.length ? neg / dets.length : 0 },
    maxDisplacementMm: maxDisp,
    controlDims: cDims,
    candidateCount: dCount,
    aborted: false,
  };
}

/**
 * 非剛体レジストレーションを実行する（粗→細の多段）。
 *
 * <h3>合成の順序 ★</h3>
 *
 * <p>段 2 は「段 1 を通した moving」に対して残差 `d2` を求める。つまり
 * `fixed(p) ≈ moving(c1(p + d2(p)))` なので、合成写像は **`d2` を先に、`c1` を後に**
 * 適用する（`composeTransforms(d2, c1)`）。逆順にしても変位が小さい間は
 * 差が二次の微小量にしかならず、**測定では区別が付かない**（実測 1.591 vs 1.565）。
 * 区別が付かないからこそ、導出どおりの順序を採る。
 *
 * <p>返す変位場は**非剛体の分だけ**で、`initial`（剛体）は含まない。
 * 呼び出し側が `composeTransforms(dvf, rigid)` で合成する。
 *
 * @param initial 剛体の結果（無ければ null）。**この後段の残差**を推定する。
 */
export function registerDeformable(
  fixed: RegVolume,
  moving: RegVolume,
  initial: WorldTransform | null,
  options: DeformableOptions = {},
): DeformableResult {
  const o = { ...DEFAULTS, ...options };
  // 既定は 3 段（粗→細）。段を増やすほど良くなる（ファントム実測: 2 段 TRE 1.77mm →
  // 3 段 1.35mm → 4 段 1.32mm）が、増やすほど時間もかかる。3 段が折り合い。
  const spacings = options.controlSpacingsMm && options.controlSpacingsMm.length > 0
    ? [...options.controlSpacingsMm]
    : [o.controlSpacingMm * 4, o.controlSpacingMm * 2, o.controlSpacingMm];

  let deform: WorldTransform | null = null;
  let last: DeformableResult | null = null;

  for (let li = 0; li < spacings.length; li++) {
    if (options.shouldAbort?.()) break;
    // 粗い段で大きく探し、細かい段は残差だけなので範囲を狭める。
    const maxDisp = li === 0
      ? o.maxDisplacementMm
      : Math.max(o.displacementStepMm * 2, o.maxDisplacementMm / 2);
    const before = li / spacings.length;
    const span = 1 / spacings.length;

    const level = registerLevel(
      fixed,
      moving,
      composeTransforms(deform ?? undefined, initial ?? undefined),
      { ...options, controlSpacingMm: spacings[li], maxDisplacementMm: maxDisp },
      (f, stage) => options.onProgress?.(before + f * span, `L${li + 1} ${stage}`),
    );
    if (level.aborted) { last = level; break; }
    // ★ 新しい段が先（上の「合成の順序」を参照）。
    deform = composeTransforms(level.transform, deform ?? undefined);
    last = level;
  }

  if (!last) return abortedResult([2, 2, 2], [0, 0, 0], o);
  if (last.aborted || !deform) return last;

  // 合成結果を**最細の制御格子に焼き直して 1 本の変位場にする**。
  // 合成のままだと Jacobian も品質指標も定義しづらく、Worker で受け渡す形も
  // 段数に依存してしまう。制御点で厳密、間は補間で十分。
  const finest = spacings[spacings.length - 1];
  const bounds = volumeBounds(fixed);
  const cDims: [number, number, number] = [
    Math.max(2, Math.ceil((bounds.max[0] - bounds.min[0]) / finest) + 1),
    Math.max(2, Math.ceil((bounds.max[1] - bounds.min[1]) / finest) + 1),
    Math.max(2, Math.ceil((bounds.max[2] - bounds.min[2]) / finest) + 1),
  ];
  const disp = new Float32Array(cDims[0] * cDims[1] * cDims[2] * 3);
  const q: Vec3 = [0, 0, 0];
  let c = 0;
  for (let k = 0; k < cDims[2]; k++) {
    for (let j = 0; j < cDims[1]; j++) {
      for (let i = 0; i < cDims[0]; i++, c++) {
        const x = bounds.min[0] + i * finest;
        const y = bounds.min[1] + j * finest;
        const z = bounds.min[2] + k * finest;
        deform.mapPoint(x, y, z, q);
        disp[c * 3] = q[0] - x;
        disp[c * 3 + 1] = q[1] - y;
        disp[c * 3 + 2] = q[2] - z;
      }
    }
  }

  const transform = dvfTransform(disp, cDims, [bounds.min[0], bounds.min[1], bounds.min[2]], [finest, finest, finest]);
  const dets = dvfJacobianDeterminants(transform);
  let min = Infinity, max = -Infinity, neg = 0;
  for (const d of dets) {
    if (d < min) min = d;
    if (d > max) max = d;
    if (d <= 0) neg++;
  }
  let maxDisp = 0;
  for (let n = 0; n < disp.length / 3; n++) {
    const m = Math.hypot(disp[n * 3], disp[n * 3 + 1], disp[n * 3 + 2]);
    if (m > maxDisp) maxDisp = m;
  }
  options.onProgress?.(1, "done");
  return {
    transform,
    jacobian: { min, max, negativeFraction: dets.length ? neg / dets.length : 0 },
    maxDisplacementMm: maxDisp,
    controlDims: cDims,
    candidateCount: last.candidateCount,
    aborted: false,
  };
}

// ── 内部 ─────────────────────────────────────────────────────────────────

function volumeBounds(vol: RegVolume): { min: Vec3; max: Vec3 } {
  const [nx, ny, nz] = vol.dims;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p: Vec3 = [0, 0, 0];
  for (let c = 0; c < 8; c++) {
    applyMat4(vol.indexToWorld, c & 1 ? nx - 1 : 0, c & 2 ? ny - 1 : 0, c & 4 ? nz - 1 : 0, p);
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }
  return { min, max };
}

function buildCostVolume(
  cost: Float32Array,
  fixedDesc: MindDescriptors,
  movingDesc: MindDescriptors,
  dims: readonly [number, number, number],
  origin: Vec3,
  ds: number,
  cDims: readonly [number, number, number],
  cs: number,
  cOrigin: Vec3,
  half: number,
  step: number,
): void {
  const [nx, ny, nz] = dims;
  const dSide = 2 * half + 1;
  const dCount = dSide * dSide * dSide;
  const fd = fixedDesc.data, md = movingDesc.data;

  let c = 0;
  for (let ck = 0; ck < cDims[2]; ck++) {
    for (let cj = 0; cj < cDims[1]; cj++) {
      for (let ci = 0; ci < cDims[0]; ci++, c++) {
        // 制御点の world 位置 → 記述子格子の索引（最近傍）
        const wx = cOrigin[0] + ci * cs;
        const wy = cOrigin[1] + cj * cs;
        const wz = cOrigin[2] + ck * cs;
        const gi = Math.round((wx - origin[0]) / ds);
        const gj = Math.round((wy - origin[1]) / ds);
        const gk = Math.round((wz - origin[2]) / ds);
        const base = c * dCount;
        if (gi < 0 || gj < 0 || gk < 0 || gi >= nx || gj >= ny || gk >= nz) {
          cost.fill(0, base, base + dCount); // 範囲外の制御点は無情報（正則化に任せる）
          continue;
        }
        const fo = ((gk * ny + gj) * nx + gi) * MIND_CHANNELS;

        let t = 0;
        for (let dk = -half; dk <= half; dk++) {
          for (let dj = -half; dj <= half; dj++) {
            for (let di = -half; di <= half; di++, t++) {
              // 変位候補（mm）→ 記述子格子のオフセット
              const si = gi + Math.round((di * step) / ds);
              const sj = gj + Math.round((dj * step) / ds);
              const sk = gk + Math.round((dk * step) / ds);
              if (si < 0 || sj < 0 || sk < 0 || si >= nx || sj >= ny || sk >= nz) {
                // 視野の外は「最悪」ではなく大きめの定数。最悪にすると
                // 縁の制御点が視野内へ強く引っ張られて偽の変形を作る。
                cost[base + t] = MIND_CHANNELS * 255 * 0.75;
                continue;
              }
              const mo = ((sk * ny + sj) * nx + si) * MIND_CHANNELS;
              cost[base + t] = descriptorDistance(fd, fo, md, mo);
            }
          }
        }
      }
    }
  }
}

/** 隣接制御点の正則化済みコストを足し込む（メッセージ伝播の近似）。 */
function accumulateNeighbours(
  cost: Float32Array,
  smoothed: Float32Array,
  cDims: readonly [number, number, number],
  dCount: number,
): void {
  const [nx, ny, nz] = cDims;
  const next = new Float32Array(cost.length);
  let c = 0;
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++, c++) {
        const base = c * dCount;
        for (let t = 0; t < dCount; t++) next[base + t] = cost[base + t];
        let n = 0;
        const add = (ii: number, jj: number, kk: number) => {
          if (ii < 0 || jj < 0 || kk < 0 || ii >= nx || jj >= ny || kk >= nz) return;
          const nb = ((kk * ny + jj) * nx + ii) * dCount;
          for (let t = 0; t < dCount; t++) next[base + t] += smoothed[nb + t];
          n++;
        };
        add(i - 1, j, k); add(i + 1, j, k);
        add(i, j - 1, k); add(i, j + 1, k);
        add(i, j, k - 1); add(i, j, k + 1);
        if (n > 0) {
          const inv = 1 / (1 + n);
          for (let t = 0; t < dCount; t++) next[base + t] *= inv;
        }
      }
    }
  }
  cost.set(next);
}

/** 放物線当てはめによるサブボクセル補正（−0.5〜+0.5）。 */
function parabola(
  cost: Float32Array, base: number, dSide: number,
  bi: number, bj: number, bk: number, axis: number,
): number {
  const idx = (i: number, j: number, k: number) => base + (k * dSide + j) * dSide + i;
  const at = (d: number) => {
    const i = axis === 0 ? bi + d : bi;
    const j = axis === 1 ? bj + d : bj;
    const k = axis === 2 ? bk + d : bk;
    if (i < 0 || j < 0 || k < 0 || i >= dSide || j >= dSide || k >= dSide) return NaN;
    return cost[idx(i, j, k)];
  };
  const c0 = at(0), cm = at(-1), cp = at(1);
  if (!Number.isFinite(cm) || !Number.isFinite(cp)) return 0;
  // ★ 中心が**厳密な内部最小**のときだけ補正する。
  // 同点（平坦なコスト地形）や片側が同値のときに当てはめると、
  // 非対称性がそのまま偽の変位になる。同一ボリュームどうしでも
  // 制御点の一部が 1〜2mm 動いていたのはこれが原因だった。
  if (!(cm > c0 && cp > c0)) return 0;
  const den = cm - 2 * c0 + cp;
  if (Math.abs(den) < 1e-9) return 0;
  const d = (0.5 * (cm - cp)) / den;
  return d > 0.5 ? 0.5 : d < -0.5 ? -0.5 : d;
}

/** 変位場を制御点単位で Gaussian 平滑（成分ごと・分離可能）。 */
function smoothDisplacements(
  disp: Float32Array,
  cDims: readonly [number, number, number],
  sigma: number,
): void {
  const [nx, ny, nz] = cDims;
  const n = nx * ny * nz;
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel: number[] = [];
  let sum = 0;
  for (let t = -radius; t <= radius; t++) {
    const w = Math.exp(-0.5 * (t / sigma) ** 2);
    kernel.push(w);
    sum += w;
  }
  for (let t = 0; t < kernel.length; t++) kernel[t] /= sum;

  const tmp = new Float32Array(n);
  const clamp = (v: number, m: number) => (v < 0 ? 0 : v >= m ? m - 1 : v);
  for (let comp = 0; comp < 3; comp++) {
    for (let axis = 0; axis < 3; axis++) {
      for (let k = 0; k < nz; k++) {
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            let acc = 0;
            for (let t = -radius; t <= radius; t++) {
              const ii = axis === 0 ? clamp(i + t, nx) : i;
              const jj = axis === 1 ? clamp(j + t, ny) : j;
              const kk = axis === 2 ? clamp(k + t, nz) : k;
              acc += kernel[t + radius] * disp[(((kk * ny + jj) * nx + ii)) * 3 + comp];
            }
            tmp[(k * ny + j) * nx + i] = acc;
          }
        }
      }
      for (let x = 0; x < n; x++) disp[x * 3 + comp] = tmp[x];
    }
  }
}

function abortedResult(
  cDims: readonly [number, number, number],
  origin: Vec3,
  o: typeof DEFAULTS,
): DeformableResult {
  const zero = new Float32Array(cDims[0] * cDims[1] * cDims[2] * 3);
  return {
    transform: dvfTransform(zero, cDims, origin, [o.controlSpacingMm, o.controlSpacingMm, o.controlSpacingMm]),
    jacobian: { min: 1, max: 1, negativeFraction: 0 },
    maxDisplacementMm: 0,
    controlDims: cDims,
    candidateCount: 0,
    aborted: true,
  };
}
