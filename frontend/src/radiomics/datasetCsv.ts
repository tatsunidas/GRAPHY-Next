/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 一括抽出の書き出し: 識別つきの 1 つの表（1 行 = 送った組）と、付属のファイル。
 *
 * <p>**患者名はどのファイルにも入れない**。患者 ID は、被験者の対応表（別ファイル）と、利用者が選んだときの表の
 * `PatientID` 列にだけ入る。被験者は `SubjectCode`（アルバム内の連番）で束ねる。
 *
 * <p>列の名前: 研究統計プラグインは、特徴量の既定の列を「欠損を除いてすべて数の列。ただし `Roi_`・`Provenance_`・
 * `Warning_` などで始まる列は除く」で決める。数値の識別の列が特徴量に混ざらないよう、数のものは `Roi_`・`Provenance_` の
 * 名前にし、そのほかは文字列の列にする。
 *
 * <p>失敗・未実行・取り消しの組も行を残す（特徴量は空欄＝欠損。0 や `NaN` と書かない）。行数は送った組の数に一致する。
 */
import type { RoiFeatureResult } from "../api";
import { cell } from "../viewer/roiStatsCsv";
import type { BatchPairStatusRow } from "./batchApi";
import type { SpecKind } from "./batchSpec";
import {
  ROI_FEATURE_RECORD_COLUMNS,
  ROI_FEATURE_SIZE_COLUMNS,
  recordValuesOf,
  roiFeatureDefinitionsCsv,
  sizeValuesOf,
  value,
} from "./roiFeatureCsv";

/**
 * VOI 統計の列（一次統計のうち、平均・SD（母集団）・最小・最大・中央値）。大きさの列の後ろに `Roi_VolumeMl` を足す。
 * 一次統計の族だけを有効にして計算するので、結果にはこれらが必ずある。
 */
export const VOI_STATS_COLUMNS = [
  "IntensityBasedStatistical_Mean",
  "IntensityBasedStatistical_StandardDeviation",
  "IntensityBasedStatistical_Minimum",
  "IntensityBasedStatistical_Maximum",
  "IntensityBasedStatistical_Median",
] as const;
export const VOLUME_ML_COLUMN = "Roi_VolumeMl";

/** 識別と行の状態の列（`CaseLabel`・`PatientID` の後ろ、記録の列の前）。 */
export const ID_COLUMNS = [
  "SubjectCode", "Album", "StudyInstanceUID", "SourceSeriesUID", "MaskSeriesUID",
  "Roi_SegmentNumber", "Roi_SegmentLabel", "Roi_MaskChannel",
  "RowStatus", "RowFailureKind", "RowError", "Provenance_QcFlags", "Provenance_SpecSha256",
] as const;

/** 既存の記録の列のうち、`CaseLabel` を除いたもの（版・抽出日時・設定の SHA-256）。 */
const PROVENANCE_COLUMNS = ROI_FEATURE_RECORD_COLUMNS.slice(1);

export interface SubjectInfo {
  code: string;
  /** 元の患者 ID。空なら不明（その検査だけの別の被験者として扱う）。 */
  patientId: string;
}

/**
 * アルバムのスタディの並び順に、被験者の連番（`S001`…）を振る。同じ患者 ID は同じコード。患者 ID が空のスタディは、
 * それぞれ別のコード（突き合わせられない）。**割り当ては並び順だけで決める**（選んだ組には依らない）ので、選び方を変えても
 * コードは動かない。アルバムの構成が変われば変わりうる。
 */
export function assignSubjectCodes(
  albumStudyUids: readonly string[],
  patientIdOf: (studyUid: string) => string | null | undefined,
  extraStudyUids: readonly string[] = [],
): Map<string, SubjectInfo> {
  const order = [...albumStudyUids];
  for (const u of extraStudyUids) if (!order.includes(u)) order.push(u);
  const byPatient = new Map<string, number>();
  const studyToSubject = new Map<string, { n: number; patientId: string }>();
  let next = 0;
  for (const uid of order) {
    if (studyToSubject.has(uid)) continue;
    const pid = (patientIdOf(uid) ?? "").trim();
    let n: number;
    if (pid !== "" && byPatient.has(pid)) n = byPatient.get(pid)!;
    else {
      n = ++next;
      if (pid !== "") byPatient.set(pid, n);
    }
    studyToSubject.set(uid, { n, patientId: pid });
  }
  const width = Math.max(3, String(next).length);
  const out = new Map<string, SubjectInfo>();
  for (const [uid, s] of studyToSubject) out.set(uid, { code: `S${String(s.n).padStart(width, "0")}`, patientId: s.patientId });
  return out;
}

export interface DatasetRow {
  caseLabel: string;
  status: BatchPairStatusRow;
  /** 計算できた組の結果。それ以外は null。 */
  result: RoiFeatureResult | null;
}

