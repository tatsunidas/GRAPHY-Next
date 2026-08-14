/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA シネのフレームを PNG で書き出す（`fw/angio-design.md` §14.3 / A10）。
 *
 * <p>表示中の VOI（W/L）と白黒反転を適用した 8bit グレースケールに焼いてから PNG にする。
 * DSA 表示中なら差分画像がそのまま出る（合成 imageId の画素を読むため）。
 *
 * <p>⚠️ <b>画素に焼き込まれた患者情報（バーンドイン注釈）は消えない</b>。DICOM のタグは
 * PNG には入らないが、画像そのものに文字が写り込んでいる装置がある。UI で必ず確認を出すこと。
 */
import { readModalitySlice } from "./pixelCalibration";
import { buildStoredZip, type ZipEntry } from "./zipStore";

/** 焼き込みに使う表示条件。 */
export interface XaExportWindow {
  windowCenter: number;
  windowWidth: number;
  invert: boolean;
}

/** 値域 [center-width/2, center+width/2] を 0..255 に線形写像する（VOI の焼き込み）。 */
export function applyWindow(
  values: Float32Array,
  win: XaExportWindow,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length);
  const half = win.windowWidth / 2;
  const lo = win.windowCenter - half;
  const range = win.windowWidth;
  const scale = range > 0 ? 255 / range : 0;
  for (let i = 0; i < values.length; i++) {
    let v = (values[i] - lo) * scale;
    if (v < 0) v = 0;
    else if (v > 255) v = 255;
    out[i] = win.invert ? 255 - v : v;
  }
  return out;
}

/** VOI が指定されていないときに使う自動値（2〜98 パーセンタイル）。 */
export function autoWindow(values: Float32Array): { windowCenter: number; windowWidth: number } {
  const sorted = Float32Array.from(values).sort();
  const at = (q: number) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * q)))];
  const lo = at(0.02);
  const hi = at(0.98);
  const width = Math.max(hi - lo, 1e-6);
  return { windowCenter: (hi + lo) / 2, windowWidth: width };
}

/** 1 フレームを PNG（グレースケール焼き込み）にする。読めなければ null。 */
async function frameToPng(imageId: string, win: XaExportWindow | null): Promise<Uint8Array | null> {
  const slice = await readModalitySlice(imageId);
  if (!slice) return null;
  const w = win ?? { ...autoWindow(slice.values), invert: false };
  const gray = applyWindow(slice.values, w);

  const canvas = document.createElement("canvas");
  canvas.width = slice.width;
  canvas.height = slice.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const img = ctx.createImageData(slice.width, slice.height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    img.data[p] = gray[i];
    img.data[p + 1] = gray[i];
    img.data[p + 2] = gray[i];
    img.data[p + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/** 進捗コールバック（0..1）。 */
export type ProgressFn = (done: number, total: number) => void;

/**
 * フレーム列を PNG にして 1 つの ZIP にまとめる。
 *
 * <p>個別ダウンロードにしないのは、96 フレームで 96 回のダウンロード確認が出て実用にならないため。
 *
 * @returns ZIP のバイト列。1 枚も書き出せなければ null
 */
export async function exportFramesAsZip(
  imageIds: readonly string[],
  win: XaExportWindow | null,
  baseName: string,
  onProgress?: ProgressFn,
): Promise<Uint8Array | null> {
  const entries: ZipEntry[] = [];
  for (let i = 0; i < imageIds.length; i++) {
    const png = await frameToPng(imageIds[i], win);
    if (png) {
      entries.push({ name: `${baseName}-${String(i + 1).padStart(4, "0")}.png`, data: png });
    }
    onProgress?.(i + 1, imageIds.length);
  }
  return entries.length ? buildStoredZip(entries) : null;
}

/** バイト列をダウンロードさせる。 */
export function downloadBytes(bytes: Uint8Array, fileName: string, mime: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  // revoke を遅らせないと、クリック直後の取得が間に合わないブラウザがある。
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
