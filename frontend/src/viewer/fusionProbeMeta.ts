/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { calibratedUnit, readImageInfo } from "./imageInfo";

/**
 * 前景のカーソル値表示に添えるメタ（単位・SUV 乗数）を、実際に読んだ前景スライスから解決する。
 * 校正の解釈は `readImageInfo`／`calibratedUnit` に任せ、ここで slope/intercept を触らない。
 * Fusion の前景値は `getModalityCalibration`（SUV 乗数を合成済み）で作るので、読み出し側で掛ける乗数は常に 1。
 */
export function probeMetaOf(fgImageId: string): { unit: string; scale: number; suv: boolean } {
  const info = readImageInfo(fgImageId);
  if (info.suvScale !== undefined) return { unit: info.suvUnit ?? "SUV", scale: 1, suv: true };
  return { unit: calibratedUnit(info), scale: 1, suv: false };
}
