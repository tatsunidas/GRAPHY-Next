/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Cornerstone のビューポートを **1 スライスだけ**送る（キーボード用）。
 *
 * <p>ホイールは `StackScrollTool` が受けるが、あれはイベント 1 件につき 1 スライスで、
 * 入力デバイスの分解能に左右される（`wheelScroll.ts` で間引いてはいる）。
 * キーボードは**打鍵 = 1 スライスを確実に**したいので、ツールを介さず
 * `utilities.scroll` を直接叩く（`StackScrollTool._scroll` と同じ経路）。
 */
import { BaseVolumeViewport, utilities as csUtils, type Types } from "@cornerstonejs/core";

/**
 * `viewport` を `delta`（±1 など）だけ送る。ボリューム面でもスタック面でも同じ呼び方。
 *
 * <p>端では何も起きない（Cornerstone 側が範囲外を無視する）。失敗しても投げない
 * ——キー操作 1 回のために画面を落とさない。
 */
export function stepViewportSlice(viewport: Types.IViewport | null | undefined, delta: number): void {
  if (!viewport || !delta) return;
  try {
    csUtils.scroll(viewport as Types.IViewport, {
      delta,
      // ボリューム面は対象ボリュームを明示する（複数積んでいると既定の解決が当てにならない）。
      volumeId: viewport instanceof BaseVolumeViewport ? viewport.getVolumeId() : undefined,
      debounceLoading: true,
      loop: false,
    });
  } catch {
    // 無効化直後・画像ゼロなどは黙って何もしない（scroll は throw する）。
  }
}
