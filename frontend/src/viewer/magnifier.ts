/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/** 拡大レンズの倍率。 */
export const MAGNIFIER_FACTOR = 4;

/**
 * Cornerstone の `MagnifyTool` に渡す `magnifySize`。
 *
 * <p>🔴 **`magnifySize` は倍率ではない。** レンズのカメラは元の `parallelScale`（＝ビューポートの高さの半分に
 * 映る長さ）を `magnifySize` で割るだけなので、実際の倍率は `magnifySize × レンズの高さ ÷ ビューポートの高さ` になる。
 * 4 をそのまま渡すと、高さ 1000px のビューポートでは 1 倍（拡大しない）だった（実機で確認）。
 * そこで押した時点のビューポートの高さから逆算する。
 */
export function magnifySizeFor(factor: number, viewportHeightPx: number, lensHeightPx: number): number {
  if (!(viewportHeightPx > 0) || !(lensHeightPx > 0)) return factor;
  return (factor * viewportHeightPx) / lensHeightPx;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * レンズを出す直前（押した時点）に、そのビューポートの高さで `magnifySize` を合わせる。
 * ツールグループは大きさの違うタイルで共有されるので、登録時の固定値では倍率が揃わない。
 */
export function installTrueMagnification(tool: Any, factor = MAGNIFIER_FACTOR): void {
  if (!tool || tool.__graphyTrueMagnification) return;
  const original = tool.preMouseDownCallback;
  if (typeof original !== "function") return;
  tool.preMouseDownCallback = (evt: Any) => {
    const element = evt?.detail?.element as HTMLElement | undefined;
    const h = element?.clientHeight ?? 0;
    tool.configuration.magnifySize = magnifySizeFor(factor, h, tool.configuration.magnifyHeight);
    return original(evt);
  };
  tool.__graphyTrueMagnification = true;
}
