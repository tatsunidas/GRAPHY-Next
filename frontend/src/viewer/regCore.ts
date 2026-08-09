/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 剛体レジストレーションの最適化本体（設計: `fw/registration-design.md` §5.2 / R3）。
 *
 * <p>**DOM も cornerstone も import しない**。node の vitest からも、bench の
 * ハーネスからも、Worker からも同じコードが動く（設計 §11）。
 *
 * <h3>推定するもの ★向きに注意</h3>
 *
 * <p>返す変換は他と同じ **fixed world → moving world**（pull-back）。
 * 「fixed のこの点に対応する moving の点はどこか」を返す。GNBP-2R の
 * `transform_fixed_to_moving` と同じ向きで、そのまま
 * {@link ../viewer/fusionEngine} の `computeFusionSlice(fg, bg, xf)` に渡せる。
 *
 * <h3>決定性</h3>
 *
 * <p>サンプリングはシード付き擬似乱数のみを使い、`Math.random` を呼ばない。
 * 同じ入力・同じ `seed` なら**同じ結果**になる。非凸最適化なので、これが無いと
 * 「前回と違う答えが出た」を検証と区別できない（設計 §6）。
 */

import {
  sampleWorldClamped,
  bodyMaskIndices,
  centroidOfIndices,
  buildPyramid,
  DEFAULT_PYRAMID_MM,
  sampleWorld,
  applyMat4,
  type PyramidLevel,
  type RegVolume,
} from "./regGeometry";
import { evaluateMetric, type MetricKind, type SamplePair } from "./regMetrics";
import { linearTransform, type LinearTransform, type Vec3 } from "./regTransform";

// ── 公開型 ───────────────────────────────────────────────────────────────

export interface RigidOptions {
  /** 類似度。省略時は `sameModality` から決める（同一なら NCC・違えば MI）。 */
  metric?: MetricKind;
  /**
   * fixed と moving が同一モダリティか。`metric` を省略したときだけ使う。
   * 判断は呼び出し側（DICOM の Modality を見る層）の責務。
   */
  sameModality?: boolean;
  /**
   * `FrameOfReferenceUID` が一致しているか。**初期化と探索範囲が変わる**（設計 §5.2）。
   * 一致＝ハイブリッド機の同時撮像なので、既に大まかには合っている。
   */
  sameFrameOfReference?: boolean;
  /** ピラミッドの間隔 [mm]（粗い順）。既定 8 → 4 → 2。 */
  pyramidMm?: readonly number[];
  /** 1 反復あたりのサンプル点数（設計 §5.2 の 2,000〜5,000）。 */
  samplesPerIteration?: number;
  /** 段ごとの最大反復数。 */
  maxIterationsPerLevel?: number;
  /** 乱数シード（再現用に結果へ記録される）。 */
  seed?: number;
  /** 探索範囲の上限。省略時は `sameFrameOfReference` から決める。 */
  limits?: { translationMm: number; rotationDeg: number };
  /** 進捗通知（0..1）。Worker から UI へ流す用。 */
  onProgress?: (p: RigidProgress) => void;
  /** true を返すと中止する。 */
  shouldAbort?: () => boolean;
}

export interface RigidProgress {
  /** 全体の進捗 0..1。 */
  readonly fraction: number;
  readonly level: number;
  readonly levelCount: number;
  readonly iteration: number;
  /** 現時点の類似度（大きいほど良い）。 */
  readonly metric: number;
}

export interface RigidResult {
  /** fixed world → moving world の剛体変換。 */
  readonly transform: LinearTransform;
  /** 6 パラメータ（回転中心 `center` まわり）。角度は度、`R = Rz·Ry·Rx`。 */
  readonly parameters: {
    readonly translationMm: Vec3;
    readonly eulerDeg: Vec3;
  };
  /** 回転中心（world）。パラメータはこの点まわりの量として解釈する。 */
  readonly center: Vec3;
  readonly metric: MetricKind;
  /** 最終段の類似度。 */
  readonly metricValue: number;
  /** 段ごとの (反復数, 最終類似度)。収束の様子を UI に出す用。 */
  readonly levels: { spacingMm: number; iterations: number; metric: number }[];
  readonly seed: number;
  /** 中止要求で打ち切った場合 true（結果はその時点のもの）。 */
  readonly aborted: boolean;
  /** 初期化の方法（説明可能性のため記録する）。 */
  readonly initialization: "identity-same-for" | "centroid";
}

