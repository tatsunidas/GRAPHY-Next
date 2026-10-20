/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { FusionSlice } from "./fusionEngine";
import { getModalityCalibration } from "./pixelCalibration";

/** 校正を掛ける前の前景スライス（キャッシュに持つのはこちら）。 */
export interface RawFusionSlice {
  ipp: [number, number, number];
  pixels: FusionSlice["pixels"];
  /** cornerstone の画像が持つ校正の手がかり（getModalityCalibration が読む）。 */
  preScale?: { scaled?: boolean };
  slope?: number;
  intercept?: number;
}

/**
 * 生スライスを、**いまの**校正（SUV 乗数の合成を含む）で FusionSlice にする。
 * 校正をキャッシュに焼き込むと、SUV 校正を後から付けたり外したりしたときに古い係数が残るため、
 * 呼ぶたびに求める。
 */
export function toFusionSlice(raw: RawFusionSlice, imageId: string): FusionSlice {
  const cal = getModalityCalibration(raw, imageId);
  return { ipp: raw.ipp, pixels: raw.pixels, slope: cal.scale, intercept: cal.offset };
}
