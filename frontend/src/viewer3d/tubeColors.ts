/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 管（`vtkTubeFilter`）に点ごとの色を効かせるための後始末。
 *
 * <h3>🚨 なぜ要るのか（2026-08-29・実機で発覚）</h3>
 * **`vtkTubeFilter` は入力の点データを出力へ運ぶが、それを「アクティブなスカラー」には
 * しない。** 出力の `getPointData().getArrayByName("Colors")` は取れるのに
 * `getPointData().getScalars()` は **null** を返す（vtk.js で実測）。
 *
 * <p>マッパー側で `setScalarVisibility(true)` /
 * `setScalarModeToUsePointData()` を立てても、**見に行く先のアクティブなスカラーが無い**ので
 * 色は乗らず、アクターの単色へ**黙って**落ちる。A7（血管に解析値を色で乗せる）は
 * これで丸ごと効いていなかった——**凡例も、値も、シーンの物体数も全部正しいまま、
 * 管だけが既定のシアン**という、DOM を見る検査では絶対に捕まらない壊れ方だった
 * （`fw/angio-design.md` §11.4）。
 *
 * <p>🔴 **一般化: フィルタを通した後は「配列があること」と「それがアクティブなスカラーで
 * あること」を別々に確かめる。** 前者だけ見て通すと、色は付かないのにエラーも出ない。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** 点ごとの色の配列名（入力にも出力にもこの名前で載せる）。 */
export const TUBE_COLOR_ARRAY = "Colors";

/**
 * フィルタ出力に運ばれてきた色の配列を、**アクティブなスカラーに設定し直す**。
 *
 * @returns 設定できたら true（配列が無い・形が違うなら false）
 */
export function activateTubeColors(polydata: Any, name: string = TUBE_COLOR_ARRAY): boolean {
  const pd = polydata?.getPointData?.();
  if (!pd) return false;
  // 既にアクティブなら何もしない（入力側の polydata をそのまま使った場合）。
  const current = pd.getScalars?.();
  if (current && current.getName?.() === name) return true;
  const arr = pd.getArrayByName?.(name);
  if (!arr) return false;
  // 点の数と合っていない配列を色として立てない（ずれた色が黙って乗る）。
  const tuples = arr.getNumberOfTuples?.();
  const points = polydata?.getNumberOfPoints?.();
  if (typeof tuples === "number" && typeof points === "number" && tuples !== points) return false;
  pd.setScalars(arr);
  return true;
}
