/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { VideoMetadata } from "../api";

/**
 * 動画のグローバル ROI 時系列解析（P3c / §12）。
 *
 * <p>1 つの ROI を全フレームに適用し、フレーム（＝時間）ごとに ROI 内画素の統計を出して
 * **時系列カーブ（time–intensity）** を得る。統計は backend 再デコードに頼らず、フロントで
 * **オフスクリーン `<video>`（`crossOrigin="anonymous"`）をフレーム時刻へシークして native 解像度で
 * canvas 描画 → `getImageData`** して算出する。`/rendered` は CORS 許可済み（`Access-Control-Allow-Origin`）
 * なので canvas は汚染されず読み取れる。
 *
 * <p>ROI 幾何は VideoViewport の world 座標＝ピクセル座標（PixelSpacing 未供給で spacing=1・origin=0・
 * 軸平行）なので、cornerstone annotation の world 点をそのままピクセル bbox として使える。表示のズーム/
 * WW-WL に依存しない（native フレーム画素を読むため）。
 */

/** ピクセル座標系（col=x, row=y）の ROI。 */
export interface RoiPixels {
  shape: "rect" | "ellipse";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 1 フレームの統計。 */
export interface TimeSeriesPoint {
  frame: number; // 1-based
  timeSec: number;
  nPixels: number;
  meanY: number; // 平均輝度（Rec.601 luma）
  meanR: number;
  meanG: number;
  meanB: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    const onSeeked = () => {
      v.removeEventListener("seeked", onSeeked);
      resolve();
    };
    v.addEventListener("seeked", onSeeked);
    v.currentTime = t;
  });
}

/**
 * グローバル ROI の時系列（全フレームの ROI 内平均輝度/平均 RGB）を算出する。
 *
 * @param renderedUrl `/api/instances/{sop}/rendered`
 * @param meta        動画諸元（columns/rows/fps/numberOfFrames）
 * @param roi         ピクセル座標の ROI（rect/ellipse）
 * @param onProgress  進捗コールバック（done, total）
 * @param signal      中断（AbortSignal）
 */
export async function analyzeGlobalRoi(
  renderedUrl: string,
  meta: VideoMetadata,
  roi: RoiPixels,
  onProgress?: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<TimeSeriesPoint[]> {
  const cols = meta.columns;
  const rows = meta.rows;
  if (cols <= 0 || rows <= 0) {
    throw new Error("invalid video dimensions");
  }

  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.muted = true;
  video.preload = "auto";
  video.src = renderedUrl;

  try {
    await new Promise<void>((resolve, reject) => {
      const onMeta = () => {
        cleanup();
        resolve();
      };
      const onErr = () => {
        cleanup();
        reject(new Error("video load failed"));
      };
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onMeta);
        video.removeEventListener("error", onErr);
      };
      video.addEventListener("loadedmetadata", onMeta);
      video.addEventListener("error", onErr);
    });

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    const fps = meta.fps > 0 ? meta.fps : duration > 0 ? meta.numberOfFrames / duration : 30;
    const nFrames = Math.max(1, meta.numberOfFrames);

    // ROI bbox（ピクセル）をクランプ。
    const bx0 = clamp(Math.round(Math.min(roi.x0, roi.x1)), 0, cols - 1);
    const by0 = clamp(Math.round(Math.min(roi.y0, roi.y1)), 0, rows - 1);
    const bx1 = clamp(Math.round(Math.max(roi.x0, roi.x1)), 0, cols - 1);
    const by1 = clamp(Math.round(Math.max(roi.y0, roi.y1)), 0, rows - 1);
    const bw = Math.max(1, bx1 - bx0 + 1);
    const bh = Math.max(1, by1 - by0 + 1);

    // 楕円マスク中心・半径（bbox 内相対）。
    const cx = (bw - 1) / 2;
    const cy = (bh - 1) / 2;
    const rx = Math.max(0.5, bw / 2);
    const ry = Math.max(0.5, bh / 2);

    const canvas = document.createElement("canvas");
    canvas.width = cols;
    canvas.height = rows;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new Error("2d context unavailable");
    }

    const series: TimeSeriesPoint[] = [];
    for (let f = 0; f < nFrames; f++) {
      if (signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      // フレーム中心の時刻へシーク（duration を僅かに超えないようクランプ）。
      const tExact = (f + 0.5) / fps;
      const t = duration > 0 ? Math.min(tExact, duration - 1e-3) : tExact;
      await seekTo(video, Math.max(0, t));
      ctx.drawImage(video, 0, 0, cols, rows);
      const data = ctx.getImageData(bx0, by0, bw, bh).data; // RGBA

      let sumY = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let n = 0;
      for (let py = 0; py < bh; py++) {
        for (let px = 0; px < bw; px++) {
          if (roi.shape === "ellipse") {
            const nxp = (px - cx) / rx;
            const nyp = (py - cy) / ry;
            if (nxp * nxp + nyp * nyp > 1) {
              continue;
            }
          }
          const i = (py * bw + px) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          sumR += r;
          sumG += g;
          sumB += b;
          sumY += 0.299 * r + 0.587 * g + 0.114 * b;
          n++;
        }
      }
      const inv = n > 0 ? 1 / n : 0;
      series.push({
        frame: f + 1,
        timeSec: f / fps,
        nPixels: n,
        meanY: sumY * inv,
        meanR: sumR * inv,
        meanG: sumG * inv,
        meanB: sumB * inv,
      });
      onProgress?.(f + 1, nFrames);
    }
    return series;
  } finally {
    video.removeAttribute("src");
    video.load(); // デコーダ解放
  }
}

/** 時系列を CSV 文字列にする（frame,time_sec,n_pixels,mean_luma,mean_r,mean_g,mean_b）。 */
export function timeSeriesToCsv(series: TimeSeriesPoint[]): string {
  const header = "frame,time_sec,n_pixels,mean_luma,mean_r,mean_g,mean_b";
  const lines = series.map(
    (p) =>
      `${p.frame},${p.timeSec.toFixed(4)},${p.nPixels},${p.meanY.toFixed(3)},${p.meanR.toFixed(3)},${p.meanG.toFixed(3)},${p.meanB.toFixed(3)}`,
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}
