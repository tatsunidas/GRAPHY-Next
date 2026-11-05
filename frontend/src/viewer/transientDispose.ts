/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { parsePluginVolumeImageId, releaseValueStack } from "../plugins/pluginVolumeScheme";
import type { TransientOpened } from "./transientSeries";

/**
 * 一時シリーズのタイルが消えたときの後始末。値のスタックを解放し、その画像に描かれた annotation も消す
 * （スタックが無くなった後に残る ROI は、どの画像にも属さない幽霊になり、統計の再計算も失敗する）。
 */
export function disposeTransient(t: TransientOpened): void {
  const tokens = new Set(t.maps.map((m) => m.token));
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const all = (csAnnotation.state.getAllAnnotations() ?? []) as any[];
    for (const a of all) {
      const id = a?.metadata?.referencedImageId as string | undefined;
      const parsed = id ? parsePluginVolumeImageId(id) : null;
      if (parsed && tokens.has(parsed.token) && a.annotationUID) csAnnotation.state.removeAnnotation(a.annotationUID);
    }
  } catch {
    /* annotation state が未初期化なら消すものも無い */
  }
  for (const m of t.maps) releaseValueStack(m.token);
}
