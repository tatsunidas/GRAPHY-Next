/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 添付 1 件を「モデルに渡せる形（テキスト＋画像）」にする。取り込みは renderer の中で完結し、main の送信型は変えない。
import { extractDocx, extractPptx, extractXlsx } from "./ooxml";
import { extractPdf, type PdfjsLike } from "./pdf";
import { decodeText } from "./text";
import { looksLikeIdentifiers } from "./identifiers";
import { AttachError, CHAR_BUDGET, MAX_BYTES, classify, type AttachKind } from "./limits";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachKind;
  size: number;
  /** 本文（上限で切る前の全文字数は totalChars）。動画はコマの説明。 */
  text: string;
  totalChars: number;
  /** 動画のコマなど、画像として添える分。 */
  images: Array<{ base64: string; mimeType: string; url: string }>;
  /** 識別子らしき記述が見つかった（目安）。 */
  identifiers: boolean;
  /** スキャン頁などで本文が空だった頁数（PDF）。 */
  emptyPages?: number;
}

export interface IngestDeps {
  loadPdfjs: () => Promise<PdfjsLike>;
  extractVideo: (file: File) => Promise<import("./video").VideoFrames>;
}

let seq = 0;

export async function ingest(file: File, deps: IngestDeps): Promise<Attachment> {
  const kind = classify(file.name, file.type);
  if (kind === "legacy") throw new AttachError("legacy");
  if (kind === "unknown" || kind === "image") throw new AttachError("unsupported");
  if (file.size > MAX_BYTES[kind]) throw new AttachError("tooLarge");
  const base: Attachment = { id: `at-${++seq}`, name: file.name, kind, size: file.size, text: "", totalChars: 0, images: [], identifiers: false };
  if (kind === "video") {
    const v = await deps.extractVideo(file);
    const frames = v.frames.map((f) => `${f.time.toFixed(1)}s`).join(", ");
    const text = `動画 ${v.width}x${v.height}・${v.duration.toFixed(1)} 秒。音声は含まれません。添付の画像は等間隔の ${v.frames.length} コマ（${frames}）。`;
    const images = v.frames.map((f) => ({ base64: f.base64, mimeType: f.mimeType, url: `data:${f.mimeType};base64,${f.base64}` }));
    return { ...base, text, totalChars: text.length, images };
  }
  const buf = await file.arrayBuffer();
  let text: string;
  let emptyPages: number | undefined;
  switch (kind) {
    case "text":
      text = decodeText(buf);
      break;
    case "docx":
      text = await extractDocx(buf);
      break;
    case "xlsx":
      text = await extractXlsx(buf);
      break;
    case "pptx":
      text = await extractPptx(buf);
      break;
    case "pdf": {
      const r = await extractPdf(buf, await deps.loadPdfjs());
      if (!r.text) throw new AttachError("empty");
      text = r.text;
      emptyPages = r.emptyPages.length || undefined;
      break;
    }
  }
  return { ...base, text, totalChars: text.length, identifiers: looksLikeIdentifiers(text), emptyPages };
}

/** 送る本文を組み立てる。宛先がローカル LLM なら文脈が狭いので絞る。切った分は本文中で明示する。 */
export function composeUserText(userText: string, atts: Attachment[], local: boolean): { text: string; truncated: boolean } {
  const b = local ? CHAR_BUDGET.local : CHAR_BUDGET.cloud;
  let left = b.total;
  let truncated = false;
  const blocks: string[] = [];
  for (const a of atts) {
    const take = Math.max(0, Math.min(a.text.length, b.perFile, left));
    left -= take;
    const cut = take < a.text.length;
    truncated ||= cut;
    blocks.push(
      `[添付: ${a.name}（${a.kind}・全 ${a.totalChars} 文字${cut ? `・先頭 ${take} 文字のみ` : ""}）]\n${a.text.slice(0, take)}${cut ? "\n（以下省略）" : ""}`,
    );
  }
  return { text: blocks.length ? `${blocks.join("\n\n")}\n\n${userText}`.trim() : userText, truncated };
}
