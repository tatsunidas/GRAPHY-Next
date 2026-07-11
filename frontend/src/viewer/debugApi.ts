/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { getRenderingEngine } from "@cornerstonejs/core";
import { ENGINE_ID } from "./Viewer2D";

/**
 * automator（自律検証ツール）専用のデバッグAPI。`window.__graphyDebug` として公開し、
 * Playwright から `page.evaluate(() => window.__graphyDebug.getPixelStats())` で
 * 「実際に画素が描画されたか」をDOM/スクリーンショットに頼らず機械的に判定できるようにする。
 *
 * <p>Viewer2D.tsx の内部実装（viewportId の生成規則等）には依存しない: cornerstone3D の
 * 公開APIである RenderingEngine.getViewports() で現在有効な全ビューポートを列挙し、
 * その canvas（WebGL）を一時的な 2D canvas へ drawImage して画素統計を取る。
 *
 * <p>{@link import.meta.env.DEV} でガードしており、`vite build`（本番/インストーラ配布物）には
 * 含まれない（automator は常に `vite dev` 経由でフロントを起動するため、開発ビルドのみで十分）。
 */
export interface PixelStats {
  viewportId: string;
  width: number;
  height: number;
  mean: number;
  min: number;
  max: number;
  /** ほぼ黒(輝度<=2)ではないピクセルの割合。0 に近い場合は「何も描画されていない」可能性が高い。 */
  nonBlackFraction: number;
}

function canvasStats(canvas: HTMLCanvasElement): Omit<PixelStats, "viewportId"> | null {
  const off = document.createElement("canvas");
  off.width = canvas.width;
  off.height = canvas.height;
  const ctx = off.getContext("2d");
  if (!ctx || off.width === 0 || off.height === 0) return null;
  // WebGL(cornerstone3D)キャンバスも drawImage のソースにできる（2D コンテキスト側の制約のみ）。
  ctx.drawImage(canvas, 0, 0);
  const { data } = ctx.getImageData(0, 0, off.width, off.height);
  let sum = 0;
  let min = 255;
  let max = 0;
  let nonBlack = 0;
  const pixelCount = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
    sum += lum;
    if (lum < min) min = lum;
    if (lum > max) max = lum;
    if (lum > 2) nonBlack++;
  }
  return {
    width: off.width,
    height: off.height,
    mean: pixelCount > 0 ? sum / pixelCount : 0,
    min,
    max,
    nonBlackFraction: pixelCount > 0 ? nonBlack / pixelCount : 0,
  };
}

function getPixelStats(): PixelStats[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: PixelStats[] = [];
  for (const vp of engine.getViewports()) {
    const canvas = vp.canvas as HTMLCanvasElement | undefined;
    if (!canvas) continue;
    const stats = canvasStats(canvas);
    if (stats) out.push({ viewportId: vp.id, ...stats });
  }
  return out;
}

declare global {
  interface Window {
    __graphyDebug?: { getPixelStats: typeof getPixelStats };
  }
}

let installed = false;

/** 冪等: 何度呼んでも安全（SeriesViewer マウントの都度呼ばれる想定）。 */
export function installDebugApi(): void {
  if (installed || !import.meta.env.DEV) return;
  window.__graphyDebug = { getPixelStats };
  installed = true;
}
