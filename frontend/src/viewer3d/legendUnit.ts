/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { defaultUnitForModality } from "../viewer/pixelCalibration";

/**
 * 3D の色の凡例に添える単位。**3D のボリュームの値の単位**にする。
 *
 * <p>3D 窓は別の窓で、2D の SUV 校正の登録を共有しない。ボリュームの値は常にモダリティ値（PET は Bq/mL）なので、
 * 「PT なら SUV」と決めると、Bq/mL の数値に SUV の単位が付いてしまう。校正値を 3D で見るには、
 * 校正値を保存したシリーズ（Parametric Map。RescaleType が単位）を開く。
 *
 * @param resolved 最初のスライスの `resolveValueUnit`（RescaleType → モダリティ既定 → "raw"）。無ければ undefined
 * @param modality 起動元シリーズのモダリティ。resolved が無いとき（再サンプルした連結ボリュームなど）の既定に使う
 * @returns 単位。決まらなければ空文字（それらしい単位を捏造しない）
 */
export function legendUnit(resolved: string | undefined, modality: string | null): string {
  // "raw" は「校正が無い」印。単位としては出さない。
  if (resolved !== undefined) return resolved === "raw" ? "" : resolved;
  return defaultUnitForModality(modality ?? undefined);
}
