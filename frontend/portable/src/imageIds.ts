/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Portable 2D Viewer — 画像の実体（File／配信 URL）から cornerstone の imageId を作る。
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import type { ImageRec } from "./dicomdir";

/** 表示できる実体（File か URL）を持つか。 */
export function hasSource(im: ImageRec): boolean {
  return Boolean(im.file || im.url);
}

/** File は `dicomfile:`（fileManager）、URL は `wadouri:` の imageId にする。実体が無ければ null。 */
export function imageIdOf(im: ImageRec): string | null {
  if (im.file) return dicomImageLoader.wadouri.fileManager.add(im.file);
  if (im.url) return `wadouri:${im.url}`;
  return null;
}
