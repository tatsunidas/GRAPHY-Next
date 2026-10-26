/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグインが `showLabelVolume` で出した Mask の出自（どのプラグインが出したか）。
// `removeLabelVolume` が「出した本人の Mask だけ」を消すための記録。本体・利用者・他プラグインの Mask は載らない。
// プラグイン ID は host が manifest から入れる値で、プラグインの引数は信用しない。
const origins = new Map<string, string>();

export function markLabelVolume(segmentationId: string, pluginId: string): void {
  origins.set(segmentationId, pluginId);
}

export function isLabelVolumeOf(segmentationId: string, pluginId: string): boolean {
  return origins.get(segmentationId) === pluginId;
}

export function forgetLabelVolume(segmentationId: string): void {
  origins.delete(segmentationId);
}

/** どれかのプラグインが出した Mask か（保存の対象外にする。プラグインの出力は、プラグインが作り直すもの）。 */
export function isPluginLabelVolume(segmentationId: string): boolean {
  return origins.has(segmentationId);
}
