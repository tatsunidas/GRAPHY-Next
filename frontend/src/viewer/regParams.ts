/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 位置合わせのハイパーパラメータとプリセット（純関数・DOM 非依存）。
 *
 * <p>ここに集約する理由は 2 つある。
 *
 * <ol>
 *   <li>UI・Worker・エンジンの 3 か所で同じ既定値を書かないため。</li>
 *   <li><b>この一式がそのまま「レシピ」として保存される</b>ため。結果を再現するには
 *       変換そのものを保存するが、<b>どうやって出したか</b>を残しておかないと
 *       監査もやり直しもできない。</li>
 * </ol>
 *
 * <p>既定値と各プリセットの値は、**GNBP-2R での実測に基づいて**決めてある
 * （`fw/registration-design.md` §10 の R3/R4 の実装記録）。思い付きの値ではない。
 */

import type { MetricKind } from "./regMetrics";

/** 剛体・非剛体をまとめたパラメータ一式。 */
export interface RegistrationParams {
  // ── 剛体 ──
  /** 類似度。`auto` は呼び出し側がモダリティから決める。 */
  metric: "auto" | MetricKind;
  /** 1 反復あたりのサンプル点数。 */
  samplesPerIteration: number;
  /** 段ごとの最大反復数。 */
  maxIterationsPerLevel: number;
  /** 乱数シード。**同じ値なら同じ結果**（設計 §6）。既定は {@link DEFAULT_SEED}。 */
  seed: number;
  /**
   * 探索範囲。`null` なら FrameOfReferenceUID の一致から自動で決める
   * （一致＝同時撮像とみなし ±30mm / ±10°）。
   */
  limitTranslationMm: number | null;
  limitRotationDeg: number | null;

  // ── 非剛体 ──
  /** 制御点間隔 [mm]（粗い順）。段を増やすほど良くなるが遅くなる。 */
  controlSpacingsMm: number[];
  /**
   * 変位場の後平滑 σ（制御点単位）。
   *
   * <p>**Jacobian に最も効くレバー**。実測では 1.0 → 1.5 で Jacobian が
   * 0.44–2.35 → 0.57–1.64 に締まり、landmark TRE は 1.63 → 2.02mm に悪化する。
   * **0 にしないこと**（折り返しが発生した）。
   */
  smoothingSigma: number;
  /** 探索する変位の上限 [mm]。 */
  maxDisplacementMm: number;
  /** 変位候補の量子化幅 [mm]。記述子格子の整数倍に丸められる。 */
  displacementStepMm: number;
  /** 記述子を計算する等方解像度 [mm]。細かくすると精度は上がるが**大幅に遅くなる**。 */
  descriptorSpacingMm: number;
  /**
   * 正則化の重み。
   *
   * <p>実測ではほとんど効かない（2 と 20 で結果がほぼ同じ）。滑らかさを変えたいときは
   * `smoothingSigma` を動かすこと。残してあるのは検証用。
   */
  regularizationWeight: number;
}

/**
 * 既定の乱数シード。
 *
 * <p>値そのものに意味は無い。**固定されていること**だけが要件で、
 * 同じ入力・同じシードなら同じ結果になる（設計 §6）。ここを変えると
 * 剛体のサンプリングが変わるので、下に書いてある実測値も測り直すこと。
 */
export const DEFAULT_SEED = 76;

export type PresetId = "standard" | "smooth" | "accurate";