// ── 擬似乱数（決定的） ───────────────────────────────────────────────────

/** mulberry32。軽くて質が十分で、シードから完全に再現できる。 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── パラメータ ↔ 行列 ────────────────────────────────────────────────────

/** `R = Rz·Ry·Rx`（度）。`regTransform.mat4FromEulerDeg` と同じ規約。 */
function rotation(rx: number, ry: number, rz: number): Float64Array {
  const d = Math.PI / 180;
  const cx = Math.cos(rx * d), sx = Math.sin(rx * d);
  const cy = Math.cos(ry * d), sy = Math.sin(ry * d);
  const cz = Math.cos(rz * d), sz = Math.sin(rz * d);
  const m = new Float64Array(9);
  m[0] = cz * cy; m[1] = cz * sy * sx - sz * cx; m[2] = cz * sy * cx + sz * sx;
  m[3] = sz * cy; m[4] = sz * sy * sx + cz * cx; m[5] = sz * sy * cx - cz * sx;
  m[6] = -sy; m[7] = cy * sx; m[8] = cy * cx;
  return m;
}

/**
 * 6 パラメータ → 4×4（fixed → moving）。`T(p) = C + R·(p − C) + t`。
 *
 * <p>回転中心 `C` を明示的に持つのは、パラメータの意味を「体の中心まわりの回し方」に
 * 固定するため。原点まわりにすると、原点が体から遠い実データで回転 1 度の意味が
 * 平行移動数十 mm 相当になり、最適化のスケーリングが破綻する。
 */
function paramsToMatrix(p: Float64Array, c: Vec3): Float64Array {
  const R = rotation(p[3], p[4], p[5]);
  const m = new Float64Array(16);
  m[0] = R[0]; m[1] = R[1]; m[2] = R[2];
  m[4] = R[3]; m[5] = R[4]; m[6] = R[5];
  m[8] = R[6]; m[9] = R[7]; m[10] = R[8];
  m[3] = c[0] + p[0] - (R[0] * c[0] + R[1] * c[1] + R[2] * c[2]);
  m[7] = c[1] + p[1] - (R[3] * c[0] + R[4] * c[1] + R[5] * c[2]);
  m[11] = c[2] + p[2] - (R[6] * c[0] + R[7] * c[1] + R[8] * c[2]);
  m[15] = 1;
  return m;
}

// ── サンプル集合 ─────────────────────────────────────────────────────────

/**
 * fixed 側の標本。world 座標と fixed の値は**パラメータに依存しない**ので
 * 1 反復につき一度だけ作り、勾配の 13 回の評価で使い回す。
 * ここを毎回作り直すと素朴に 13 倍遅くなる。
 */
interface SampleSet {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  /** fixed の値。パッチを使う場合は 1 点あたり `patchSize` 個が連続して並ぶ。 */
  readonly fixedValue: Float64Array;
  readonly n: number;
  /** 1 点あたりの値の数（LNCC のときだけ > 1）。 */
  readonly patchSize: number;
  /**
   * パッチのオフセット（world mm、`[dx,dy,dz]` × patchSize）。
   *
   * <p>剛体は線形なので `T(p + d) = T(p) + R·d`。オフセットを**1 評価につき 1 回だけ**
   * 回せば済み、点ごとに変換を掛け直す必要がない。ここを素朴に書くと
   * パッチの分だけそのまま遅くなる。
   */
  readonly patchOffsets: Float64Array;
}

/** LNCC のパッチ形状。中心 ＋ 3×3×3 の 27 点（段の間隔 1 つ分だけ離す）。 */
function buildPatchOffsets(spacingMm: number, radius: number): Float64Array {
  const offs: number[] = [];
  for (let k = -radius; k <= radius; k++) {
    for (let j = -radius; j <= radius; j++) {
      for (let i = -radius; i <= radius; i++) {
        offs.push(i * spacingMm, j * spacingMm, k * spacingMm);
      }
    }
  }
  return Float64Array.from(offs);
}

