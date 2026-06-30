/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { StudyFilters } from "../api";

/** 保存済み状態。none=未保存 / partial=一部 / full=全件 / unknown=判定不能。 */
export type StoredStatus = "none" | "partial" | "full" | "unknown";

/** ローカル/PACS の保存件数と C-FIND の期待件数から保存済み状態を判定する。 */
export function storedStatusOf(stored: number, expected: number): StoredStatus {
  if (expected <= 0) return stored > 0 ? "full" : "unknown";
  if (stored <= 0) return "none";
  if (stored >= expected) return "full";
  return "partial";
}

/** "YYYYMMDD" を Date に。不正なら null。 */
function parseDicomDate(d: string | null | undefined): Date | null {
  if (!d) return null;
  const s = d.replace(/[^0-9]/g, "");
  if (s.length < 8) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(4, 6));
  const day = Number(s.slice(6, 8));
  if (!y || !m || !day) return null;
  return new Date(y, m - 1, day);
}

/** 検査日と生年月日から検査時点の満年齢を算出（"045Y" 風ではなく整数歳）。算出不能なら null。 */
export function ageAt(studyDate: string | null, birthDate: string | null): number | null {
  const study = parseDicomDate(studyDate);
  const birth = parseDicomDate(birthDate);
  if (!study || !birth) return null;
  let age = study.getFullYear() - birth.getFullYear();
  const beforeBirthday =
    study.getMonth() < birth.getMonth() ||
    (study.getMonth() === birth.getMonth() && study.getDate() < birth.getDate());
  if (beforeBirthday) age -= 1;
  return age >= 0 && age < 200 ? age : null;
}

/** "YYYYMMDD" → "YYYY-MM-DD"（表示用）。空はそのまま。 */
export function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const s = d.replace(/[^0-9]/g, "");
  if (s.length < 8) return d;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** StudyFilters を C-FIND の matchKeys（DICOM キーワード）へ変換する。 */
export function filtersToMatchKeys(f: StudyFilters | null): Record<string, string> {
  const m: Record<string, string> = {};
  if (!f) return m;
  if (f.patientId) m.PatientID = `*${f.patientId}*`;
  if (f.patientName) m.PatientName = `*${f.patientName}*`;
  if (f.accessionNumber) m.AccessionNumber = f.accessionNumber;
  if (f.modality) m.ModalitiesInStudy = f.modality.split(",")[0].trim(); // C-FIND は単一値マッチ
  // StudyDate は範囲表記 "from-to" / "from-" / "-to" / 単日。
  const from = f.studyDateFrom;
  const to = f.studyDateTo;
  if (from || to) {
    m.StudyDate = from && from === to ? from : `${from ?? ""}-${to ?? ""}`;
  }
  return m;
}