/**
 * 標準。R3/R4 の既定値そのもの。
 *
 * <p>GNBP-2R 実測（seed 76）:
 * <ul>
 *   <li>剛体・同一モダリティ: 並進 0.046mm / 回転 0.027°</li>
 *   <li>剛体・マルチモーダル (MI): 並進 0.281mm / 回転 0.317°</li>
 *   <li>非剛体（シードに依存しない）: landmark TRE 1.63mm・Jacobian 0.44–2.35</li>
 * </ul>
 *
 * <p>⚠️ **マルチモーダルの回転は受け入れ目標 0.2° に届いていない**。5 シードで
 * 0.088 / 0.184 / 0.259 / 0.317 / 0.435° とばらつき、目標を満たすかどうかが
 * シードで決まる。以前 0.184° で PASS していたのは運であり、実力ではない
 * （設計 §9.4 の目標そのものを見直すか、推定器を改善する必要がある）。
 * 同一モダリティ側は 1 桁の余裕があるので、この問題は MI 特有。
 */
export const STANDARD_PARAMS: RegistrationParams = {
  metric: "auto",
  samplesPerIteration: 3000,
  maxIterationsPerLevel: 120,
  seed: DEFAULT_SEED,
  limitTranslationMm: null,
  limitRotationDeg: null,
  controlSpacingsMm: [48, 24, 12],
  smoothingSigma: 1.0,
  maxDisplacementMm: 16,
  displacementStepMm: 2,
  descriptorSpacingMm: 4,
  regularizationWeight: 8,
};

/**
 * 滑らか重視。**変形を物理的にありえる範囲に寄せる**。
 * GNBP-2R 実測: Jacobian 0.57–1.64（標準は 0.44–2.35）、landmark TRE 2.02mm。
 * 脳や、ずれが位置由来の PET/CT のように、体積があまり変わらないはずの対象向け。
 */
export const SMOOTH_PARAMS: RegistrationParams = {
  ...STANDARD_PARAMS,
  smoothingSigma: 1.5,
  controlSpacingsMm: [48, 24, 16],
};

/**
 * 精度重視。記述子を細かくし段を増やす。**目に見えて遅くなる**
 * （GNBP-2R で 3 秒 → 40 秒前後）。
 */
export const ACCURATE_PARAMS: RegistrationParams = {
  ...STANDARD_PARAMS,
  samplesPerIteration: 5000,
  maxIterationsPerLevel: 200,
  controlSpacingsMm: [48, 24, 12, 8],
  descriptorSpacingMm: 2,
};

export const PRESETS: Record<PresetId, RegistrationParams> = {
  standard: STANDARD_PARAMS,
  smooth: SMOOTH_PARAMS,
  accurate: ACCURATE_PARAMS,
};

/** パラメータが、あるプリセットと完全に一致するか（UI の選択表示用）。 */
export function matchingPreset(p: RegistrationParams): PresetId | null {
  for (const id of Object.keys(PRESETS) as PresetId[]) {
    if (sameParams(p, PRESETS[id])) return id;
  }
  return null;
}

export function sameParams(a: RegistrationParams, b: RegistrationParams): boolean {
  return a.metric === b.metric
    && a.samplesPerIteration === b.samplesPerIteration
    && a.maxIterationsPerLevel === b.maxIterationsPerLevel
    && a.seed === b.seed
    && a.limitTranslationMm === b.limitTranslationMm
    && a.limitRotationDeg === b.limitRotationDeg
    && a.controlSpacingsMm.length === b.controlSpacingsMm.length
    && a.controlSpacingsMm.every((v, i) => v === b.controlSpacingsMm[i])
    && a.smoothingSigma === b.smoothingSigma
    && a.maxDisplacementMm === b.maxDisplacementMm
    && a.displacementStepMm === b.displacementStepMm
    && a.descriptorSpacingMm === b.descriptorSpacingMm
    && a.regularizationWeight === b.regularizationWeight;
}

/** 「1, 2, 3」形式の文字列 ↔ 数値配列（制御点間隔の入力用）。 */
export function parseSpacings(text: string, fallback: number[]): number[] {
  const out = text
    .split(/[,、\s]+/)
    .map((s) => Number(s))
    .filter((v) => Number.isFinite(v) && v > 0);
  return out.length > 0 ? out : fallback;
}

export function formatSpacings(v: readonly number[]): string {
  return v.join(", ");
}
