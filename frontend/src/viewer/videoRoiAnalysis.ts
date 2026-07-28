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

/** ROI 内画素の統計（フレーム非依存）。輝度は Rec.601 luma。 */
export interface RoiFrameStats {
  nPixels: number;
  meanY: number;
  minY: number;
  maxY: number;
  sdY: number; // 母集団標準偏差
  meanR: number;
  meanG: number;
  meanB: number;
}

/** 1 フレームの統計。 */
export interface TimeSeriesPoint extends RoiFrameStats {
  frame: number; // 1-based
  timeSec: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * bbox の RGBA 画素列（`getImageData(...).data`, 長さ `bw*bh*4`）から ROI 内統計を算出する純粋関数。
 * 楕円マスクは bbox に内接する軸平行楕円（中心 (bw-1)/2, (bh-1)/2、半径 bw/2, bh/2）。DOM に依存しないので
 * vitest で直接検証できる。
 */
export function computeRoiStats(
  data: Uint8ClampedArray | number[],
  bw: number,
  bh: number,
  shape: "rect" | "ellipse",
): RoiFrameStats {
  const cx = (bw - 1) / 2;
  const cy = (bh - 1) / 2;
  const rx = Math.max(0.5, bw / 2);
  const ry = Math.max(0.5, bh / 2);

  let sumY = 0;
  let sumY2 = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  let n = 0;
  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      if (shape === "ellipse") {
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
      const y = 0.299 * r + 0.587 * g + 0.114 * b;
      sumR += r;
      sumG += g;
      sumB += b;
      sumY += y;
      sumY2 += y * y;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      n++;
    }
  }
  const inv = n > 0 ? 1 / n : 0;
  const meanY = sumY * inv;
  // 分散 = E[Y^2] - E[Y]^2（負の丸め誤差はクランプ）。
  const varY = Math.max(0, sumY2 * inv - meanY * meanY);
  return {
    nPixels: n,
    meanY,
    minY: n > 0 ? minY : 0,
    maxY: n > 0 ? maxY : 0,
    sdY: Math.sqrt(varY),
    meanR: sumR * inv,
    meanG: sumG * inv,
    meanB: sumB * inv,
  };
}

/** ROI 内輝度のヒストグラム（8bit 動画なので値域は 0–255 固定）。 */
export interface RoiHistogram {
  counts: number[];
  binCount: number;
  /** 1 ビンの輝度幅（= 256 / binCount）。 */
  binWidth: number;
  /** 総画素数（= RoiFrameStats.nPixels）。 */
  total: number;
  /** 最頻ビンの度数（縦軸スケール用）。 */
  peakCount: number;
}

/**
 * bbox の RGBA 画素列から ROI 内輝度ヒストグラムを作る純粋関数。値域は 0–255 を `binCount` 等分。
 * 輝度 255 は最終ビンに入れる（`floor` だと 1 つ溢れるためクランプする）。
 */
export function computeRoiHistogram(
  data: Uint8ClampedArray | number[],
  bw: number,
  bh: number,
  shape: "rect" | "ellipse",
  binCount = 64,
): RoiHistogram {
  const nBins = Math.max(1, Math.round(binCount));
  const counts = new Array<number>(nBins).fill(0);
  const cx = (bw - 1) / 2;
  const cy = (bh - 1) / 2;
  const rx = Math.max(0.5, bw / 2);
  const ry = Math.max(0.5, bh / 2);

  let total = 0;
  for (let py = 0; py < bh; py++) {
    for (let px = 0; px < bw; px++) {
      if (shape === "ellipse") {
        const nxp = (px - cx) / rx;
        const nyp = (py - cy) / ry;
        if (nxp * nxp + nyp * nyp > 1) {
          continue;
        }
      }
      const i = (py * bw + px) * 4;
      const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const bin = clamp(Math.floor((clamp(y, 0, 255) / 256) * nBins), 0, nBins - 1);
      counts[bin]++;
      total++;
    }
  }
  return {
    counts,
    binCount: nBins,
    binWidth: 256 / nBins,
    total,
    peakCount: counts.reduce((a, b) => Math.max(a, b), 0),
  };
}

/**
 * ヒストグラムを CSV にする。列: `bin_start,bin_end,count`（bin_end は開区間の上端）。
 */
export function histogramToCsv(hist: RoiHistogram): string {
  const lines = hist.counts.map((c, i) => {
    const lo = i * hist.binWidth;
    return `${lo.toFixed(2)},${(lo + hist.binWidth).toFixed(2)},${c}`;
  });
  return ["bin_start,bin_end,count", ...lines].join("\r\n") + "\r\n";
}

/** ピクセル整数の bbox（`getImageData` に渡せる形）。 */
export interface RoiBbox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * ROI（world=pixel の任意 2 点）を画像内に収まる整数 bbox に正規化する純粋関数。
 * 端点の順序は問わない（min/max を取る）。画像外は画像内へクランプし、幅・高さは最低 1px。
 */
