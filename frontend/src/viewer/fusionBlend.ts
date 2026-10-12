/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * Fusion の前景の重ね方。**表示上の合成**（W/L・LUT を通した後の 8bit の見た目どうしの差・積）で、
 * 画素値（HU・SUV など）の引き算ではない。
 */
export type FusionBlend = "normal" | "difference" | "multiply";

export const FUSION_BLENDS: readonly FusionBlend[] = ["normal", "difference", "multiply"];

/** CSS の mix-blend-mode の値。知らない値は normal。 */
export function fusionBlendCss(blend: string | undefined | null): FusionBlend {
  return (FUSION_BLENDS as readonly string[]).includes(blend ?? "") ? (blend as FusionBlend) : "normal";
}
