/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 特徴量表の画面の欄 → RadiomicsJ の設定キー。
 *
 * <p>キーは RadiomicsJ の `SettingParams` の名前そのもの（訳し替えない）。同じ設定を RadiomicsJ の
 * CLI・ImageJ・Python に渡せば同じ値になるようにするため。Next のテクスチャ設定（環境設定 ▸ テクスチャ）は
 * マップ用で、ここでは読まない。
 */

import { DEFAULT_SCALES, parseScaleLabels, parseScaleSpec, type ScaleNotation } from "./scaleSpec";

export const SCALE_CONVERSIONS = ["SQRT_D", "IDENTITY", "COEFFICIENT"] as const;
export type ScaleConversion = (typeof SCALE_CONVERSIONS)[number];

/** 族のスイッチ。`key` は結果表の列名の接頭辞、`setting` は RadiomicsJ の有効化キー。並びは RadiomicsJ の計算順。 */
export interface RoiFeatureFamily {
  key: string;
  setting: string;
  /** RadiomicsJ の既定。 */
  defaultOn: boolean;
}

export const ROI_FEATURE_FAMILIES: readonly RoiFeatureFamily[] = [
  { key: "Morphology", setting: "BOOL_enableMorphological", defaultOn: true },
  { key: "LocalIntensity", setting: "BOOL_enableLocalIntensityFeatures", defaultOn: true },
  { key: "IntensityBasedStatistical", setting: "BOOL_enableIntensityBasedStatistics", defaultOn: true },
  { key: "IntensityHistogram", setting: "BOOL_enableIntensityHistogram", defaultOn: true },
  { key: "IntensityVolumeHistogram", setting: "BOOL_enableIntensityVolumeHistogram", defaultOn: true },
  { key: "Shape2D", setting: "BOOL_enableShape2D", defaultOn: false },
  { key: "GLCM", setting: "BOOL_enableGLCM", defaultOn: true },
  { key: "GLRLM", setting: "BOOL_enableGLRLM", defaultOn: true },
  { key: "GLSZM", setting: "BOOL_enableGLSZM", defaultOn: true },
  { key: "GLDZM", setting: "BOOL_enableGLDZM", defaultOn: true },
  { key: "NGTDM", setting: "BOOL_enableNGTDM", defaultOn: true },
  { key: "NGLDM", setting: "BOOL_enableNGLDM", defaultOn: true },
  { key: "Fractal", setting: "BOOL_enableFractal", defaultOn: true },
  { key: "GLAM", setting: "BOOL_enableGLAM", defaultOn: false },
];

/**
 * 離散化（ビン数かビン幅）を使う族。RadiomicsJ の `extractAll` が `BOOL_USE_FixedBinNumber`・
 * `nBins`・`binWidth` を渡している族（RadiomicsJ 2.4.1 で確認）。IVH は別の設定で離散化する。
 */
export const DISCRETISED_FAMILIES: ReadonlySet<string> = new Set([
  "IntensityHistogram", "GLCM", "GLRLM", "GLSZM", "GLDZM", "NGTDM", "NGLDM", "GLAM",
]);
export const IVH_FAMILY = "IntensityVolumeHistogram";

export interface RoiFeatureForm {
  fixedBinNumber: boolean;
  binCount: number;
  binWidth: number;
  /** 等方にそろえる画素間隔（mm）。null ならリサンプリングしない。 */
  resampleMm: number | null;
  /** 族の key → 有効か。 */
  families: Record<string, boolean>;
  /** 画像フィルタ LoG（RadiomicsJ 2.5 以降）。オンなら σ ごとの列が元の列の後ろに足される。 */
  logOn: boolean;
  /** σ（mm）。カンマか空白で区切って複数。 */
  logSigmaMm: string;
  /** 核の切り捨て（σ の倍数）。 */
  logTruncate: number;
  logPadding: LogPadding;
  /** true なら σ を直接ではなく、強調する構造の半径 r（mm）の並びで指定する（logOn のとき）。 */
  logByRadius: boolean;
  /** スケールの値の並び（半径 mm か幅 画素）。カンマか空白で区切り、「開始:終了:刻み」の走査も書ける。0 はフィルタなし。 */
  scalesText: string;
  scaleNotation: ScaleNotation;
  /** 名札（旧フィルタ値など。カンマ区切り、空欄は名札なし）。計算には使わず記録だけ。 */
  scaleLabelsText: string;
  scaleConversion: ScaleConversion;
  /** COEFFICIENT のときの k（σ = k·r）。 */
  scaleK: number;
}