function drawSamples(
  level: RegVolume,
  mask: Int32Array,
  count: number,
  rnd: () => number,
  patchOffsets: Float64Array,
): SampleSet {
  const patchSize = Math.max(1, patchOffsets.length / 3);
  const n = Math.min(count, mask.length);
  const x = new Float64Array(n), y = new Float64Array(n), z = new Float64Array(n);
  const fv = new Float64Array(n * patchSize);
  const [nx, ny] = level.dims;
  const sxy = nx * ny;
  const p: Vec3 = [0, 0, 0];
  for (let s = 0; s < n; s++) {
    const flat = mask[Math.floor(rnd() * mask.length)];
    const k = Math.floor(flat / sxy);
    const rem = flat - k * sxy;
    const j = Math.floor(rem / nx);
    const i = rem - j * nx;
    applyMat4(level.indexToWorld, i, j, k, p);
    x[s] = p[0]; y[s] = p[1]; z[s] = p[2];
    if (patchSize === 1) {
      fv[s] = level.data[flat];
    } else {
      for (let q = 0; q < patchSize; q++) {
        // fixed 側は変換が掛からないので world で直接読む。範囲外は端の値
        // （NaN にすると、パッチの一部が欠けただけで点全体が捨てられる）。
        const v = sampleWorldClamped(level, p[0] + patchOffsets[q * 3],
          p[1] + patchOffsets[q * 3 + 1], p[2] + patchOffsets[q * 3 + 2]);
        fv[s * patchSize + q] = v;
      }
    }
  }
  return { x, y, z, fixedValue: fv, n, patchSize, patchOffsets };
}

/**
 * 標本にパラメータを当てて類似度を評価する。
 *
 * <p>moving の視野から外れた点（`NaN`）は**捨てる**。0 で埋めると「視野外」が
 * 一様な値の領域として類似度に効いてしまい、**重なりを減らす方向が有利**になって
 * 解が視野の外へ逃げる（設計 §8.1 と同じ理由）。
 *
 * <p>有効点が標本の 10% を切ったら 0（無情報）を返す。少数の点でたまたま高い
 * 相関が出る領域へ引き寄せられるのを防ぐ。
 */
function evaluate(
  samples: SampleSet,
  moving: RegVolume,
  params: Float64Array,
  center: Vec3,
  metric: MetricKind,
  buf: { f: Float64Array; m: Float64Array; rot: Float64Array },
): number {
  const mat = paramsToMatrix(params, center);
  const ps = samples.patchSize;

  // パッチのオフセットは剛体の回転部だけを掛ければよい（T(p+d) = T(p) + R·d）。
  if (ps > 1) {
    for (let q = 0; q < ps; q++) {
      const dx = samples.patchOffsets[q * 3];
      const dy = samples.patchOffsets[q * 3 + 1];
      const dz = samples.patchOffsets[q * 3 + 2];
      buf.rot[q * 3] = mat[0] * dx + mat[1] * dy + mat[2] * dz;
      buf.rot[q * 3 + 1] = mat[4] * dx + mat[5] * dy + mat[6] * dz;
      buf.rot[q * 3 + 2] = mat[8] * dx + mat[9] * dy + mat[10] * dz;
    }
  }

  let valid = 0;      // 有効な**値**の数
  let usedPoints = 0; // 有効な標本点の数
  for (let s = 0; s < samples.n; s++) {
    const px = samples.x[s], py = samples.y[s], pz = samples.z[s];
    const qx = mat[0] * px + mat[1] * py + mat[2] * pz + mat[3];
    const qy = mat[4] * px + mat[5] * py + mat[6] * pz + mat[7];
    const qz = mat[8] * px + mat[9] * py + mat[10] * pz + mat[11];

    if (ps === 1) {
      const v = sampleWorld(moving, qx, qy, qz);
      if (!Number.isFinite(v)) continue;
      buf.f[valid] = samples.fixedValue[s];
      buf.m[valid] = v;
      valid++; usedPoints++;
      continue;
    }
    // パッチ: 中心が視野外なら点ごと捨てる。中心が入っていれば、
    // 周辺は端の値で読む（一部が欠けただけで点を捨てると標本が偏る）。
    if (!Number.isFinite(sampleWorld(moving, qx, qy, qz))) continue;
    for (let q = 0; q < ps; q++) {
      buf.f[valid] = samples.fixedValue[s * ps + q];
      buf.m[valid] = sampleWorldClamped(moving,
        qx + buf.rot[q * 3], qy + buf.rot[q * 3 + 1], qz + buf.rot[q * 3 + 2]);
      valid++;
    }
    usedPoints++;
  }
  if (usedPoints < Math.max(16, samples.n * 0.1)) return 0;
  const pair: SamplePair = { fixed: buf.f, moving: buf.m, count: valid, patchSize: ps };
  return evaluateMetric(metric, pair);
}

