/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { AttachError, PDF_MAX_PAGES } from "./limits";

/** pdfjs-dist の使う側の最小の型（動的 import の結果／node 試験用の legacy ビルドのどちらも満たす）。 */
export interface PdfjsLike {
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocLike>; destroy?: () => unknown };
}
interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: Array<{ str?: string; hasEOL?: boolean }> }> }>;
  destroy?: () => unknown;
}

export interface PdfText {
  text: string;
  pages: number;
  /** 本文が取れなかった頁（スキャン画像など）。 */
  emptyPages: number[];
}

export async function extractPdf(buf: ArrayBuffer, pdfjs: PdfjsLike): Promise<PdfText> {
  const task = pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) });
  let doc: PdfDocLike;
  try {
    doc = await task.promise;
  } catch (e) {
    throw new AttachError((e as { name?: string })?.name === "PasswordException" ? "encrypted" : "broken");
  }
  try {
    const n = Math.min(doc.numPages, PDF_MAX_PAGES);
    const parts: string[] = [];
    const emptyPages: number[] = [];
    for (let i = 1; i <= n; i++) {
      const tc = await (await doc.getPage(i)).getTextContent();
      const s = tc.items.map((it) => (it.str ?? "") + (it.hasEOL ? "\n" : "")).join("").trim();
      if (!s) emptyPages.push(i);
      parts.push(`## 頁 ${i}\n${s}`);
    }
    if (emptyPages.length === n && n > 0 && !parts.some((p) => p.split("\n").slice(1).join("").trim())) {
      return { text: "", pages: doc.numPages, emptyPages };
    }
    return { text: parts.join("\n\n") + (doc.numPages > n ? `\n(以下 ${doc.numPages - n} 頁省略)` : ""), pages: doc.numPages, emptyPages };
  } finally {
    void doc.destroy?.();
  }
}
