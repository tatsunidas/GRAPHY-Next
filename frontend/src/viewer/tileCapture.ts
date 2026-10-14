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