// ── 最適化 ───────────────────────────────────────────────────────────────

/** 既定の探索範囲。FoR 一致時は狭く縛る（設計 §5.2 の表）。 */
const LIMITS_SAME_FOR = { translationMm: 30, rotationDeg: 10 };
const LIMITS_FREE = { translationMm: 200, rotationDeg: 45 };

/**
 * 剛体レジストレーションを実行する。
 *
 * <p>最適化は**適応ステップの確率的勾配上昇**。設計 §5.2 が挙げた
 * `a/(k+A)^alpha` 型の減衰ステップ（elastix の ASGD）ではなく、
 * **同一標本上での受理判定つき線探索**にしてある。理由:
 *
 * <ul>
 *   <li>減衰ステップは「良い `a` を当てられたら速い」が、外すと粗い段で発散するか
 *       まったく動かないかのどちらかになり、その失敗が**静かに**起きる
 *       （数値は出るが合っていない）。</li>
 *   <li>受理判定を入れると、悪化する更新を必ず捨てるので**単調**に進む。
 *       標本は反復ごとに引き直すので確率的な性質（局所解からの脱出）は保たれる。</li>
 *   <li>1 反復あたりの評価は勾配 12 回＋受理判定 1 回で、減衰ステップ版（12 回）と
 *       ほぼ同じ。速度を落とさずに失敗の仕方を「静か」から「見える」に変えられる。</li>
 * </ul>
 */
