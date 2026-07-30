import { getCategory, listCategoryFiles } from "./manifest.js";
import { requireFixtures } from "./checkFixtures.js";

// backend の ImportService.ImportResult(imported, skipped, failed, errors) と一致させる。
export interface ImportResult {
  imported: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/**
 * backend の POST /api/import/paths を直叩きして任意のファイル/フォルダパスを取り込む。
 * standalone 専用 API（backend がローカルファイルパスを読める前提）— automator は常に
 * backend をローカルプロセスとして自前 spawn するため、desktop/web どちらの Driver でも使える。
 *
 * Import UI 自体（ネイティブファイルダイアログ含む）の検証は別途 checklist/04-import-export.md の
 * 専用項目で行う。ここでの直叩きは他項目の前提データ投入を高速化するためのショートカット。
 * 匿名化出力等、fixture以外の任意パスを再取込みして検証したい場合にも使う。
 */
export async function importPaths(httpPort: number, paths: string[]): Promise<ImportResult> {
  const url = `http://127.0.0.1:${httpPort}/api/import/paths`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) {
    throw new Error(`${url} が失敗しました: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as ImportResult;
}

/** backend の NonDicomImportService.Result と一致させる。 */
export interface NonDicomImportResult {
  imported: number;
  skipped: number;
  failed: number;
  studyInstanceUid: string;
  files: { filename: string; status: string; sopClass: string; message: string }[];
}

/**
 * 非 DICOM ファイル（動画 MP4/AVI・画像・PDF）を POST /api/import/nondicom で DICOM 化して取り込む。
 * DICOM 用の {@link importPaths} とはエンドポイントも結果の形も別（こちらは患者情報を呼び側が与える）。
 */
export async function importNonDicomPaths(
  httpPort: number,
  paths: string[],
  patient: { patientId: string; patientName: string; seriesDescription?: string } = {
    patientId: "AUTOMATOR",
    patientName: "AUTOMATOR^NONDICOM",
  },
): Promise<NonDicomImportResult> {
  const url = `http://127.0.0.1:${httpPort}/api/import/nondicom`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      paths,
      patientId: patient.patientId,
      patientName: patient.patientName,
      patientBirthDate: "",
      patientSex: "",
      studyInstanceUid: "",
      studyDescription: "automator",
      accessionNumber: "",
      seriesDescription: patient.seriesDescription ?? "automator",
    }),
  });
  if (!res.ok) {
    throw new Error(`${url} が失敗しました: HTTP ${res.status} ${await res.text().catch(() => "")}`);
  }
  return (await res.json()) as NonDicomImportResult;
}

/** fixtures/<categoryId> 配下の実データを取り込む（importPathsのショートカット）。 */
export async function importFixtureCategory(httpPort: number, categoryId: string): Promise<ImportResult> {
  requireFixtures([categoryId]);
  const cat = getCategory(categoryId);
  const paths = listCategoryFiles(cat);
  return importPaths(httpPort, paths);
}
