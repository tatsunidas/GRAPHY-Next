/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モダリティ校正（Rescale Slope/Intercept → CT の HU 等）値を Cornerstone のキャッシュ画像から
 * 読み取るための<b>唯一の入口</b>。「輝度の二重適用」を構造的に防ぐためのモジュール。
 *
 * <h3>なぜ必要か（背景）</h3>
 * Cornerstone の dicom-image-loader は <code>preScale.enabled</code> が既定 <b>true</b> のため、
 * Rescale が必要な画像（CT は Intercept≈−1024 等）では <code>image.getPixelData()</code> が
 * <b>既にモダリティ値（HU）</b>を返し、<code>image.preScale.scaled === true</code> が立つ。
 * ここで Rescale Slope/Intercept を<b>もう一度</b>掛けると二重適用になり、CT なら約 −1024 ずれる
 * （ヒストグラム・W/L・ROI 統計・MPR・Fusion が軒並み狂う）。実際に W/L ダイアログの
 * ヒストグラムと WL ラインの不一致として顕在化した。
 *
 * <h3>ルール</h3>
 * <ul>
 *   <li>画素をモダリティ値として読む時は、必ず {@link getModalityCalibration} か
 *       {@link readModalitySlice} を通すこと。</li>
 *   <li><b>getPixelData() に直接 <code>* slope + intercept</code> を書かない。</b>
 *       preScale 済みかどうかを個別に判定し忘れ、二重適用が再発する。</li>
 *   <li>{@link getModalityCalibration} は preScale 済みなら <code>{scale:1, offset:0}</code> を返すので、
 *       呼び出し側は常に <code>value = px[i] * scale + offset</code> と書けば正しくなる。</li>
 * </ul>
 */
import { metaData, imageLoader, cache } from "@cornerstonejs/core";
import { suvForImageId } from "./suvStore";

/** モダリティ校正係数。px → 校正値は <code>px * scale + offset</code>（preScale 済みなら {1, 0}）。 */
export interface ModalityCalibration {
  /** getPixelData() の値に掛ける係数（preScale 済みなら 1）。 */
  scale: number;
  /** 加えるオフセット（preScale 済みなら 0）。 */
  offset: number;
  /** getPixelData() が既にモダリティ値（HU 等）を返しているか。 */
  preScaled: boolean;
  /** 値の単位（CT は "HU" 等。未校正は "raw"）。 */
  unit: string;
}

/**
 * キャッシュ画像から「getPixelData() の値をモダリティ値へ変換する係数」を求める。
 *
 * <p>preScale 済み（getPixelData() が既に HU）なら {@code scale=1, offset=0}、未スケールなら
 * Rescale Slope/Intercept を返す。呼び出し側は分岐せず {@code px * scale + offset} を書けばよい。
 *
 * @param img cache.getImage(imageId)（または loadAndCacheImage の戻り）。null 可。
 * @param imageId modalityLutModule メタデータ取得に使う imageId。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getModalityCalibration(img: any, imageId: string): ModalityCalibration {
  const preScaled = Boolean(img?.preScale?.scaled);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lut: any = metaData.get("modalityLutModule", imageId) ?? {};
  const slope = Number(lut.rescaleSlope ?? img?.slope ?? 1);
  const intercept = Number(lut.rescaleIntercept ?? img?.intercept ?? 0);
  const calibrated = preScaled || lut.rescaleSlope !== undefined || lut.rescaleIntercept !== undefined;
  const unit = calibrated
    ? typeof lut.rescaleType === "string" && lut.rescaleType.trim()
      ? lut.rescaleType
      : ""
    : "raw";
  const base: ModalityCalibration = preScaled
    ? { scale: 1, offset: 0, preScaled: true, unit }
    : { scale: slope, offset: intercept, preScaled: false, unit };

  // SUV 校正済みシリーズ（PET）は、モダリティ値(Bq/mL)へさらに SUV 乗数を合成する。
  // これにより readModalitySlice を経由する ROI 統計・ヒストグラム・MPR が自動的に SUV 値になる。
  // SUV = modalityValue × suv.scale = (px × scale + offset) × suv.scale。
  const suv = suvForImageId(imageId);
  if (suv) {
    return {
      scale: base.scale * suv.scale,
      offset: base.offset * suv.scale,
      preScaled: base.preScaled,
      unit: suv.unit,
    };
  }
  return base;
}

/** 校正済みの 1 スライス（row-major の float 値）。 */
export interface ModalitySlice {
  /** width*height, モダリティ値（未校正なら生値、カラーは輝度）。 */
  values: Float32Array;
  width: number;
  height: number;
  /** 値の単位（CT の "HU" 等。未校正・カラーは "raw"）。 */
  unit: string;
}

/**
 * imageId のピクセルを校正済み float スライスとして読み出す（未ロードなら読み込む）。
 * カラー（RGB）画像は輝度（ITU-R BT.601）へ変換する。取得不能なら null。
 * 校正の適用可否は {@link getModalityCalibration} に一元化しているため二重適用しない。
 */
export async function readModalitySlice(imageId: string): Promise<ModalitySlice | null> {
  try {
    await imageLoader.loadAndCacheImage(imageId);
  } catch {
    /* すでにキャッシュ済みなら getImage で拾える */
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const img: any = cache.getImage(imageId);
  if (!img) return null;
  const px = img.getPixelData?.() as ArrayLike<number> | undefined;
  const width: number = img.columns ?? img.width;
  const height: number = img.rows ?? img.height;
  if (!px || !width || !height) return null;

  const n = width * height;
  const comps = Math.max(1, Math.round(px.length / n));
  const values = new Float32Array(n);
  if (comps >= 3) {
    // カラーは輝度（ITU-R BT.601）に落とす。校正は掛けない。
    for (let i = 0; i < n; i++) {
      const o = i * comps;
      values[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
    }
    return { values, width, height, unit: "raw" };
  }
  const { scale, offset, unit } = getModalityCalibration(img, imageId);
  for (let i = 0; i < n; i++) values[i] = px[i] * scale + offset;
  return { values, width, height, unit };
}
