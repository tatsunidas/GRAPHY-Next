/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン向け `host.renderPdf`: HTML → PDF のバイト列（保存はしない。保存は `file.saveAs`）。
 *
 * <p>描画は main（`desktop/pdfRender.js`）。表示しない窓・JavaScript 無し・外部への通信は全部止める。
 * ここでは**入口の型の検査**だけを持つ（main でも同じ検査をする）。例外は投げない。
 * デスクトップ以外は `desktop-only`。
 */
import { desktop, type RenderPdfResult } from "../desktopBridge";

export interface PluginRenderPdfRequest {
  /** 完結した HTML 文書。外部の画像・CSS・スクリプトは読まれない（画像は `data:` で埋める）。8 MB まで。 */
  html: string;
  /** 用紙。省略は A4。 */
  pageSize?: "A4" | "Letter";
  /** 横向き。省略は縦。 */
  landscape?: boolean;
}

export async function renderPdf(req: PluginRenderPdfRequest): Promise<RenderPdfResult> {
  const d = desktop();
  if (!d?.renderPdf) return { ok: false, error: "desktop-only" };
  if (!req || typeof req.html !== "string" || req.html.length === 0) return { ok: false, error: "bad-request" };
  try {
    return await d.renderPdf(req);
  } catch {
    return { ok: false, error: "render-failed" };
  }
}
