/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 添付の種類判定と上限。値は暫定（plan S3）。実モデルで測って見直す。

export type AttachKind = "text" | "pdf" | "docx" | "xlsx" | "pptx" | "video" | "image" | "legacy" | "unknown";

export const MAX_ATTACHMENTS = 5;
/** 読み込む前にファイルサイズで断る上限（バイト）。 */
export const MAX_BYTES: Record<Exclude<AttachKind, "image" | "legacy" | "unknown">, number> = {
  text: 2 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
  xlsx: 25 * 1024 * 1024,
  pptx: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};
/** 1 添付・1 送信あたりの抽出文字数（クラウド宛て／この PC のローカル LLM 宛て）。 */
export const CHAR_BUDGET = {
  cloud: { perFile: 30_000, total: 60_000 },
  local: { perFile: 6_000, total: 6_000 },
} as const;
/** zip を展開したときの総バイト数。これを超える文書は zip 爆弾として断る。 */
export const MAX_UNZIPPED_BYTES = 200 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 5000;
export const XLSX_MAX_ROWS = 200;
export const PDF_MAX_PAGES = 100;
export const VIDEO_MAX_FRAMES = 6;
export const VIDEO_FRAME_LONG_EDGE = 768;

const TEXT_EXT = new Set(["txt", "md", "csv", "tsv", "json", "log", "xml", "yaml", "yml", "ini"]);

export function classify(name: string, mime: string): AttachKind {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/") || ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "xlsx") return "xlsx";
  if (ext === "pptx") return "pptx";
  if (["doc", "xls", "ppt"].includes(ext)) return "legacy";
  if (TEXT_EXT.has(ext) || mime.startsWith("text/")) return "text";
  return "unknown";
}

export class AttachError extends Error {
  constructor(public code: "tooLarge" | "legacy" | "unsupported" | "broken" | "encrypted" | "bomb" | "empty" | "read") {
    super(code);
  }
}
