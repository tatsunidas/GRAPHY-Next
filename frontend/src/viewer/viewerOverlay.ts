/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ビューアの上に重ねる器（解析ダイアログ等）の目印。
 *
 * <h3>なぜ要るのか（実機で言われた・2026-09-01）</h3>
 * **QCA / QVA / LV の解析中、ダイアログを縦にスクロールしようとすると、ダイアログは動かず
 * 裏の画像のフレームが送られる。**
 *
 * <p>原因は DOM の入れ子。解析ダイアログは `SeriesViewer` の**根の子**として描かれるので、
 * ダイアログの中で回したホイールが**ビューアのホイールハンドラまでバブリングする**。
 * ハンドラは無条件に `preventDefault()` していたため、
 *
 * - ブラウザ既定の縦スクロールが**殺される**（ダイアログの中身が動かない）
 * - 代わりに `step(±1)` が走って**裏のフレームが送られる**
 *
 * となっていた。錠（`sliceNavigationLock.ts`）はフレーム送りだけを止めるので、
 * **掛かっていてもスクロールは戻らない**（`preventDefault` は先に走っている）。
 *
 * <p>🔴 **器の中のホイールはビューアのものではない。** 位置で判定せず、器に目印を付けて
 * 「自分の外から来たイベントか」で判定する。器は増える（PR・解析・QLV・3D QCA…）ので、
 * ビューア側に器の一覧を持たせない。
 */

/** 器の最外殻に付ける属性。 */
export const VIEWER_OVERLAY_ATTR = "data-viewer-overlay";

/** 器の最外殻へ展開する（`<div {...viewerOverlayProps}>`）。 */
export const viewerOverlayProps = { [VIEWER_OVERLAY_ATTR]: "" } as const;

/** 祖先を辿れるもの。DOM の `Element` はこれを満たす。 */
interface ClosestLike {
  closest?: (selectors: string) => unknown;
}

/**
 * イベントの発生元が器の中か。
 *
 * <p>⚠️ `instanceof Element` で判定しない——**別ウィンドウ（別 realm）の要素で false になる**。
 * GRAPHY は 2D / 3D / MPR を別ウィンドウで開くので、これは実際に起こる。`closest` を
 * 持っているかどうかで見る（`document` やプレーンなオブジェクトは持たないので自然に外れる）。
 */
export function isInsideViewerOverlay(target: EventTarget | null): boolean {
  const el = target as ClosestLike | null;
  if (!el || typeof el.closest !== "function") return false;
  return el.closest(`[${VIEWER_OVERLAY_ATTR}]`) != null;
}
