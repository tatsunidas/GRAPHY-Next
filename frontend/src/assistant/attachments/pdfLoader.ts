/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { PdfjsLike } from "./pdf";

/** PDF を添付したときだけ読み込む（pdfjs は大きいので起動時には載せない）。worker は同一オリジンで配る（CSP の worker-src 'self'）。 */
export async function loadPdfjs(): Promise<PdfjsLike> {
  const [mod, worker] = await Promise.all([import("pdfjs-dist"), import("pdfjs-dist/build/pdf.worker.min.mjs?url")]);
  mod.GlobalWorkerOptions.workerSrc = worker.default;
  return mod as unknown as PdfjsLike;
}
