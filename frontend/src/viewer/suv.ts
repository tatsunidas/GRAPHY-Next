/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * PET の SUV（Standardized Uptake Value）校正の計算コア。
 *
 * <p>本家 GRAPHY {@code SUVCalibrationDialog.java} の移植。数式は GRAPHY を踏襲しつつ、
 * OHIF / {@code @cornerstonejs/calculate-suv} のフォールバック連鎖・検証・核種別半減期表を
 * 取り込んで属性取得を強化している。
 *
 * <h3>SUV の定義（乗数規約）</h3>
 * {@code SUV = modalityValue(Bq/mL) × scale}。ここで {@code scale = 正規化ベース / 崩壊補正後投与量}。
 * GRAPHY は {@code SUV = pixel ÷ suvFactor}（suvFactor = 崩壊補正後投与量 / 正規化ベース）だが、
 * これは本モジュールの {@code scale} の逆数であり数学的に等価。OHIF と同じ「乗数」規約に統一する。
 *
 * <h3>アルゴリズム</h3>
 * <ul>
 *   <li><b>bw</b>: SUVbw（体重）— 正規化ベース = 体重 g</li>
 *   <li><b>sul-james</b>: SUL（除脂肪体重, James 1976）</li>
 *   <li><b>sul-janma</b>: SUL（除脂肪体重, Janmahasatian 2005）</li>
 *   <li><b>bsa</b>: SUVbsa（体表面積, DuBois）</li>
 * </ul>
 * ※ James 男性係数は 128（教科書・GRAPHY 準拠）。OHIF/calculate-suv は 120 を用いるが、
 *   これは既知の変種であり、本実装は標準の 128 を採用する。
 */
import { metaData } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";

/** SUV 計算タイプ。 */
export type SuvType = "bw" | "sul-james" | "sul-janma" | "bsa";

/** 抽出した SUV 計算用パラメータ。欠損は undefined（UI で手入力を促す）。 */
export interface SuvParams {
  /** 体重(kg)。 */
  patientWeight?: number;
  /** 身長(m)。 */
  patientHeight?: number;
  /** 性別 "M" | "F"。 */
  patientSex: "M" | "F";
  /** 投与量(Bq)。DICOM は Bq、UI 表示は MBq。 */
  totalDoseBq?: number;
  /** 半減期(秒)。DICOM は秒、UI 表示は分。 */
  halfLifeSec?: number;
  /** 核種名（表示用）。 */
  radionuclideName: string;
  /** 投与日時(epoch ms, UTC 基準の相対値)。 */
  injectionTimeMs?: number;
  /** スキャン基準日時(epoch ms)。 */
  scanTimeMs?: number;
  /** Units (0054,1001): "BQML" | "CNTS" | "GML" 等。 */
  units?: string;
  /** CorrectedImage (0028,0051) の値配列（"ATTN","DECY" 等）。 */
  correctedImage: string[];
  /** DecayCorrection (0054,1102): "START" 等。 */
  decayCorrection?: string;
  /** Philips 私設 SUV Scale Factor (7053,1000)。 */
  philipsSuvScaleFactor?: number;
  /** Philips 私設 Activity Concentration Scale Factor (7053,1009)。 */
  philipsActivityConcScaleFactor?: number;
  /** すでに SUV 化されている（Units=GML / SUVType / RescaleType に "SUV"）。 */
  alreadySuv: boolean;
  /** モダリティ (0008,0060)。 */
  modality?: string;
}

/** SUV 係数の計算結果。 */
export interface SuvResult {
  /** SUV = modalityValue × scale の乗数。 */
  scale: number;
  /** 表示単位（"SUVbw" 等）。 */
  unit: string;
  type: SuvType;
  /** 非致命的な警告（属性欠損の推定使用など）。 */
  warnings: string[];
}

/**
 * 核種別 物理半減期（秒）。RadionuclideHalfLife(0018,1075) 欠損時のフォールバック。
 * キーは RadionuclideCodeSequence(0054,0300) の CodeValue（SRT/DCM）。
 */
