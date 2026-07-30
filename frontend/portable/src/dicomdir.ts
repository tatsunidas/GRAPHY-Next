/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Portable 2D Viewer — DICOMDIR 解析（媒体内の DICOMDIR から Patient/Study/Series/Image の木を組む）。
// GRAPHY の Export が書く DICOMDIR（可読フォルダ名・ReferencedFileID＝相対パス）を主対象にしつつ、
// 一般的な DICOMDIR も概ね読めるよう防御的に実装する。
//
// 注意（fw/export-portable-viewer.md §3）:
// - ReferencedFileID(x00041500) は多値（バックスラッシュ区切り）で、媒体ルート起点のパス構成要素。
//   これを "/" で連結すると媒体内の相対パスになる（GRAPHY Export では DICOM/<pat>/<sty>/<ser>/NNNN.dcm）。
// - 実ファイルは <input webkitdirectory> の FileList から webkitRelativePath で引き当てる。
//   先頭セグメント（ユーザが選んだルートフォルダ名）を除いた相対パスで突き合わせる。
import dicomParser from "dicom-parser";

export interface ImageRec {
  sopUid: string;
  instanceNumber: number;
  /** ReferencedFileID を "/" 連結した媒体相対パス（小文字化前の生値）。 */
  fileId: string;
  /** 引き当てた実ファイル（見つからなければ undefined）。 */
  file?: File;
  /** ReferencedSOPClassUIDInFile(0004,1510)。動画かどうかの判定に使う。 */
  sopClassUid?: string;
  /**
   * 同梱された再生用 MP4（`VIDEO/{sop}.mp4`）。動画 DICOM は encapsulated で 2D 画像として描けないため、
   * Export が MP4 実体を媒体へ入れる（`fw/video-viewer-design.md` §7 / P5）。
   */
  videoFile?: File;
}

/** encapsulated video の SOP クラス（Video Photographic / Endoscopic / Microscopic）。 */
const VIDEO_SOP_CLASSES = new Set([
  "1.2.840.10008.5.1.4.1.1.77.1.4.1",
  "1.2.840.10008.5.1.4.1.1.77.1.1.1",
  "1.2.840.10008.5.1.4.1.1.77.1.2.1",
]);

/** そのシリーズが動画か（先頭の解決済みインスタンスの SOP クラスで判定）。 */
export function isVideoSeries(series: SeriesRec): boolean {
  return series.images.some((im) => im.sopClassUid && VIDEO_SOP_CLASSES.has(im.sopClassUid));
}

export interface SeriesRec {
  seriesUid: string;
  number: number | null;
  description: string;
  modality: string;
  images: ImageRec[];
}

export interface StudyRec {
  studyUid: string;
  date: string;
  description: string;
  series: SeriesRec[];
}

export interface PatientRec {
  id: string;
  name: string;
  studies: StudyRec[];
}

export interface DicomDirModel {
  patients: PatientRec[];
  /** 引き当てできなかった参照数（診断用）。 */
  missingFiles: number;
}

/** DICOM の PersonName（^ 区切り）を人が読める形へ。 */
function formatPersonName(raw: string | undefined): string {
  if (!raw) return "";
  const parts = raw.split("^");
  const family = (parts[0] ?? "").trim();
  const given = (parts[1] ?? "").trim();
  return [family, given].filter(Boolean).join(" ") || raw.trim();
}