export function registerRigid(
  fixed: RegVolume,
  moving: RegVolume,
  options: RigidOptions = {},
): RigidResult {
  const seed = options.seed ?? 20260808;
  const metric: MetricKind =
    options.metric ?? (options.sameModality === false ? "mi" : options.sameModality ? "ncc" : "mi");
  const sameFor = options.sameFrameOfReference === true;
  const limits = options.limits ?? (sameFor ? LIMITS_SAME_FOR : LIMITS_FREE);
  const samplesPerIteration = options.samplesPerIteration ?? 3000;
  const maxIter = options.maxIterationsPerLevel ?? 120;
  const spacings = options.pyramidMm ?? DEFAULT_PYRAMID_MM;

  const fixedPyr = buildPyramid(fixed, spacings);
  const movingPyr = buildPyramid(moving, spacings);

  // 回転中心は fixed のボディマスク重心。体の中心まわりの量としてパラメータを定義する。
  const finestFixed = fixedPyr[fixedPyr.length - 1].volume;
  const finestMask = bodyMaskIndices(finestFixed);
  const center: Vec3 = finestMask.length > 0
    ? centroidOfIndices(finestFixed, finestMask)
    : centroidOfIndices(finestFixed, Int32Array.from({ length: finestFixed.data.length }, (_, i) => i));

  const params = new Float64Array(6);
  let initialization: RigidResult["initialization"] = "identity-same-for";

  if (!sameFor) {
    // FoR 不一致＝別装置・別撮り。まず重心を合わせる（設計 §5.2 の分岐）。
    // 慣性主軸による回転の粗合わせは**まだ入れていない**: 主軸には符号と順序の
    // 曖昧さ（4 通り）があり、指標で選び直す必要がある。頭部のように概ね等方な
    // 対象では主軸自体が不安定でもある。まず重心だけで測り、必要が数値で
    // 示されてから足す（未実装であることは結果の `initialization` に出る）。
    const movingMask = bodyMaskIndices(movingPyr[movingPyr.length - 1].volume);
    if (movingMask.length > 0) {
      const movingCentroid = centroidOfIndices(movingPyr[movingPyr.length - 1].volume, movingMask);
      params[0] = movingCentroid[0] - center[0];
      params[1] = movingCentroid[1] - center[1];
      params[2] = movingCentroid[2] - center[2];
      initialization = "centroid";
    }
  }

  const levels: RigidResult["levels"] = [];
  let lastMetric = 0;
  let aborted = false;

  const totalIter = spacings.length * maxIter;
  let doneIter = 0;

  for (let li = 0; li < fixedPyr.length; li++) {
    const fLevel: PyramidLevel = fixedPyr[li];
    const mLevel: PyramidLevel = movingPyr[li];
    const mask = bodyMaskIndices(fLevel.volume);
    if (mask.length === 0) {
      levels.push({ spacingMm: fLevel.spacingMm, iterations: 0, metric: 0 });
      doneIter += maxIter;
      continue;
    }

    // LNCC はパッチを取るので、1 点あたり patchSize 個の値になる。
    // 点数はその分減らす（総サンプル数を指標によらず概ね揃えるため）。
    const patchOffsets = metric === "lncc"
      ? buildPatchOffsets(fLevel.spacingMm, 1)
      : new Float64Array(3); // 中心のみ
    const patchSize = patchOffsets.length / 3;
    const points = patchSize > 1
      ? Math.max(120, Math.floor(samplesPerIteration / patchSize))
      : samplesPerIteration;
    const buf = {
      f: new Float64Array(points * patchSize),
      m: new Float64Array(points * patchSize),
      rot: new Float64Array(patchSize * 3),
    };
    const rnd = mulberry32(seed + li * 7919);

    // 回転 1 度が体の縁で何 mm 動くか。これで平行移動と回転のスケールを揃える。
    // 揃えないと勾配が平行移動成分に完全に支配され、回転が動かない。
    const radiusMm = characteristicRadius(fLevel.volume, mask, center);
    const degPerMm = radiusMm > 1e-6 ? 180 / (Math.PI * radiusMm) : 1;
    const scale = new Float64Array([1, 1, 1, degPerMm, degPerMm, degPerMm]);

    // ステップと有限差分幅は段の解像度を基準にする。粗い段で細かく刻んでも情報が
    // 無く、細かい段で粗く刻むと収束しない。
    let step = fLevel.spacingMm * 2;
    const minStep = fLevel.spacingMm * 0.02;
    const maxStep = fLevel.spacingMm * 4;
    // 改善できない反復がこれだけ続いたら、その段は終わりとみなす。標本は毎反復
    // 引き直すので、1 回の失敗は「たまたま悪い標本だった」でありうる。1 回で
    // 打ち切ると、実際には動けるのに 2 反復で止まる（実装当初それで止まっていた）。
    const MAX_CONSECUTIVE_FAILURES = 6;

    const trial = new Float64Array(6);
    const grad = new Float64Array(6);
    let iter = 0;
    let current = 0;
    let failures = 0;

    for (; iter < maxIter; iter++) {
      if (options.shouldAbort?.()) { aborted = true; break; }

      const samples = drawSamples(fLevel.volume, mask, points, rnd, patchOffsets);
      const score = (pp: Float64Array): number => evaluate(samples, mLevel.volume, pp, center, metric, buf);
      current = score(params);

      // 有限差分の幅は**今から踏もうとしている歩幅に合わせる**。固定幅にすると、
      // 収束に近づいたとき「幅の中で平均された勾配」しか見えず、最適解の手前で
      // 止まる。歩幅と連動させると、詰めるほど局所的な勾配になる。
      const h = Math.min(fLevel.spacingMm * 0.5, Math.max(fLevel.spacingMm * 0.05, step * 0.5));

      // 中心差分。★同じ標本集合で前後を評価する（common random numbers）。
      // 標本を引き直すと差が標本のばらつきに埋もれ、勾配が雑音になる。
      let gnorm = 0;
      for (let d = 0; d < 6; d++) {
        const delta = h * scale[d];
        trial.set(params);
        trial[d] = params[d] + delta;
        const up = score(trial);
        trial[d] = params[d] - delta;
        const dn = score(trial);
        grad[d] = (up - dn) / (2 * delta);
        gnorm += grad[d] * grad[d];
      }
      gnorm = Math.sqrt(gnorm);
      if (!(gnorm > 0)) break;

      // 正規化した方向に step [mm 相当] だけ進む。受理できなければ歩幅を半分に
      // して数回だけ試す。**歩幅そのものは 1 反復で半分までしか縮めない** —
      // 失敗のたびに 1/64 まで縮めると、次の反復で下限を割って即終了になる。
      let accepted = false;
      let trialStep = step;
      for (let back = 0; back < 4; back++) {
        for (let d = 0; d < 6; d++) {
          trial[d] = params[d] + (trialStep * scale[d] * grad[d]) / gnorm;
        }
        clampToLimits(trial, limits);
        const cand = score(trial);
        if (cand > current) {
          params.set(trial);
          current = cand;
          step = Math.min(maxStep, trialStep * 1.3);
          accepted = true;
          break;
        }
        trialStep *= 0.5;
        if (trialStep < minStep) break;
      }
      if (accepted) {
        failures = 0;
      } else {
        failures++;
        step = Math.max(minStep, step * 0.5);
        if (failures >= MAX_CONSECUTIVE_FAILURES) { iter++; break; }
      }

      options.onProgress?.({
        fraction: Math.min(1, (doneIter + iter + 1) / totalIter),
        level: li,
        levelCount: fixedPyr.length,
        iteration: iter,
        metric: current,
      });
    }

    doneIter += maxIter;
    lastMetric = current;
    levels.push({ spacingMm: fLevel.spacingMm, iterations: iter, metric: current });
    if (aborted) break;
  }

  const matrix = paramsToMatrix(params, center);
  return {
    transform: linearTransform(matrix, { dof: 6, center }),
    parameters: {
      translationMm: [params[0], params[1], params[2]],
      eulerDeg: [params[3], params[4], params[5]],
    },
    center,
    metric,
    metricValue: lastMetric,
    levels,
    seed,
    aborted,
    initialization,
  };
}