const HALF_LIFE_BY_CODE: Record<string, number> = {
  "C-111A": 6586.2, // F-18 Fluorine
  "C-105A": 1220.0, // C-11 Carbon
  "C-107A": 597.9, // N-13 Nitrogen
  "C-1018C": 122.24, // O-15 Oxygen
  "C-131A": 4062.6, // Ga-68 Gallium
  "C-1082": 75.45, // Rb-82 Rubidium
  "C-127A": 45720, // Cu-64 Copper
  "C-B1031": 282276, // Zr-89 Zirconium
  "C-113A": 360806, // I-124 Iodine
};

/** 核種名（表示名/コード名）から半減期(秒)を推定するフォールバック。 */
function halfLifeFromName(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const s = name.toUpperCase().replace(/[\s^-]/g, "");
  // 例: "18F", "F18", "FLUORINE", "FDG"
  if (/(^|[^0-9])18F|F18|FLUOR|FDG/.test(s)) return 6586.2;
  if (/(^|[^0-9])11C|C11|CARBON/.test(s)) return 1220.0;
  if (/(^|[^0-9])13N|N13|NITROGEN/.test(s)) return 597.9;
  if (/(^|[^0-9])15O|O15|OXYGEN/.test(s)) return 122.24;
  if (/(^|[^0-9])68GA|GA68|GALLIUM/.test(s)) return 4062.6;
  if (/(^|[^0-9])82RB|RB82|RUBIDIUM/.test(s)) return 75.45;
  if (/(^|[^0-9])64CU|CU64|COPPER/.test(s)) return 45720;
  if (/(^|[^0-9])89ZR|ZR89|ZIRCONIUM/.test(s)) return 282276;
  if (/(^|[^0-9])124I|I124|IODINE/.test(s)) return 360806;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * dicom-parser DataSet アクセス（ネストシーケンス対応の生 DataSet）      *
 * ------------------------------------------------------------------ */

/** 表示中 imageId の dicom-parser DataSet（wadouri キャッシュ）。 */
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

/** シーケンス(tag) の先頭アイテムの DataSet を返す（無ければ null）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function seqItem(ds: any, tag: string): any | null {
  const items = ds?.elements?.[tag]?.items;
  return items && items.length && items[0]?.dataSet ? items[0].dataSet : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dsStr(ds: any, tag: string): string | undefined {
  try {
    const v = ds?.string?.(tag);
    return v == null || v === "" ? undefined : String(v);
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dsFloat(ds: any, tag: string): number | undefined {
  try {
    const v = ds?.floatString?.(tag);
    if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch {
    /* fall through */
  }
  // DS/IS 以外（FL/FD 等）の私設タグ用に生値も試す。
  const s = dsStr(ds, tag);
  if (s !== undefined) {
    const n = Number(s.split("\\")[0]);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * DICOM 日時パース                                                     *
 * ------------------------------------------------------------------ */

/** DICOM DA(YYYYMMDD) + TM(HHMMSS.FFFFFF) を epoch ms（UTC 基準の相対値）に。 */
function combineDateTime(da: string | undefined, tm: string | undefined): number | undefined {
  if (!da || !/^\d{8}/.test(da) || !tm || !/^\d{2}/.test(tm)) return undefined;
  const y = +da.slice(0, 4);
  const mo = +da.slice(4, 6);
  const d = +da.slice(6, 8);
  const hh = +tm.slice(0, 2);
  const mm = tm.length >= 4 ? +tm.slice(2, 4) : 0;
  const ss = tm.length >= 6 ? +tm.slice(4, 6) : 0;
  const frac = /\.(\d+)/.exec(tm);
  const ms = frac ? Math.round(Number("0." + frac[1]) * 1000) : 0;
  const t = Date.UTC(y, mo - 1, d, hh, mm, ss, ms);
  return Number.isFinite(t) ? t : undefined;
}

/** DICOM DT(YYYYMMDDHHMMSS.FFFFFF&ZZXX) を epoch ms に。TZ は無視（相対差のみ利用）。 */
function parseDT(dt: string | undefined): number | undefined {
  if (!dt || !/^\d{8}/.test(dt)) return undefined;
  const core = dt.replace(/[+-]\d{4}$/, ""); // 末尾 TZ を除去
  const da = core.slice(0, 8);
  const tm = core.length > 8 ? core.slice(8) : "000000";
  return combineDateTime(da, tm);
}

/* ------------------------------------------------------------------ *
 * 抽出                                                                 *
 * ------------------------------------------------------------------ */

/** imageId の series が PET（Modality=PT）か。 */
export function isPetSeries(imageId: string | undefined): boolean {
  if (!imageId) return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const series: any = metaData.get("generalSeriesModule", imageId) ?? {};
  const ds = dataSetOf(imageId);
  const mod = String(series.modality ?? dsStr(ds, "x00080060") ?? "").toUpperCase();
  return mod === "PT" || mod === "PET";
}

/**
 * imageId から SUV 計算用パラメータを抽出する。
 *
 * <p>ネストされた {@code RadiopharmaceuticalInformationSequence (0054,0016)} から核種情報を取り、
 * ルート階層・{@code metaData} プロバイダにフォールバックする。投与時刻／スキャン時刻は
 * OHIF/calculate-suv と同じ連鎖で解決する。
 */
export function extractSuvParams(imageId: string): SuvParams {
  const ds = dataSetOf(imageId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const series: any = metaData.get("generalSeriesModule", imageId) ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const study: any = metaData.get("patientStudyModule", imageId) ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const isotope: any = metaData.get("petIsotopeModule", imageId) ?? {};
  const radInfo = isotope?.radiopharmaceuticalInfo ?? {};

  const radDs = seqItem(ds, "x00540016"); // RadiopharmaceuticalInformationSequence

  // --- 患者情報（ルート → patientStudyModule）---
  const patientWeight =
    dsFloat(ds, "x00101030") ?? numOrU(study.patientWeight);
  const patientHeight =
    dsFloat(ds, "x00101020") ?? numOrU(study.patientSize); // m
  const sexRaw = (dsStr(ds, "x00100040") ?? study.patientSex ?? "M").toString().toUpperCase();
  const patientSex: "M" | "F" = sexRaw.startsWith("F") ? "F" : "M";

  // --- 投与量(Bq): seq → root → metaData ---
  let totalDoseBq =
    dsFloat(radDs, "x00181074") ??
    dsFloat(ds, "x00181074") ??
    numOrU(radInfo.radionuclideTotalDose);

  // --- 半減期(秒): seq → root → metaData → 核種フォールバック ---
  let halfLifeSec =
    dsFloat(radDs, "x00181075") ??
    dsFloat(ds, "x00181075") ??
    numOrU(radInfo.radionuclideHalfLife);

  // --- 核種名: RadionuclideCodeSequence(0054,0300) の CodeMeaning → Radionuclide 文字列 ---
  const codeDs = seqItem(radDs, "x00540300") ?? seqItem(ds, "x00540300");
  const codeValue = dsStr(codeDs, "x00080100");
  const codeMeaning = dsStr(codeDs, "x00080104");
  const radionuclideName =
    codeMeaning ?? dsStr(radDs, "x00181071") ?? dsStr(ds, "x00181071") ?? "Unknown";

  if (halfLifeSec === undefined) {
    halfLifeSec =
      (codeValue ? HALF_LIFE_BY_CODE[codeValue] : undefined) ??
      halfLifeFromName(codeMeaning) ??
      halfLifeFromName(radionuclideName);
  }
  if (totalDoseBq !== undefined && totalDoseBq < 0) totalDoseBq = undefined;

  // --- 投与時刻: RadiopharmaceuticalStartDateTime(1078) → SeriesDate + StartTime(1072) ---
  const seriesDate = dsStr(ds, "x00080021");
  const seriesTime = dsStr(ds, "x00080031");
  const acqDate = dsStr(ds, "x00080022");
  const acqTime = dsStr(ds, "x00080032");
  const startDT = dsStr(radDs, "x00181078") ?? dsStr(ds, "x00181078");
  const startTM = dsStr(radDs, "x00181072") ?? dsStr(ds, "x00181072");
  let injectionTimeMs = parseDT(startDT);
  if (injectionTimeMs === undefined && startTM) {
    injectionTimeMs = combineDateTime(seriesDate, startTM);
  }

  // --- スキャン基準時刻: OHIF calculateScanTimes 準拠 ---
  const seriesMs = combineDateTime(seriesDate, seriesTime);
  const acqMs = combineDateTime(acqDate, acqTime);
  const gePostInj = parseDT(dsStr(ds, "x0009100d")); // GE private post-injection datetime
  let scanTimeMs: number | undefined;
  if (seriesMs !== undefined && (acqMs === undefined || seriesMs <= acqMs)) {
    scanTimeMs = seriesMs; // Series time が信頼できる（未崩壊補正の基準）
  } else if (gePostInj !== undefined) {
    scanTimeMs = gePostInj;
  } else {
    scanTimeMs = acqMs ?? seriesMs;
  }

  // --- Units / 検証系 / 私設 ---
  const units = (dsStr(ds, "x00540001") ?? "").toUpperCase() || undefined;
  const correctedImage = (dsStr(ds, "x00280051") ?? "")
    .split("\\")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const decayCorrection = dsStr(ds, "x00541102");
  const philipsSuvScaleFactor = dsFloat(ds, "x70531000");
  const philipsActivityConcScaleFactor = dsFloat(ds, "x70531009");

  // --- SUV 化済み検出（Units=GML / SUVType(0054,1006) / RescaleType に "SUV"）---
  const suvType = dsStr(ds, "x00541006");
  const rescaleType = dsStr(ds, "x00281054") ?? "";
  const alreadySuv =
    units === "GML" ||
    (suvType !== undefined && suvType.trim() !== "") ||
    rescaleType.toUpperCase().includes("SUV");

  return {
    patientWeight,
    patientHeight,
    patientSex,
    totalDoseBq,
    halfLifeSec,
    radionuclideName,
    injectionTimeMs,
    scanTimeMs,
    units,
    correctedImage,
    decayCorrection,
    philipsSuvScaleFactor,
    philipsActivityConcScaleFactor,
    alreadySuv,
    modality: (series.modality ?? dsStr(ds, "x00080060"))?.toString(),
  };
}

function numOrU(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}

/* ------------------------------------------------------------------ *
 * 正規化ベース（除脂肪体重・体表面積）                                  *
 * ------------------------------------------------------------------ */

/** 除脂肪体重(kg) James 1976。H は m。 */
function lbmJames(weightKg: number, heightM: number, sex: "M" | "F"): number {
  const hCm = heightM * 100;
  const wsq = Math.pow(weightKg / hCm, 2);
  // ★ 男性係数 128 は教科書・GRAPHY 準拠（OHIF は 120 を使用）。
  return sex === "M" ? 1.1 * weightKg - 128 * wsq : 1.07 * weightKg - 148 * wsq;
}

/** 除脂肪体重(kg) Janmahasatian 2005。 */
function lbmJanma(weightKg: number, heightM: number, sex: "M" | "F"): number {
  const bmi = weightKg / (heightM * heightM);
  return sex === "M"
    ? (9270 * weightKg) / (6680 + 216 * bmi)
    : (9270 * weightKg) / (8780 + 244 * bmi);
}

/** 体表面積(m^2) DuBois。 */
function bsaDuBois(weightKg: number, heightM: number): number {
  return 0.007184 * Math.pow(weightKg, 0.425) * Math.pow(heightM * 100, 0.725);
}

/** タイプ別の単位ラベル。 */
export function suvUnitLabel(type: SuvType): string {
  switch (type) {
    case "bw":
      return "SUVbw";
    case "sul-james":
      return "SUVlbm";
    case "sul-janma":
      return "SUVlbm";
    case "bsa":
      return "SUVbsa";
  }
}

/**
 * SUV 係数（乗数）を計算する。{@code SUV = modalityValue × scale}。
 *
 * <p>Units により分岐（OHIF 準拠）:
 * <ul>
 *   <li>GML: すでに SUV → scale=1</li>
 *   <li>CNTS(Philips): 7053,1000 があれば scale=それ、無ければ 7053,1009 × decay × 体重g/線量</li>
 *   <li>BQML/未指定: 標準の崩壊補正 × 正規化ベース</li>
 * </ul>
 *
 * @returns 計算結果、または失敗時に {@link SuvError}。
 */
export function computeSuvScale(p: SuvParams, type: SuvType): SuvResult | SuvError {
  const warnings: string[] = [];
  const units = (p.units ?? "").toUpperCase();

  // すでに SUV 化済み: そのまま（校正不要）。
  if (units === "GML" || p.alreadySuv) {
    return { scale: 1, unit: suvUnitLabel(type), type, warnings: ["alreadySuv"] };
  }

  // Philips CNTS: 私設スケールファクタで直接 SUVbw 化。
  if (units === "CNTS") {
    if (p.philipsSuvScaleFactor && p.philipsSuvScaleFactor > 0) {
      // (7053,1000) は counts → SUVbw の直接係数。BW 以外は非対応のため BW にフォールバック。
      if (type !== "bw") warnings.push("philipsBwOnly");
      return { scale: p.philipsSuvScaleFactor, unit: "SUVbw", type: "bw", warnings };
    }
    // (7053,1009) × Rescale で Bq/mL 化 → 以降 BQML と同様。
    if (!(p.philipsActivityConcScaleFactor && p.philipsActivityConcScaleFactor > 0)) {
      return { error: "philipsInvalid" };
    }
    warnings.push("philipsActivityConc");
  }

  // --- 崩壊補正後投与量 ---
  if (!p.totalDoseBq || p.totalDoseBq <= 0) return { error: "missingDose" };
  if (!p.halfLifeSec || p.halfLifeSec <= 0) return { error: "missingHalfLife" };
  if (p.injectionTimeMs === undefined || p.scanTimeMs === undefined) {
    return { error: "missingTime" };
  }
  let decaySec = (p.scanTimeMs - p.injectionTimeMs) / 1000;
  if (decaySec < 0) {
    // 日跨ぎ（時刻のみで日付欠損）: 24h 補正を試みる。
    decaySec += 86400;
    warnings.push("midnightAdjust");
  }
  if (decaySec < 0) return { error: "negativeDecay" };
  const decayedDoseBq = p.totalDoseBq * Math.pow(2, -decaySec / p.halfLifeSec);
  if (!(decayedDoseBq > 0)) return { error: "negativeDecay" };

  // --- 正規化ベース（g 相当）---
  const w = p.patientWeight;
  const h = p.patientHeight;
  if (!w || w <= 0) return { error: "missingWeight" };
  let normBase: number;
  switch (type) {
    case "bw":
      normBase = w * 1000; // g
      break;
    case "sul-james":
      if (!h || h <= 0) return { error: "missingHeight" };
      normBase = lbmJames(w, h, p.patientSex) * 1000;
      break;
    case "sul-janma":
      if (!h || h <= 0) return { error: "missingHeight" };
      normBase = lbmJanma(w, h, p.patientSex) * 1000;
      break;
    case "bsa":
      if (!h || h <= 0) return { error: "missingHeight" };
      normBase = bsaDuBois(w, h) * 10000; // m^2 → cm^2
      break;
  }
  if (!(normBase > 0)) return { error: "invalidNormBase" };

  // SUV = conc / (decayedDose / normBase) = conc × (normBase / decayedDose)
  let scale = normBase / decayedDoseBq;
  // Philips (7053,1009): pixel → Bq/mL に濃度換算してから標準式。
  if (units === "CNTS" && p.philipsActivityConcScaleFactor) {
    scale *= p.philipsActivityConcScaleFactor;
  }

  return { scale, unit: suvUnitLabel(type), type, warnings };
}

/** computeSuvScale の失敗結果。 */
export interface SuvError {
  error:
    | "missingDose"
    | "missingHalfLife"
    | "missingTime"
    | "missingWeight"
    | "missingHeight"
    | "negativeDecay"
    | "invalidNormBase"
    | "philipsInvalid";
}

/** 型ガード。 */
export function isSuvError(r: SuvResult | SuvError): r is SuvError {
  return (r as SuvError).error !== undefined;
}