export const LOG_PADDINGS = ["MIRROR", "NEAREST", "CONSTANT", "PERIODIC"] as const;
export type LogPadding = (typeof LOG_PADDINGS)[number];

/** σ の入力（カンマ・空白区切り、走査「開始:終了:刻み」も可）を数に直す。正の有限数でないものが 1 つでもあれば null。 */
export function parseSigmaList(text: string): number[] | null {
  const r = parseScaleSpec(text);
  return r.values && r.values.every((v) => v > 0) ? r.values : null;
}

/**
 * フィルタ後の族の列名（`log_sigma1.5mm_GLCM` の族）を、σ と元の族に分ける。フィルタ後でなければ null。
 * 元の族の定義（離散化など）はそのまま使えるので、表示と定義表で元の族を引くのに使う。
 */
export function splitFilteredFamily(family: string): { sigma: string; base: string } | null {
  const m = /^log_sigma([^_]+)mm_(.+)$/.exec(family);
  return m ? { sigma: m[1], base: m[2] } : null;
}

/** RadiomicsJ の既定（ビン数 32・ビン幅 25・リサンプリングなし・GLAM と Shape2D はオフ）。 */
export function defaultRoiFeatureForm(): RoiFeatureForm {
  return {
    fixedBinNumber: true,
    binCount: 32,
    binWidth: 25,
    resampleMm: null,
    logOn: false,
    logSigmaMm: "1.5",
    logTruncate: 4,
    logPadding: "MIRROR",
    logByRadius: false,
    scalesText: DEFAULT_SCALES,
    scaleNotation: "RADIUS_MM",
    scaleLabelsText: "",
    scaleConversion: "SQRT_D",
    scaleK: 1,
    families: Object.fromEntries(ROI_FEATURE_FAMILIES.map((f) => [f.key, f.defaultOn])),
  };
}

/** スケールで指定するときの、要求のスケールの欄（σ で指定するときは空）。 */
export function roiFeatureScaleRequest(form: RoiFeatureForm): {
  scales?: number[]; scaleNotation?: ScaleNotation; scaleLabels?: string[];
  scaleConversion?: ScaleConversion; scaleCoefficient?: number;
} {
  if (!form.logOn || !form.logByRadius) return {};
  const spec = parseScaleSpec(form.scalesText);
  if (!spec.values) return {};
  const labels = parseScaleLabels(form.scaleLabelsText, spec.values.length);
  return {
    scales: spec.values,
    scaleNotation: form.scaleNotation,
    ...(Array.isArray(labels) ? { scaleLabels: labels } : {}),
    scaleConversion: form.scaleConversion,
    ...(form.scaleConversion === "COEFFICIENT" ? { scaleCoefficient: form.scaleK } : {}),
  };
}

export const anyFamilyOn = (form: RoiFeatureForm) => ROI_FEATURE_FAMILIES.some((f) => form.families[f.key]);

/**
 * 送る設定。Diagnostics は既定のまま（オン）にするので送らない。患者情報の `BOOL_enableOperationalInfo` と
 * マスクの値 `INT_label` は backend が必ず上書きするので送らない。
 */
export function roiFeatureSettings(form: RoiFeatureForm): Record<string, string> {
  const s: Record<string, string> = {
    BOOL_USE_FixedBinNumber: form.fixedBinNumber ? "1" : "0",
  };
  if (form.fixedBinNumber) s.INT_binCount = String(form.binCount);
  else s.DOUBLE_binWidth = String(form.binWidth);
  // 名前は factor だが、RadiomicsJ は目標の画素間隔（mm）として読む（新しい寸法 = 元の寸法 × 元の間隔 / 値）。
  if (form.resampleMm != null) {
    const v = String(form.resampleMm);
    s.DOUBLEARRAY_resamplingFactorXYZ = `${v},${v},${v}`;
  }
  for (const f of ROI_FEATURE_FAMILIES) s[f.setting] = form.families[f.key] ? "1" : "0";
  if (form.logOn) {
    // 半径で指定するときの σ は backend がスケールごとに換算して足す
    const sigmas = form.logByRadius ? null : parseSigmaList(form.logSigmaMm);
    if (sigmas) s.DOUBLEARRAY_logSigmaMm = sigmas.join(",");
    s.DOUBLE_logTruncate = String(form.logTruncate);
    s.STRING_logPadding = form.logPadding;
  }
  return s;
}