export interface DatasetOptions {
  albumName: string;
  /** 処理の定義の SHA-256（全行に同じ値を入れる）。 */
  specSha256: string;
  /** 表に `PatientID` の列を入れる（既定は入れない）。 */
  includePatientId: boolean;
  /** 抽出の種類。`voiStats` は一次統計の 5 列と体積（mL）だけの表にする（既定は特徴量の全列）。 */
  kind?: SpecKind;
}

export type DatasetFailure = { ok: false; reason: "no results" | "header mismatch" | "missing result"; caseLabel: string };

const blanks = (n: number): string[] => Array(n).fill("");

/** 見出し（`CaseLabel`、任意で `PatientID`、識別、記録、大きさ、特徴量）。 */
function headerOf(featureColumns: readonly string[], includePatientId: boolean, voi: boolean): string[] {
  return [
    "CaseLabel", ...(includePatientId ? ["PatientID"] : []), ...ID_COLUMNS, ...PROVENANCE_COLUMNS,
    ...ROI_FEATURE_SIZE_COLUMNS, ...(voi ? [VOLUME_ML_COLUMN] : []), ...featureColumns,
  ];
}

const volumeMlOf = (r: RoiFeatureResult): string => value(r.roiSize.volumeMm3 == null ? null : r.roiSize.volumeMm3 / 1000);

/** 識別の列の値。 */
function idCells(row: DatasetRow, subject: SubjectInfo | undefined, opts: DatasetOptions): string[] {
  const s = row.status;
  return [
    subject?.code ?? "", opts.albumName, s.pair.studyUid, s.pair.sourceSeriesUid ?? "", s.pair.maskSeriesUid,
    s.pair.segmentNumber == null ? "" : String(s.pair.segmentNumber), s.pair.segmentLabel ?? "", String(s.pair.maskChannel),
    s.state, s.failureKind ?? "", s.error ?? "", (s.qcFlags ?? []).join(";"), opts.specSha256,
  ].map(cell);
}

export interface DatasetTable {
  ok: true;
  csv: string;
  header: string[];
  /** 見出しの列に対応する、特徴量の列の名前。 */
  featureColumns: string[];
  /** 計算できた最初の結果（定義表・設定ファイルの元）。 */
  first: RoiFeatureResult;
}

/**
 * 1 つの表。計算できた組の見出しが組の間で違えば（族が欠けたなど）、列がずれて値が別の特徴量になるので止める。
 */
export function datasetTable(
  rows: readonly DatasetRow[],
  subjects: ReadonlyMap<string, SubjectInfo>,
  opts: DatasetOptions,
): DatasetTable | DatasetFailure {
  const done = rows.filter((r) => r.result != null);
  if (done.length === 0) return { ok: false, reason: "no results", caseLabel: "" };
  const voi = opts.kind === "voiStats";
  const featureColumns = voi ? [...VOI_STATS_COLUMNS] : done[0].result!.rows.map((r) => r.column);
  const sig = featureColumns.join("\u0000");
  for (const r of done) {
    const names = r.result!.rows.map((x) => x.column);
    const same = voi ? featureColumns.every((c) => names.includes(c)) : names.join("\u0000") === sig;
    if (!same) return { ok: false, reason: "header mismatch", caseLabel: r.caseLabel };
  }
  const featureValues = (r: RoiFeatureResult): string[] => {
    if (!voi) return r.rows.map((x) => value(x.value));
    const byColumn = new Map(r.rows.map((x) => [x.column, x.value]));
    return featureColumns.map((c) => value(byColumn.get(c) ?? null));
  };
  for (const r of rows) {
    if (r.status.state === "DONE" && r.result == null) return { ok: false, reason: "missing result", caseLabel: r.caseLabel };
  }
  const header = headerOf(featureColumns, opts.includePatientId, voi);
  const lines = [header.map(cell).join(",")];
  for (const r of rows) {
    const subject = subjects.get(r.status.pair.studyUid);
    const pid = opts.includePatientId ? [cell(subject?.patientId ?? "")] : [];
    const ids = idCells(r, subject, opts);
    if (r.result) {
      const rec = recordValuesOf(r.result.provenance, r.caseLabel);
      lines.push([
        rec[0], ...pid, ...ids, ...rec.slice(1), ...sizeValuesOf(r.result.roiSize),
        ...(voi ? [volumeMlOf(r.result)] : []), ...featureValues(r.result),
      ].join(","));
    } else {
      lines.push([
        cell(r.caseLabel), ...pid, ...ids, ...blanks(PROVENANCE_COLUMNS.length), ...blanks(ROI_FEATURE_SIZE_COLUMNS.length + (voi ? 1 : 0)),
        ...blanks(featureColumns.length),
      ].join(","));
    }
  }
  return { ok: true, csv: `${lines.join("\r\n")}\r\n`, header, featureColumns, first: done[0].result! };
}

