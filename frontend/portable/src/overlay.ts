/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 画像上オーバレイ（4 隅）のタグ解決。本体 frontend/src/viewer/overlayText.ts のロジックを
// 移植（vanilla・脱 React。設定ストアは持たず portable 固定 config）。
// 値は表示中 imageId の dicom-parser DataSet（wadouri の dataSetCacheManager キャッシュ）を直読み。
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";

export interface OverlayField {
  /** 8 桁 hex（例 "00100010"）または特殊トークン "AGE"。 */
  tag: string;
  /** 値の前に付ける短いラベル（例 "ST" → "ST 3.0"）。省略可。 */
  label?: string;
  /** VR（PN/DA/TM のみ整形に使用）。 */
  vr?: "PN" | "DA" | "TM";
  /** 数値の単位（例 "kV"）。 */
  unit?: string;
}

export type OverlayCorner = "topLeft" | "topRight" | "bottomLeft";
export type ResolvedOverlay = Record<OverlayCorner, string[]>;

const MAX_VALUE_CHARS = 28;

// 表示中 imageId の DataSet（wadouri キャッシュ）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dataSetOf(imageId: string): any | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wadouri = (dicomImageLoader as any).wadouri;
    const { url } = wadouri.parseImageId(imageId);
    return wadouri.dataSetCacheManager.get(url) ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function rawValue(ds: any, tag: string): string | null {
  const v = ds?.string?.("x" + tag.toLowerCase());
  return v == null || v === "" ? null : String(v);
}

function fmtDate(v: string): string {
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : v;
}
function fmtTime(v: string): string {
  return /^\d{6}/.test(v) ? `${v.slice(0, 2)}:${v.slice(2, 4)}:${v.slice(4, 6)}` : v;
}
function fmtPN(v: string): string {
  return v.replace(/\^+/g, " ").trim();
}

/** 生年月日(YYYYMMDD)と検査日(YYYYMMDD)から満年齢。 */
function ageOf(birth: string | null, study: string | null): string | null {
  if (!birth || !study || !/^\d{8}$/.test(birth) || !/^\d{8}$/.test(study)) return null;
  const by = +birth.slice(0, 4), bm = +birth.slice(4, 6), bd = +birth.slice(6, 8);
  const sy = +study.slice(0, 4), sm = +study.slice(4, 6), sd = +study.slice(6, 8);
  let age = sy - by;
  if (sm < bm || (sm === bm && sd < bd)) age--;
  if (age < 0 || age > 200) return null;
  return `${age}Y`;
}

function truncate(s: string): string {
  return s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS - 1) + "…" : s;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function resolveField(field: OverlayField, ds: any): string | null {
  let value: string | null;
  if (field.tag === "AGE") {
    value = ageOf(rawValue(ds, "00100030"), rawValue(ds, "00080020"));
  } else {
    const raw = rawValue(ds, field.tag);
    if (raw == null) return null;
    switch (field.vr) {
      case "PN": value = fmtPN(raw); break;
      case "DA": value = fmtDate(raw); break;
      case "TM": value = fmtTime(raw); break;
      default: value = raw;
    }
  }
  if (value == null || value === "") return null;
  // 単位付き（＝数値）フィールドは末尾ゼロを整理（例 "5.000000" → "5", "247.000" → "247"）。
  if (field.unit) {
    const n = Number(value);
    if (Number.isFinite(n)) value = String(n);
    value = `${value} ${field.unit}`;
  }
  if (field.label) value = `${field.label} ${value}`;
  return truncate(value);
}

/** portable 固定オーバレイ config（下段右は viewer の動的値用に予約）。 */
export const PORTABLE_OVERLAY: Record<OverlayCorner, OverlayField[]> = {
  topLeft: [
    { tag: "00100010", vr: "PN" }, // PatientName
    { tag: "00100020" }, // PatientID
    { tag: "00100040" }, // PatientSex
    { tag: "00100030", vr: "DA" }, // PatientBirthDate
    { tag: "AGE" },
  ],
  topRight: [
    { tag: "00080060" }, // Modality
    { tag: "00080020", vr: "DA" }, // StudyDate
    { tag: "0008103E" }, // SeriesDescription
    { tag: "00181030" }, // ProtocolName
    { tag: "00080080" }, // InstitutionName
  ],
  bottomLeft: [
    { tag: "00180050", label: "ST", unit: "mm" }, // SliceThickness
    { tag: "00201041", label: "SL", unit: "mm" }, // SliceLocation
    { tag: "00180060", unit: "kV" }, // KVP
    { tag: "00181152", unit: "mAs" }, // Exposure
  ],
};

/** 4 隅ぶんの表示行（空項目は除外。bottomRight は viewer 側の動的値で埋める）。 */
export function resolveOverlay(imageId: string | undefined): ResolvedOverlay {
  const empty: ResolvedOverlay = { topLeft: [], topRight: [], bottomLeft: [] };
  if (!imageId) return empty;
  const ds = dataSetOf(imageId);
  if (!ds) return empty;
  (["topLeft", "topRight", "bottomLeft"] as OverlayCorner[]).forEach((corner) => {
    for (const field of PORTABLE_OVERLAY[corner]) {
      const v = resolveField(field, ds);
      if (v != null) empty[corner].push(v);
    }
  });
  return empty;
}

/** PixelSpacing(0028,0030) の有無で校正済み（mm 表示可）かを判定。 */
export function isCalibrated(imageId: string | undefined): boolean {
  if (!imageId) return false;
  const ds = dataSetOf(imageId);
  return rawValue(ds, "00280030") != null;
}

/**
 * 列方向（水平）ピクセル間隔[mm]。校正なしは 1（＝画像ピクセル）を返す。
 * PixelSpacing は [行間隔, 列間隔] の順（水平計測には列間隔を使う）。
 */
export function pixelSpacingColumn(imageId: string | undefined): number {
  if (!imageId) return 1;
  const ds = dataSetOf(imageId);
  const v = rawValue(ds, "00280030");
  if (!v) return 1;
  const parts = v.split("\\").map(Number);
  const col = parts[1] ?? parts[0];
  return col && col > 0 ? col : 1;
}