/** 探索範囲へ丸める（設計 §5.2: FoR 一致なら ±30mm / ±10°）。 */
function clampToLimits(p: Float64Array, limits: { translationMm: number; rotationDeg: number }): void {
  for (let d = 0; d < 3; d++) {
    if (p[d] > limits.translationMm) p[d] = limits.translationMm;
    else if (p[d] < -limits.translationMm) p[d] = -limits.translationMm;
  }
  for (let d = 3; d < 6; d++) {
    if (p[d] > limits.rotationDeg) p[d] = limits.rotationDeg;
    else if (p[d] < -limits.rotationDeg) p[d] = -limits.rotationDeg;
  }
}

/** 重心から見た標本の RMS 距離。回転と平行移動のスケールを揃えるのに使う。 */
function characteristicRadius(vol: RegVolume, mask: Int32Array, center: Vec3): number {
  const [nx, ny] = vol.dims;
  const sxy = nx * ny;
  const p: Vec3 = [0, 0, 0];
  const stride = Math.max(1, Math.floor(mask.length / 5000));
  let acc = 0, n = 0;
  for (let s = 0; s < mask.length; s += stride) {
    const flat = mask[s];
    const k = Math.floor(flat / sxy);
    const rem = flat - k * sxy;
    const j = Math.floor(rem / nx);
    const i = rem - j * nx;
    applyMat4(vol.indexToWorld, i, j, k, p);
    acc += (p[0] - center[0]) ** 2 + (p[1] - center[1]) ** 2 + (p[2] - center[2]) ** 2;
    n++;
  }
  return n > 0 ? Math.sqrt(acc / n) : 0;
}
