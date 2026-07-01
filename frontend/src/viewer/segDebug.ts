/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * セグメンテーションの実状態を DevTools から確認するための診断ヘルパ。
 * Brush が無言で効かなくなった瞬間に、ブラウザ Console で `__graphySegDebug()` を実行すると、
 * アクティブ segmentation / viewport 上の representation / segment 色 / 現在スライスの labelmap キャッシュ有無を出力する。
 *
 * `getOperationData`（BrushTool）は `getSegmentIndexColor(vpId, activeSegId, activeIdx)` が null だと無言 no-op する。
 * null になるのは「その viewport にアクティブ segmentation の representation が無い」場合。ここを特定するのが目的。
 */
import { cache, getEnabledElements } from "@cornerstonejs/core";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { getSegEditTarget } from "./roiMaskStore";
import { getLastSegViewport } from "./segmentation";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyCsSeg = csSeg as any;

function dumpViewport(viewportId: string): unknown {
  const target = getSegEditTarget();
  let reps: unknown[] = [];
  try {
    reps = (anyCsSeg.state.getSegmentationRepresentations?.(viewportId) as unknown[]) ?? [];
  } catch { /* ignore */ }
  const activeCs = (() => {
    try { return anyCsSeg.activeSegmentation.getActiveSegmentation?.(viewportId); } catch { return undefined; }
  })();
  const activeSegId = target.segmentationId;
  let activeColor: unknown = null;
  try {
    if (activeSegId) activeColor = anyCsSeg.config.color.getSegmentIndexColor(viewportId, activeSegId, target.segmentIndex);
  } catch { /* ignore */ }
  let repHasActive = false;
  try {
    const r = anyCsSeg.state.getSegmentationRepresentations?.(viewportId, { segmentationId: activeSegId }) as unknown[];
    repHasActive = !!(r && r.length);
  } catch { /* ignore */ }
  let curLabelmapCached: unknown = null;
  try {
    const ids = activeSegId ? (anyCsSeg.state.getCurrentLabelmapImageIdsForViewport?.(viewportId, activeSegId) as string[] | undefined) : undefined;
    curLabelmapCached = (ids ?? []).map((id) => ({ id, cached: !!cache.getImage(id) }));
  } catch { /* ignore */ }
  return {
    viewportId,
    store_activeSegmentationId: activeSegId,
    store_activeSegmentIndex: target.segmentIndex,
    cs_activeSegmentation: activeCs?.segmentationId ?? activeCs,
    representationsOnViewport: (reps as { segmentationId?: string; type?: string }[]).map((r) => ({ segmentationId: r.segmentationId, type: r.type })),
    activeSegHasRepresentationHere: repHasActive,
    activeSegmentColor: activeColor,
    currentLabelmapImagesCached: curLabelmapCached,
  };
}

/** Console から呼ぶ: `__graphySegDebug()`（引数省略で直近フォーカスタイル＋全 enabled 要素）。 */
export function installSegDebug(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__graphySegDebug = (viewportId?: string) => {
    const focus = getLastSegViewport()?.viewportId;
    const out: Record<string, unknown> = {};
    const targetVp = viewportId ?? focus;
    if (targetVp) out.focused = dumpViewport(targetVp);
    try {
      out.allEnabled = getEnabledElements().map((e) => dumpViewport(e.viewportId));
    } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.log("[segDebug]", out);
    return out;
  };
}
