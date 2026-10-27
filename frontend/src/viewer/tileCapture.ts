/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * 表示中の画像に描かれている ROI の数（純関数）。表示中の画像に属し、非表示にしていないもの。
 * 別のスライスの ROI は画面に出ていないので数えない。
 */
export function visibleRoiCount(
  annotations: readonly Any[],
  displayedImageId: string | undefined,
  isVisible: (uid: string) => boolean,
): number {
  if (!displayedImageId) return 0;
  return annotations.filter(
    (a) =>
      a?.metadata?.referencedImageId === displayedImageId &&
      a?.isVisible !== false &&
      isVisible(String(a?.annotationUID)),
  ).length;
}

/**
 * 画像の canvas に、注釈の SVG（Cornerstone の `.svg-layer`。ROI の線と計測の文字）を重ねた PNG。
 * SVG は CSS の大きさで描かれているので、canvas の画素の大きさ（devicePixelRatio 込み）へ引き伸ばす。
 * 四隅の文字は HTML の重ね描きで SVG に入っていないので、含まれない。
 */
export async function composeTileWithAnnotations(canvas: HTMLCanvasElement, svg: SVGSVGElement): Promise<string | null> {
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(rect.width));
  clone.setAttribute("height", String(rect.height));
  clone.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await img.decode();
  const out = document.createElement("canvas");
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0);
  ctx.drawImage(img, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}

/** 長辺が max に収まる大きさ（縦横比を保つ。収まっているものは拡大しない）。不正な値は null。 */
export function fitLongEdge(w: number, h: number, max: number): { w: number; h: number } | null {
  if (![w, h, max].every((n) => Number.isFinite(n) && n > 0)) return null;
  const k = Math.min(1, max / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/** PNG の base64 がこれを超えたら JPEG にする（main の画像 1 枚の上限 8 MiB に余裕を持たせる）。 */
const PNG_MAX_B64 = 4 * 1024 * 1024;

/** 画像（dataURL）を長辺 maxEdge 以下に縮小する。PNG が大きければ JPEG。 */
export async function downscaleDataUrl(
  url: string,
  maxEdge: number,
): Promise<{ dataUrl: string; mimeType: "image/png" | "image/jpeg"; w: number; h: number } | null> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const size = fitLongEdge(img.naturalWidth, img.naturalHeight, maxEdge);
  if (!size) return null;
  const out = document.createElement("canvas");
  out.width = size.w;
  out.height = size.h;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, size.w, size.h);
  const png = out.toDataURL("image/png");
  if (png.length - png.indexOf(",") - 1 <= PNG_MAX_B64) return { dataUrl: png, mimeType: "image/png", ...size };
  return { dataUrl: out.toDataURL("image/jpeg", 0.9), mimeType: "image/jpeg", ...size };
}

export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 各 ROI の canvas 座標（CSS px）の点列から、全体の外接矩形（`[minX, minY, maxX, maxY]`）。
 * 有限でない点は捨てる。有効な点が 1 つも無ければ null。
 */
export function roiBoundsFromCanvasPoints(groups: readonly (readonly (readonly number[])[])[]): [number, number, number, number] | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const g of groups) {
    for (const p of g) {
      if (!Array.isArray(p) || p.length < 2 || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
      minX = Math.min(minX, p[0]);
      minY = Math.min(minY, p[1]);
      maxX = Math.max(maxX, p[0]);
      maxY = Math.max(maxY, p[1]);
    }
  }
  return Number.isFinite(minX) ? [minX, minY, maxX, maxY] : null;
}

/** 切り出しの余白（各辺。外接矩形の辺に対する割合）と最小の余白（CSS px）、最小の辺（CSS px）。暫定値（実モデルで見直す）。 */
export const CROP_MARGIN_FRAC = 0.1;
export const CROP_MARGIN_MIN_PX = 8;
export const CROP_MIN_EDGE_PX = 64;

/**
 * 外接矩形（CSS px）に余白を足し、画像の範囲（`cssW`×`cssH`）に収めて、画素（`scale` = canvas.width / clientWidth）の整数矩形にする。
 * 辺が `CROP_MIN_EDGE_PX` に満たなければ中心を保って広げる（点に近い ROI で読めない画像にしない）。範囲外・不正なら null。
 */
export function cropRect(bounds: readonly [number, number, number, number], cssW: number, cssH: number, scale: number): PixelRect | null {
  if (![...bounds, cssW, cssH, scale].every((n) => Number.isFinite(n)) || cssW <= 0 || cssH <= 0 || scale <= 0) return null;
  const [x0, y0, x1, y1] = bounds;
  const mx = Math.max(CROP_MARGIN_MIN_PX, (x1 - x0) * CROP_MARGIN_FRAC);
  const my = Math.max(CROP_MARGIN_MIN_PX, (y1 - y0) * CROP_MARGIN_FRAC);
  let l = x0 - mx;
  let r = x1 + mx;
  let t = y0 - my;
  let b = y1 + my;
  const grow = (lo: number, hi: number): [number, number] => {
    const need = CROP_MIN_EDGE_PX - (hi - lo);
    return need > 0 ? [lo - need / 2, hi + need / 2] : [lo, hi];
  };
  [l, r] = grow(l, r);
  [t, b] = grow(t, b);
  l = Math.max(0, l);
  t = Math.max(0, t);
  r = Math.min(cssW, r);
  b = Math.min(cssH, b);
  if (!(r > l) || !(b > t)) return null; // 画像の外
  const x = Math.floor(l * scale);
  const y = Math.floor(t * scale);
  const w = Math.ceil(r * scale) - x;
  const h = Math.ceil(b * scale) - y;
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** 画像（dataURL）の矩形だけを PNG にする。 */
export async function cropDataUrl(url: string, rect: PixelRect): Promise<string | null> {
  const img = new Image();
  img.src = url;
  await img.decode();
  const out = document.createElement("canvas");
  out.width = rect.w;
  out.height = rect.h;
  const ctx = out.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(img, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return out.toDataURL("image/png");
}
