/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `readXaSeries` が返す撮影情報（H42）。決め方は H40 `getXaCine` と同じ（`resolveXaFps`・`frameStartTimesMs`・
 * `isUniformFrameTime`）。プラグインがビューアのタイルを開かずに、cQFR / aQFR のフレームカウントをするのに使う。
 */
import { frameStartTimesMs, isUniformFrameTime, resolveXaFps, type XaCineSource, type XaFpsSource } from "../viewer/xaCineTiming";

export interface PluginXaSeriesCine {
  numberOfFrames: number;
  fps: number;
  /** 🔴 `"default"` は測定値ではない（どのタグからも決まらなかった）。 */
  fpsSource: XaFpsSource;
  frameStartTimesMs: number[];
  uniform: boolean;
}

/** dataSet から読んだ材料から撮影情報を作る。材料が無ければ null（既定値で埋めない）。 */
export function cineOfSource(src: XaCineSource | null): PluginXaSeriesCine | null {
  if (!src) return null;
  const { fps, source } = resolveXaFps(src);
  return {
    numberOfFrames: src.numberOfFrames,
    fps,
    fpsSource: source,
    frameStartTimesMs: frameStartTimesMs(src),
    uniform: isUniformFrameTime(src),
  };
}