/** YYYYMMDD(DA) → YYYY-MM-DD。整形できなければ生値。 */
function formatDate(raw: string | undefined): string {
  if (!raw) return "";
  const m = raw.trim().match(/^(\d{4})(\d{2})(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : raw.trim();
}

/** FileList から「ルートフォルダ名を除いた相対パス(小文字)」→ File と、basename(小文字)→File[] を索引化。 */
function indexFiles(files: File[]): { byPath: Map<string, File>; byBase: Map<string, File[]> } {
  const byPath = new Map<string, File>();
  const byBase = new Map<string, File[]>();
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const segs = rel.split("/").filter(Boolean);
    // 先頭 = ユーザが選んだルートフォルダ名。除いて媒体相対パスにする。
    const stripped = segs.length > 1 ? segs.slice(1).join("/") : segs.join("/");
    byPath.set(stripped.toLowerCase(), f);
    const base = segs[segs.length - 1].toLowerCase();
    const list = byBase.get(base);
    if (list) list.push(f);
    else byBase.set(base, [f]);
  }
  return { byPath, byBase };
}

/** ReferencedFileID の生値（バックスラッシュ区切り）→ 媒体相対パス。 */
function fileIdToPath(referencedFileId: string): string {
  return referencedFileId
    .split("\\")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

/** FileList から DICOMDIR ファイルを探す（basename が dicomdir、大文字小文字無視）。 */
export function findDicomDirFile(files: File[]): File | null {
  for (const f of files) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const base = rel.split("/").filter(Boolean).pop() ?? "";
    if (base.toLowerCase() === "dicomdir") return f;
  }
  return null;
}

/**
 * DICOMDIR を解析し、実ファイルを引き当てた木を返す。
 * @param dicomdir DICOMDIR ファイル
 * @param allFiles 選択フォルダ配下の全ファイル（実ファイル引き当て用）
 */
export async function parseDicomDir(dicomdir: File, allFiles: File[]): Promise<DicomDirModel> {
  const byteArray = new Uint8Array(await dicomdir.arrayBuffer());
  const dataSet = dicomParser.parseDicom(byteArray);
  const seq = dataSet.elements.x00041220; // Directory Record Sequence
  const { byPath, byBase } = indexFiles(allFiles);

  const patients: PatientRec[] = [];
  let curPatient: PatientRec | null = null;
  let curStudy: StudyRec | null = null;
  let curSeries: SeriesRec | null = null;
  let missingFiles = 0;

  const ensurePatient = (): PatientRec => {
    if (!curPatient) {
      curPatient = { id: "NoPatientID", name: "", studies: [] };
      patients.push(curPatient);
    }
    return curPatient;
  };
  const ensureStudy = (): StudyRec => {
    if (!curStudy) {
      curStudy = { studyUid: "", date: "", description: "", series: [] };
      ensurePatient().studies.push(curStudy);
    }
    return curStudy;
  };
  const ensureSeries = (): SeriesRec => {
    if (!curSeries) {
      curSeries = { seriesUid: "", number: null, description: "", modality: "", images: [] };
      ensureStudy().series.push(curSeries);
    }
    return curSeries;
  };

  if (seq && seq.items) {
    // DICOMDIR のディレクトリレコードは階層順（深さ優先）に並ぶ（dcm4che 生成物で保証的）。
    // レコード種別を辿りながら現在の patient/study/series を更新して木を組み立てる。
    for (const item of seq.items) {
      const ds = item.dataSet;
      if (!ds) continue;
      const type = (ds.string("x00041430") || "").trim().toUpperCase();
      switch (type) {
        case "PATIENT": {
          curPatient = {
            id: (ds.string("x00100020") || "NoPatientID").trim(),
            name: formatPersonName(ds.string("x00100010")),
            studies: [],
          };
          patients.push(curPatient);
          curStudy = null;
          curSeries = null;
          break;
        }
        case "STUDY": {
          curStudy = {
            studyUid: (ds.string("x0020000d") || "").trim(),
            date: formatDate(ds.string("x00080020")),
            description: (ds.string("x00081030") || "").trim(),
            series: [],
          };
          ensurePatient().studies.push(curStudy);
          curSeries = null;
          break;
        }
        case "SERIES": {
          const sn = ds.intString("x00200011");
          curSeries = {
            seriesUid: (ds.string("x0020000e") || "").trim(),
            number: sn === undefined || Number.isNaN(sn) ? null : sn,
            description: (ds.string("x0008103e") || "").trim(),
            modality: (ds.string("x00080060") || "").trim(),
            images: [],
          };
          ensureStudy().series.push(curSeries);
          break;
        }
        case "IMAGE": {
          const refFileId = ds.string("x00041500");
          if (!refFileId) break;
          const relPath = fileIdToPath(refFileId);
          const inum = ds.intString("x00200013");
          const rec: ImageRec = {
            sopUid: (ds.string("x00041511") || ds.string("x00080018") || "").trim(),
            instanceNumber: inum === undefined || Number.isNaN(inum) ? 0 : inum,
            fileId: relPath,
            sopClassUid: (ds.string("x00041510") || "").trim() || undefined,
          };
          // 実ファイル引き当て: 相対パス一致 → 末端 basename 一致（フォールバック）。
          let file = byPath.get(relPath.toLowerCase());
          if (!file) {
            const base = relPath.split("/").pop()?.toLowerCase() ?? "";
            const cands = byBase.get(base);
            if (cands && cands.length === 1) file = cands[0];
          }
          if (file) rec.file = file;
          else missingFiles++;
          // 動画は同梱 MP4（VIDEO/{sop}.mp4）を引き当てる。無い媒体（旧 Export）もあるので任意扱い。
          if (rec.sopClassUid && VIDEO_SOP_CLASSES.has(rec.sopClassUid) && rec.sopUid) {
            rec.videoFile = byPath.get(`video/${rec.sopUid}.mp4`.toLowerCase());
          }
          ensureSeries().images.push(rec);
          break;
        }
        default:
          // PRIVATE / その他レコードは無視。
          break;
      }
    }
  }

  // 画像を InstanceNumber 昇順に整列。
  for (const p of patients) {
    for (const st of p.studies) {
      for (const se of st.series) {
        se.images.sort((a, b) => a.instanceNumber - b.instanceNumber);
      }
    }
  }

  return { patients, missingFiles };
}
