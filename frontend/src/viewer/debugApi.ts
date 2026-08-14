/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { getRenderingEngine } from "@cornerstonejs/core";
import { ENGINE_ID } from "./Viewer2D";
import { readCamera, readColormapName, readVoiWindow } from "./viewportRead";

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

/** 各ビューポートのカメラ/フィット幾何。フィット不良（極小/隅寄り）の原因切り分け用。 */
export interface ViewportGeometry {
  viewportId: string;
  imageId: string | null;
  canvas: { width: number; height: number; clientWidth: number; clientHeight: number };
  camera: {
    parallelScale: number | null;
    position: number[] | null;
    focalPoint: number[] | null;
  };
  image: {
    dimensions: number[] | null; // [cols, rows, 1]
    spacing: number[] | null; // [colSpacing, rowSpacing, sliceSpacing]
    origin: number[] | null;
    direction: number[] | null;
  } | null;
}

function getViewportGeometry(): ViewportGeometry[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: ViewportGeometry[] = [];
  for (const vp of engine.getViewports()) {
    const canvas = vp.canvas as HTMLCanvasElement | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyVp = vp as any;
    const cam = readCamera(anyVp);
    let image: ViewportGeometry["image"] = null;
    try {
      const d = anyVp.getImageData?.();
      if (d) {
        image = {
          dimensions: d.dimensions ?? null,
          spacing: d.spacing ?? null,
          origin: d.origin ?? null,
          direction: d.direction ? Array.from(d.direction as number[]) : null,
        };
      }
    } catch { /* ignore */ }
    out.push({
      viewportId: vp.id,
      imageId: (anyVp.getCurrentImageId?.() as string) ?? null,
      canvas: {
        width: canvas?.width ?? 0,
        height: canvas?.height ?? 0,
        clientWidth: canvas?.clientWidth ?? 0,
        clientHeight: canvas?.clientHeight ?? 0,
      },
      camera: cam,
      image,
    });
  }
  return out;
}

/** 各ビューポートの LUT(colormap)・W/L(voiRange) 適用状態。LUT/W-L系 checklist item の検証用。 */
export interface ViewportProperties {
  viewportId: string;
  /** 適用中の colormap 名。未適用（既定グレースケール）なら null。 */
  colormapName: string | null;
  /** 適用中の window/level（voiRange から算出）。取得不可なら null。 */
  windowLevel: { center: number; width: number } | null;
}

function getViewportProperties(): ViewportProperties[] {
  const engine = getRenderingEngine(ENGINE_ID);
  if (!engine) return [];
  const out: ViewportProperties[] = [];
  for (const vp of engine.getViewports()) {
    out.push({
      viewportId: vp.id,
      // checklist は「LUT を当てたか」を見るので、内部グレースケール名は畳まず生の名前を返す。
      colormapName: readColormapName(vp),
      windowLevel: readVoiWindow(vp),
    });
  }
  return out;
}

/**
 * XA シネ再生の実測値（automator の受け入れ条件 §5.8-2 / §5.8-7 用）。
 *
 * <p>`setStackCalls` は「フレーム送りのたびにスタックを組み直していないか」を数値で示すためのもの。
 * XA でここが増え続けるなら stackAxis の配線が壊れている（30fps に届かない）。
 */
export interface XaCineStats {
  /** 直近 1 秒で進んだフレーム数（実測 fps）。 */
  measuredFps: number;
  /** 公称 fps（DICOM タグ由来）と、その決定根拠。 */
  nominalFps: number;
  fpsSource: string;
  /** 再生中に描画したフレーム数の累計。 */
  framesRendered: number;
  /** Viewer2D に渡した imageIds が差し替わった回数（= setStack 相当）。 */
  setStackCalls: number;
}

const xaCineStats: XaCineStats = {
  measuredFps: 0,
  nominalFps: 0,
  fpsSource: "",
  framesRendered: 0,
  setStackCalls: 0,
};

/** シネ側から実測値を書き込む（DEV のみ意味を持つ。本番ビルドでも無害）。 */
export function reportXaCineStats(patch: Partial<XaCineStats>): void {
  Object.assign(xaCineStats, patch);
}

/** スタック差し替えを数える（XA でフレーム送りのたびに増えていたら配線ミス）。 */
export function countStackSwap(): void {
  xaCineStats.setStackCalls += 1;
}

function getXaCineStats(): XaCineStats {
  return { ...xaCineStats };
}

declare global {
  interface Window {
    __graphyDebug?: {
      getPixelStats: typeof getPixelStats;
      getViewportGeometry: typeof getViewportGeometry;
      getViewportProperties: typeof getViewportProperties;
      getXaCineStats: typeof getXaCineStats;
    };
  }
}

let installed = false;

/** 冪等: 何度呼んでも安全（SeriesViewer マウントの都度呼ばれる想定）。 */
export function installDebugApi(): void {
  if (installed || !import.meta.env.DEV) return;
  window.__graphyDebug = {
    getPixelStats,
    getViewportGeometry,
    getViewportProperties,
    getXaCineStats,
  };
  installed = true;
}
