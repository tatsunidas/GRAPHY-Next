/**
 * 要約インデックスの合成 — Java の `com.vis.uvs.analysis.SummaryComposer` の写し。
 *
 * <pre>
 * removeSet = colorRemove ∪ staticRemove
 * heartSet  = { i | interpolate(predScores)[i] &gt; threshold }   // 予測未実行なら全フレーム
 * final     = heartSet − removeSet
 * final     = (final − userRemove) ∪ userAdd                    // userAdd が最優先
 * </pre>
 *
 * 🔴 **正本は Java 側**。ここはしきい値を即時に反映するための写しであり、
 * 共有ベクタ `testdata/summary-composer-cases.json` と実機の `op:"compose"` 突き合わせで縛る。
 *
 * 🔴 **「確率で除外」を色・静止と足し合わせない。** 3 つは重なる。合計は `totalRemoved` で
 *    あって和ではない（画面にもそう書く）。
 */
import { all, asFrame1, interpolate, merge, oppose, subtract, type Frame1 } from "./indices";

/** 予測未実行を表す。`null` は「まだ走らせていない＝全フレームを心臓とみなす」。 */
export type Heart = readonly Frame1[] | null;

export interface Derived {
  colorRemove: Frame1[];
  staticRemove: Frame1[];
  heart: Frame1[];
  removedByPrediction: Frame1[];
  finalIndices: Frame1[];
}

export interface Results {
  numberOfFrames: number;
  totalRemoved: number;
  colorRemoved: number;
  staticRemoved: number;
  probaRemoved: number;
  userAdded: number;
  userRemoved: number;
  totalRate: number;
  colorRate: number;
  staticRate: number;
  probaRate: number;
}

export interface ComposeInput {
  frameCount: number;
  colorRemove?: readonly Frame1[] | null;
  staticRemove?: readonly Frame1[] | null;
  /** 確率閾値を超えたフレーム。**予測未実行なら null**（全フレームを心臓とみなす）。 */
  heart?: Heart;
  userAdd?: readonly Frame1[] | null;
  userRemove?: readonly Frame1[] | null;
}

export function compose(input: ComposeInput): Derived {
  const { frameCount } = input;
  const colorAndStatic = merge(input.colorRemove, input.staticRemove);

  // 予測が 1 度も走っていなければ全フレームを「心臓」とみなす（色 / 静止だけでも要約できる）。
  const heartSet = input.heart != null ? merge(input.heart, []) : all(frameCount);

  let result = subtract(heartSet, colorAndStatic);
  result = subtract(result, input.userRemove);
  result = merge(result, input.userAdd);

  return {
    colorRemove: merge(input.colorRemove, []),
    staticRemove: merge(input.staticRemove, []),
    heart: heartSet,
    removedByPrediction: oppose(heartSet, frameCount) ?? [],
    finalIndices: result,
  };
}

/**
 * 予測スコアを補間し、閾値を当てて「心臓フレーム」を求める。
 *
 * @param known 疎な予測スコアを**サンプル順に並べた密配列**。空なら null を返す
 *
 * 🔴 **穴あきを詰めて渡さない。** Java 側は値の並び順しか見ない（キーを見ない）ので、
 * 途中のチャンクが失敗したぶんを前へ詰めると、以降がまるごと 1 サンプルぶんずれる。
 * 1 つでも欠けているなら合成せず「未計算」と表示すること。
 */
export function applyPredictionThreshold(
  known: readonly number[],
  frameCount: number,
  interval: number,
  threshold: number,
): { heart: Frame1[]; interpolated: number[] } | null {
  if (!known || known.length === 0) return null;

  // Swing と同じクランプ。しきい値ハンドルを端まで引いたときの挙動がここで決まる。
  let clamped = threshold;
  if (clamped > 1) clamped = 0.9999999;
  else if (clamped < 0.0000001) clamped = 0.0000001;

  const interpolated = interpolate(known, frameCount, Math.max(1, interval));
  const heart: Frame1[] = [];
  for (let i = 0; i < frameCount; i++) {
    // 🔑 **厳密に超過**（`>=` ではない）。境界のフレームの扱いが Java と変わる。
    if (interpolated[i] > clamped) heart.push(asFrame1(i + 1));
  }
  return { heart, interpolated };
}

/**
 * 除外率。
 * ⚠️ 色 / 静止 / 確率の各件数は**ユーザ追加分を差し引いて**数える（Swing と同じ）。
 * 🔴 3 つは重なるので**足し合わせない**。
 */
export function results(
  frameCount: number,
  derived: Derived,
  userAdd?: readonly Frame1[] | null,
  userRemove?: readonly Frame1[] | null,
): Results {
  const totalRemoved = frameCount - derived.finalIndices.length;
  const colorRemoved = subtract(derived.colorRemove, userAdd).length;
  const staticRemoved = subtract(derived.staticRemove, userAdd).length;
  const probaRemoved = frameCount - subtract(derived.heart, userAdd).length;
  const rate = (n: number): number => (frameCount > 0 ? n / frameCount : 0);
  return {
    numberOfFrames: frameCount,
    totalRemoved,
    colorRemoved,
    staticRemoved,
    probaRemoved,
    userAdded: userAdd?.length ?? 0,
    userRemoved: userRemove?.length ?? 0,
    totalRate: rate(totalRemoved),
    colorRate: rate(colorRemoved),
    staticRate: rate(staticRemoved),
    probaRate: rate(probaRemoved),
  };
}

/**
 * 走査結果（0-based の CPR / MAD 列）としきい値から、除外フレーム（1-based）を作る。
 *
 * 🔑 **0-based → 1-based の変換をここ 1 か所に閉じる。** 画面のあちこちで `+1` を書くと、
 * どこか 1 つ忘れたときに「1 フレームずれた、それらしい要約」が出る。
 *
 * @param from 走査の開始フレーム（0-based）。`cpr[k]` は原本の `from + k` に対応する
 */
export function removalsFromScan(
  from: number,
  cpr: readonly number[],
  mad: readonly number[],
  colorPixelRatioThreshold: number,
  staticMeanAbsDiffThreshold: number,
): { colorRemove: Frame1[]; staticRemove: Frame1[] } {
  const colorRemove: Frame1[] = [];
  const staticRemove: Frame1[] = [];
  for (let k = 0; k < cpr.length; k++) {
    if (cpr[k] > colorPixelRatioThreshold) colorRemove.push(asFrame1(from + k + 1));
  }
  for (let k = 0; k < mad.length; k++) {
    // 静止＝動きが小さい。🚨 しきい値は H.264 前提の 0.19（AVI の 0.5 ではない・設計 §7）。
    if (mad[k] < staticMeanAbsDiffThreshold) staticRemove.push(asFrame1(from + k + 1));
  }
  return { colorRemove, staticRemove };
}