export function roiBboxPixels(roi: RoiPixels, cols: number, rows: number): RoiBbox {
  const maxX = Math.max(0, cols - 1);
  const maxY = Math.max(0, rows - 1);
  const x0 = clamp(Math.round(Math.min(roi.x0, roi.x1)), 0, maxX);
  const y0 = clamp(Math.round(Math.min(roi.y0, roi.y1)), 0, maxY);
  const x1 = clamp(Math.round(Math.max(roi.x0, roi.x1)), 0, maxX);
  const y1 = clamp(Math.round(Math.max(roi.y0, roi.y1)), 0, maxY);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0 + 1), h: Math.max(1, y1 - y0 + 1) };
}

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

/** ROI の bbox 画素を任意フレームから取り出すサンプラ（オフスクリーン `<video>` ＋ canvas）。 */
interface FrameSampler {
  fps: number;
  nFrames: number;
  /** frame は 1-based。返る `data` は bbox 範囲の RGBA。 */
  sample(roi: RoiPixels, frame: number): Promise<{ data: Uint8ClampedArray; bw: number; bh: number }>;
  close(): void;
}

/**
 * オフスクリーン `<video>` を開き、フレーム単位で ROI 画素を読めるようにする。
 * `analyzeGlobalRoi`（全フレーム走査）と `analyzeFrameRoi`（単一フレーム）で共有する。
 */
async function createFrameSampler(renderedUrl: string, meta: VideoMetadata): Promise<FrameSampler> {
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
  } catch (e) {
    video.removeAttribute("src");
    video.load();
    throw e;
  }

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
  const fps = meta.fps > 0 ? meta.fps : duration > 0 ? meta.numberOfFrames / duration : 30;
  const nFrames = Math.max(1, meta.numberOfFrames);

  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    video.removeAttribute("src");
    video.load();
    throw new Error("2d context unavailable");
  }

  return {
    fps,
    nFrames,
    async sample(roi, frame) {
      const box = roiBboxPixels(roi, cols, rows);
      // フレーム中心の時刻へシーク（duration を僅かに超えないようクランプ）。
      const tExact = (frame - 1 + 0.5) / fps;
      const t = duration > 0 ? Math.min(tExact, duration - 1e-3) : tExact;
      await seekTo(video, Math.max(0, t));
      ctx.drawImage(video, 0, 0, cols, rows);
      return { data: ctx.getImageData(box.x, box.y, box.w, box.h).data, bw: box.w, bh: box.h };
    },
    close() {
      video.removeAttribute("src");
      video.load(); // デコーダ解放
    },
  };
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
  const sampler = await createFrameSampler(renderedUrl, meta);
  try {
    const series: TimeSeriesPoint[] = [];
    for (let f = 1; f <= sampler.nFrames; f++) {
      if (signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      const { data, bw, bh } = await sampler.sample(roi, f);
      const stats = computeRoiStats(data, bw, bh, roi.shape);
      series.push({ frame: f, timeSec: (f - 1) / sampler.fps, ...stats });
      onProgress?.(f, sampler.nFrames);
    }
    return series;
  } finally {
    sampler.close();
  }
}

/** 単一フレーム解析の結果（統計＋ヒストグラム＋面積）。 */
export interface FrameRoiResult extends RoiFrameStats {
  frame: number;
  timeSec: number;
  /** ROI bbox（px）。面積は nPixels（PixelSpacing 未供給のため px² 単位）。 */
  bbox: RoiBbox;
  histogram: RoiHistogram;
}

/**
 * フレーム指定 ROI の単一フレーム統計（面積・平均/最大/最小・SD・ヒストグラム）を算出する（§12 モード①）。
 *
 * @param frame 1-based フレーム番号
 * @param bins  ヒストグラムのビン数
 */
export async function analyzeFrameRoi(
  renderedUrl: string,
  meta: VideoMetadata,
  roi: RoiPixels,
  frame: number,
  bins = 64,
): Promise<FrameRoiResult> {
  const sampler = await createFrameSampler(renderedUrl, meta);
  try {
    const f = Math.min(Math.max(1, Math.round(frame)), sampler.nFrames);
    const { data, bw, bh } = await sampler.sample(roi, f);
    const stats = computeRoiStats(data, bw, bh, roi.shape);
    return {
      ...stats,
      frame: f,
      timeSec: (f - 1) / sampler.fps,
      bbox: roiBboxPixels(roi, meta.columns, meta.rows),
      histogram: computeRoiHistogram(data, bw, bh, roi.shape, bins),
    };
  } finally {
    sampler.close();
  }
}

/**
 * 時系列を CSV 文字列にする。
 * 列: frame,time_sec,n_pixels,mean_luma,min_luma,max_luma,sd_luma,mean_r,mean_g,mean_b
 */
export function timeSeriesToCsv(series: TimeSeriesPoint[]): string {
  const header = "frame,time_sec,n_pixels,mean_luma,min_luma,max_luma,sd_luma,mean_r,mean_g,mean_b";
  const lines = series.map(
    (p) =>
      `${p.frame},${p.timeSec.toFixed(4)},${p.nPixels},${p.meanY.toFixed(3)},${p.minY.toFixed(3)},${p.maxY.toFixed(3)},${p.sdY.toFixed(3)},${p.meanR.toFixed(3)},${p.meanG.toFixed(3)},${p.meanB.toFixed(3)}`,
  );
  return [header, ...lines].join("\r\n") + "\r\n";
}
