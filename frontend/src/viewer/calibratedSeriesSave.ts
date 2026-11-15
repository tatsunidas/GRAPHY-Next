/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 校正済みの値（SUV 4 種・%ID/cc・SUVR）を派生シリーズ（DICOM Parametric Map）として保存するための純関数。
 * POST の層は {@link ./calibratedSeriesSaveRun}。
 *
 * <p>値は `loadRegVolume`（校正込み）のまま保存する。Parametric Map は値がそのまま実際の量なので、
 * 校正の乗数で割り戻さない（`saveDerivedVolume` の `suvScale` は渡さない）。
 */
import type { Grid } from "./gridResample";
import type { RegVolume } from "./regGeometry";
import type { SuvCalibration } from "./suvStore";

export interface CalibrationUnit {
  /** UCUM のコード（DICOM の CodeValue は SH＝16 文字以内、`\` 不可）。 */
  unitCode: string;
  /** 読み戻したときの単位表示（backend が CodeMeaning を RescaleType に写し、フロントがそのまま出す）。 */
  unitMeaning: string;
}

/**
 * 校正 → 単位。
 *
 * <p>PS3.16 CID 85（SUV Unit）にあるのは `g/ml{SUVbw}`・`g/ml{SUVlbm}`（James）・`cm2/ml{SUVbsa}` など。
 * Janmahasatian の正式コード `g/ml{SUVlbm(Janma)}` は 19 文字で SH（16 文字）に入らないため、UCUM の注釈として
 * `g/ml{SUVjanma}` を使う。%ID/cc・SUVR に当たる標準コードは無く、UCUM の注釈（`%{ID}/ml`・`{SUVR}`）にする。
 * CodeMeaning は標準の長い名前ではなく、読み戻しの単位表示に使う短い名前にする。
 */
export function calibrationUnit(cal: Pick<SuvCalibration, "type" | "unit">): CalibrationUnit {
  switch (cal.type) {
    case "bw":
      return { unitCode: "g/ml{SUVbw}", unitMeaning: "SUVbw" };
    case "sul-james":
      return { unitCode: "g/ml{SUVlbm}", unitMeaning: "SUVlbm" };
    case "sul-janma":
      return { unitCode: "g/ml{SUVjanma}", unitMeaning: "SUVlbm" };
    case "bsa":
      return { unitCode: "cm2/ml{SUVbsa}", unitMeaning: "SUVbsa" };
    case "pid":
      return { unitCode: "%{ID}/ml", unitMeaning: "%ID/cc" };
    case "suvr":
      return { unitCode: "{SUVR}", unitMeaning: "SUVR" };
  }
}

/** 元の格子のまま（補間しない）の出力格子。`axisGrid` と違い、傾いた元でも IPP・IOP・枚数を変えない。 */
export function gridOfVolume(vol: RegVolume): Grid {
  const m = vol.indexToWorld;
  const sc = Math.hypot(m[0], m[4], m[8]);
  const sr = Math.hypot(m[1], m[5], m[9]);
  // 列方向 × 行方向（`loadRegVolume`・`axisGrid` と同じ法線）。スライス間隔は法線への射影（IPP の傾きは各フレームの IPP が持つ）。
  const c = [m[0] / sc, m[4] / sc, m[8] / sc];
  const r = [m[1] / sr, m[5] / sr, m[9] / sr];
  const n = [c[1] * r[2] - c[2] * r[1], c[2] * r[0] - c[0] * r[2], c[0] * r[1] - c[1] * r[0]];
  const sk = Math.abs(m[2] * n[0] + m[6] * n[1] + m[10] * n[2]);
  return { dims: vol.dims, spacing: [sc, sr, sk], indexToWorld: vol.indexToWorld, worldToIndex: vol.worldToIndex };
}

/**
 * 実測の IPP と、ボリュームのアフィンから求めた IPP の最大差を、スライス間隔に対する比で返す。
 * アフィン 1 つで表せるのは等間隔の元だけ。不均一な元をそのまま保存すると、各スライスの位置が元からずれる。
 */
export function sliceDeviation(vol: RegVolume, slices: ReadonlyArray<{ ipp: readonly [number, number, number] }>): number {
  const m = vol.indexToWorld;
  const step = Math.hypot(m[2], m[6], m[10]);
  if (!(step > 0) || slices.length !== vol.dims[2]) return Infinity;
  let max = 0;
  for (let k = 0; k < slices.length; k++) {
    const e = [m[2] * k + m[3], m[6] * k + m[7], m[10] * k + m[11]];
    const d = Math.hypot(slices[k].ipp[0] - e[0], slices[k].ipp[1] - e[1], slices[k].ipp[2] - e[2]);
    if (d > max) max = d;
  }
  return max / step;
}

/**
 * 均一とみなす許容（スライス間隔に対する比）。IPP の数値精度の床（DICOM の DS は 16 文字で約 1e-5 mm）を
 * 十分に上回り、実際の不均一（数 % 以上）よりずっと小さい値として 0.1%。
 */
export const SLICE_UNIFORM_TOLERANCE = 1e-3;

export function isUniformStack(vol: RegVolume, slices: ReadonlyArray<{ ipp: readonly [number, number, number] }>): boolean {
  return sliceDeviation(vol, slices) <= SLICE_UNIFORM_TOLERANCE;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : s.slice(0, n));

/** 保存するシリーズの名前（64 文字以内。末尾の単位は残し、元の名前を切る）と派生の説明。 */
export function describeCalibratedSave(
  cal: Pick<SuvCalibration, "type" | "unit" | "scale" | "ref">,
  sourceDescription: string,
): { seriesDescription: string; derivationDescription: string; label: string; explanation: string } {
  const { unitMeaning } = calibrationUnit(cal);
  const suffix = ` ${unitMeaning}`;
  const base = clip(sourceDescription || "Series", 64 - suffix.length);
  const parts = [`Calibrated values (${cal.unit}) = modality value x ${cal.scale.toPrecision(6)}`];
  if (cal.ref) parts.push(`Reference: ${cal.ref.label} mean ${cal.ref.mean.toPrecision(6)} ${cal.ref.unit} n=${cal.ref.n}`);
  return {
    seriesDescription: `${base}${suffix}`,
    derivationDescription: parts.join(". "),
    label: clip(unitMeaning.replace(/[^A-Za-z0-9%/_ -]/g, "_"), 16),
    explanation: clip(`Calibrated ${cal.unit}`, 64),
  };
}
