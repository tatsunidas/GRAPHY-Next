/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * NIfTI の取り込みで選ぶ「値の単位」（fw/nifti-import.md §3.1）。
 *
 * <p>NIfTI は単位を持たないので、取り込む人が選ぶ。backend へは UCUM のコードで渡し、
 * Parametric Map では RWVM の単位に、通常の画像では RescaleType（表示名）に入る。
 */

/** 選べる単位。`ucum` は backend へ渡すコード（"1" は単位なし）。`other` は自由入力。 */
export const NIFTI_UNIT_OPTIONS = [
  { key: "none", ucum: "1", labelKey: "nifti.unit.none" },
  { key: "suv", ucum: "{SUVbw}g/ml", labelKey: "nifti.unit.suv" },
  { key: "bqml", ucum: "Bq/ml", labelKey: "nifti.unit.bqml" },
  { key: "mm2s", ucum: "mm2/s", labelKey: "nifti.unit.mm2s" },
  { key: "ms", ucum: "ms", labelKey: "nifti.unit.ms" },
  { key: "hu", ucum: "[hnsf'U]", labelKey: "nifti.unit.hu" },
  { key: "other", ucum: null, labelKey: "nifti.unit.other" },
] as const;

export type NiftiUnitKey = (typeof NIFTI_UNIT_OPTIONS)[number]["key"];

/**
 * 選んだ単位を backend へ渡す UCUM のコードにする。
 *
 * @returns コード（単位なしは "1"）。「その他」で入力が空・長すぎる（16 文字超）・`\` を含むときは null
 *   （DICOM の CodeValue に入らない。backend も同じ条件で弾く）。
 */
export function niftiUnitCode(key: NiftiUnitKey, custom: string): string | null {
  const opt = NIFTI_UNIT_OPTIONS.find((o) => o.key === key);
  if (!opt) return null;
  if (opt.ucum !== null) return opt.ucum;
  const v = custom.trim();
  if (!v || v.length > 16 || v.includes("\\")) return null;
  return v;
}