const ID_NOTES: Record<string, [family: string, feature: string, note: string]> = {
  PatientID: ["Id", "PatientID", "optional;sensitive"],
  SubjectCode: ["Id", "SubjectCode", "subject-sequence-in-album"],
  Album: ["Id", "Album", ""],
  StudyInstanceUID: ["Id", "StudyInstanceUID", ""],
  SourceSeriesUID: ["Id", "SourceSeriesUID", ""],
  MaskSeriesUID: ["Id", "MaskSeriesUID", ""],
  Roi_SegmentNumber: ["Roi", "SegmentNumber", ""],
  Roi_SegmentLabel: ["Roi", "SegmentLabel", ""],
  Roi_MaskChannel: ["Roi", "MaskChannel", "rank-of-segment-with-foreground"],
  RowStatus: ["Row", "Status", "DONE|FAILED|NOT_RUN|CANCELLED"],
  RowFailureKind: ["Row", "FailureKind", "INPUT|ENGINE|ENVIRONMENT"],
  RowError: ["Row", "Error", ""],
  Provenance_QcFlags: ["Provenance", "QcFlags", "SMALL_ROI;LOSSY_COMPRESSION"],
  Provenance_SpecSha256: ["Provenance", "SpecSha256", "sha256-of-the-batch-definition"],
  [VOLUME_ML_COLUMN]: ["Roi", "VolumeMl", "Roi_VolumeMm3-divided-by-1000"],
};

/** 定義表。表の列の並びと 1 対 1（識別・状態の列の行を足す）。 */
export function datasetDefinitionsCsv(table: DatasetTable): string {
  const base = roiFeatureDefinitionsCsv(table.first).split("\r\n").filter(Boolean);
  const head = base[0];
  const byColumn = new Map(base.slice(1).map((l) => [l.slice(0, l.indexOf(",")), l]));
  const lines = [head];
  for (const c of table.header) {
    const existing = byColumn.get(c) ?? byColumn.get(cell(c));
    if (existing) {
      lines.push(existing);
      continue;
    }
    const n = ID_NOTES[c];
    lines.push(n ? [cell(c), cell(n[0]), cell(n[1]), "", cell(n[2]), ""].join(",") : [cell(c), "", "", "", "", ""].join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

/**
 * 被験者の対応表（`SubjectCode,PatientID,StudyInstanceUID`、検査 1 つにつき 1 行）。**患者 ID が入るので共有しない**。
 * 表に出てくる検査だけを、アルバムの並び順で書く。
 */
export function subjectsCsv(
  subjects: ReadonlyMap<string, SubjectInfo>,
  studyUidsInTable: ReadonlySet<string>,
): string {
  const lines = ["SubjectCode,PatientID,StudyInstanceUID"];
  for (const [uid, s] of subjects) {
    if (studyUidsInTable.has(uid)) lines.push([s.code, s.patientId, uid].map(cell).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export const UTF8_BOM = "﻿";

export interface OutputFile {
  name: string;
  text: string;
  mime: string;
}

export interface DatasetOutputOptions extends DatasetOptions {
  /** ファイル名の接頭辞（使えない文字は呼び出し側で直してある）。 */
  base: string;
  /** 処理の定義（JSON）の本文。 */
  specText: string;
  /** 被験者の対応表を別ファイルで書く。 */
  subjectsFile: boolean;
  /** CSV の先頭に UTF-8 の BOM を付ける（Excel 向け。既定は付けない）。 */
  bom: boolean;
}

/**
 * 書き出すファイル一式: 表・定義表・設定ファイル・処理の定義、（選んだとき）被験者の対応表。
 * BOM は CSV にだけ付ける（設定ファイル・JSON には付けない）。
 */
export function datasetFiles(
  rows: readonly DatasetRow[],
  subjects: ReadonlyMap<string, SubjectInfo>,
  opts: DatasetOutputOptions,
): { ok: true; files: OutputFile[] } | DatasetFailure {
  const table = datasetTable(rows, subjects, opts);
  if (!table.ok) return table;
  const csvText = (t: string) => (opts.bom ? `${UTF8_BOM}${t}` : t);
  const csv = "text/csv;charset=utf-8";
  const files: OutputFile[] = [
    { name: `${opts.base}.csv`, text: csvText(table.csv), mime: csv },
    { name: `${opts.base}_definitions.csv`, text: csvText(datasetDefinitionsCsv(table)), mime: csv },
    { name: `${opts.base}_radiomicsj.properties`, text: table.first.settingsProperties, mime: "text/plain;charset=utf-8" },
    { name: `${opts.base}_spec.json`, text: opts.specText, mime: "application/json;charset=utf-8" },
  ];
  if (opts.subjectsFile) {
    const inTable = new Set(rows.map((r) => r.status.pair.studyUid));
    files.push({ name: `${opts.base}_subjects_private.csv`, text: csvText(subjectsCsv(subjects, inTable)), mime: csv });
  }
  return { ok: true, files };
}
