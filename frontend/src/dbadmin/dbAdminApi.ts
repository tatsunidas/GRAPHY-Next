/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";

export interface Patient {
  patientId: string;
  patientName: string | null;
  patientBirthDate: string | null;
  patientSex: string | null;
  numberOfStudies: number;
  numberOfInstances: number;
}

export interface PatientEdit {
  patientName: string;
  patientBirthDate: string;
  patientSex: string;
  newPatientId: string;
}

export interface StatBucket {
  key: string;
  value: number;
}

export interface Stats {
  studyCountByMonth: StatBucket[];
  studyCountByModality: StatBucket[];
  instanceCountByModality: StatBucket[];
  volumeBytesByModality: StatBucket[];
}

export const fetchPatients = (q?: string) =>
  httpGet<Patient[]>(`/api/patients${q ? `?q=${encodeURIComponent(q)}` : ""}`);

export const fetchStats = () => httpGet<Stats>("/api/stats");

/** 患者の情報を編集したとき、患者キーで引く記録（ROI など）を運んだ・残した件数。 */
export interface PatientRecordsResult {
  roisMoved: number;
  roiOverlaps: number;
  registrationsMoved: number;
  pluginDocsMoved: number;
  pluginDocsKept: number;
  reportsUpdated: number;
}

export interface PatientEditResult {
  updatedInstances: number;
  records?: PatientRecordsResult;
}

export const savePatient = (patientId: string, edit: PatientEdit) =>
  httpSend<PatientEditResult>(`/api/patients/${encodeURIComponent(patientId)}`, "PUT", edit);

/** 運べずに残した記録・重なった ROI があるときの知らせの文言（無ければ null）。 */
export function recordsNotice(r: PatientEditResult | undefined, t: (k: string, v?: Record<string, string | number>) => string): string | null {
  const rec = r?.records;
  if (!rec || (rec.pluginDocsKept === 0 && rec.roiOverlaps === 0)) return null;
  return t("dbadmin.edit.recordsKept", { plugins: rec.pluginDocsKept, overlaps: rec.roiOverlaps });
}

export const deletePatient = (patientId: string) =>
  httpSend(`/api/patients/${encodeURIComponent(patientId)}`, "DELETE");

export const deleteStudy = (studyUid: string) =>
  httpSend(`/api/studies/${encodeURIComponent(studyUid)}`, "DELETE");

export const deleteSeries = (studyUid: string, seriesUid: string) =>
  httpSend(
    `/api/series/${encodeURIComponent(studyUid)}/${encodeURIComponent(seriesUid)}`,
    "DELETE",
  );

export const deleteInstance = (studyUid: string, seriesUid: string, sopUid: string) =>
  httpSend(
    `/api/instances/${encodeURIComponent(studyUid)}/${encodeURIComponent(seriesUid)}/${encodeURIComponent(sopUid)}`,
    "DELETE",
  );

/** スタディ単位の患者情報編集（そのスタディのみ。PatientID 変更で別患者へ移動）。 */
export const updateStudyPatient = (studyUid: string, edit: PatientEdit) =>
  httpSend<PatientEditResult>(`/api/studies/${encodeURIComponent(studyUid)}/patient`, "PUT", edit);

export interface MergeTarget {
  seriesInstanceUid?: string;
  seriesNumber?: number;
  seriesDescription?: string;
}

export interface MergeResult {
  moved: number;
  failed: number;
  seriesInstanceUid: string;
}

/** 同一スタディ内のシリーズ統合（N→1, InstanceNumber 再採番）。 */
export const mergeSeries = (studyUid: string, sourceSeriesUids: string[], target?: MergeTarget) =>
  httpSend<MergeResult>("/api/dbadmin/series/merge", "POST", { studyUid, sourceSeriesUids, target });

export interface SplitGroup {
  sopInstanceUids: string[];
  seriesNumber?: number;
  seriesDescription?: string;
}

export interface SplitResult {
  groupsCreated: number;
  moved: number;
  failed: number;
  newSeriesUids: string[];
}

/** 同一スタディ内のシリーズ分割（1→N, 手動群・InstanceNumber 保持）。 */
export const splitSeries = (studyUid: string, seriesUid: string, groups: SplitGroup[]) =>
  httpSend<SplitResult>("/api/dbadmin/series/split", "POST", { studyUid, seriesUid, groups });

/**
 * 削除の確認文に、付随データの扱いを添える。ファイルも消す設定のときだけ
 * （ファイルを残す設定では ROI なども残す）。レポートは画像を消しても残る。
 */
export function deleteRelatedNote(msg: string, deleteFiles: boolean, t: (k: string) => string): string {
  return deleteFiles ? `${msg}\n\n${t("dbadmin.delete.relatedNote")}` : msg;
}
