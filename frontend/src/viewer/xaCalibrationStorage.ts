/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の空間校正を設定ストアへ置くときの**形**（`fw/angio-design.md` §7.4）。
 *
 * <p>ここは純ロジックだけ（Cornerstone にも設定 API にも触らない）。読み書きの配線は
 * {@link ./xaCalibrationPersistence} 側にある。分けてあるのは、**壊れた保存値を
 * どう扱うか**をテストで固定したいから——校正は数値の意味を変えるので、
 * 疑わしい値を「だいたい合っていそうだから使う」が一番危ない。
 */
import type { XaUserCalibration } from "./xaCalibration";

export const XA_CALIBRATION_PREFIX = "xa.calibration.";

/** 保存する形（将来の項目追加に備えて版を持つ）。 */
interface StoredCalibration {
  v: 1;
  mmPerPx: number;
  method: XaUserCalibration["method"];
  note?: string;
  /** 保存時刻（ISO）。出自の説明に使う。 */
  savedAt?: string;
}

/** 壊れた値・別版を**黙って使わない**（校正は数値の意味を変えるので、疑わしきは無視）。 */
export function parseStored(raw: string): XaUserCalibration | null {
  try {
    const o = JSON.parse(raw) as Partial<StoredCalibration>;
    if (!o || o.v !== 1) return null;
    const mm = Number(o.mmPerPx);
    if (!Number.isFinite(mm) || mm <= 0) return null;
    const method = o.method;
    if (method !== "catheter" && method !== "ruler" && method !== "gsps") return null;
    return { mmPerPx: mm, method, note: typeof o.note === "string" ? o.note : undefined };
  } catch {
    return null;
  }
}

export function serialize(calib: XaUserCalibration, savedAt: string): string {
  const stored: StoredCalibration = {
    v: 1,
    mmPerPx: calib.mmPerPx,
    method: calib.method,
    note: calib.note,
    savedAt,
  };
  return JSON.stringify(stored);
}

/** 設定マップから「シリーズ UID → 校正」を取り出す（純関数。テスト用に分けてある）。 */
export function extractCalibrations(settings: Record<string, string>): Map<string, XaUserCalibration> {
  const out = new Map<string, XaUserCalibration>();
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(XA_CALIBRATION_PREFIX)) continue;
    const seriesUid = key.slice(XA_CALIBRATION_PREFIX.length);
    const calib = parseStored(value);
    if (seriesUid && calib) out.set(seriesUid, calib);
  }
  return out;
}
