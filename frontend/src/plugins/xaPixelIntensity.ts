/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `PixelIntensityRelationship (0028,1040)` を読む（純関数）。
 *
 * <p>プラグインが QCA の径を測るとき、`LIN`（画素が透過強度に比例）なら対数を取る必要があり、
 * `LOG` なら不要。取り違えると密度計測の径が大きく外れる（LIN の画像を LOG と思うと、仮想血管で 3.1 mm の血管が
 * 5 mm 台に出た）。タグが無い・空なら null を返し、推測で埋めない。
 */
export function pixelIntensityRelationshipOf(ds: { string(tag: string): string | undefined }): string | null {
  const v = ds.string("x00281040")?.trim();
  return v ? v : null;
}
