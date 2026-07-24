/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { metaData } from "@cornerstonejs/core";
import { videoRenderedUrl, type VideoMetadata } from "../api";

/**
 * Cornerstone VideoViewport 用のメタデータプロバイダ（方式 A / P3）。
 *
 * <p>VideoViewport の `setVideo(imageId)` は `metaData.get` 経由で以下を解決する:
 * <ul>
 *   <li>`imageUrlModule` → `{ rendered }`（配信 URL。**必須**。無いと throw）</li>
 *   <li>`imagePlaneModule` → `{ rows, columns, ... }`（**undefined を返すと throw**。非 undefined 必須）</li>
 *   <li>`cineModule` → `{ cineRate, numberOfFrames }`（**undefined を返すと throw**。非 undefined 必須）</li>
 * </ul>
 * imageId スキームは `graphy-video:{sop}`。動画は画素校正（PixelSpacing/HU）を持たないため、
 * PixelSpacing は返さず（px ベース）、方向余弦も既定（軸平行）に任せる。
 */

const VIDEO_SCHEME = "graphy-video";

/** SOPInstanceUID から VideoViewport 用 imageId を作る。 */
export const videoImageId = (sopInstanceUid: string): string => `${VIDEO_SCHEME}:${sopInstanceUid}`;

interface VideoEntry {
  rendered: string;
  rows: number;
  columns: number;
  cineRate: number;
  numberOfFrames: number;
  frameTimeMs?: number;
}

/** imageId → メタデータ。プロバイダはここを引くだけ（同期）。 */
const registry = new Map<string, VideoEntry>();

let providerRegistered = false;

function videoMetadataProvider(type: string, imageId: unknown): unknown {
  if (typeof imageId !== "string" || !imageId.startsWith(VIDEO_SCHEME + ":")) {
    return undefined;
  }
  const entry = registry.get(imageId);
  if (!entry) {
    return undefined;
  }
  switch (type) {
    case "imageUrlModule":
      return { rendered: entry.rendered };
    case "imagePlaneModule":
      // 非 undefined 必須。rows/columns のみ供給し、cosines/PixelSpacing は既定に委ねる（px ベース）。
      return {
        rows: entry.rows,
        columns: entry.columns,
        // rowCosines/columnCosines/imagePositionPatient/PixelSpacing は敢えて未供給
        // → VideoViewport 側で軸平行・spacing=1 の既定にフォールバックする。
      };
    case "cineModule":
      return {
        cineRate: entry.cineRate,
        numberOfFrames: entry.numberOfFrames,
        frameTime: entry.frameTimeMs,
      };
    default:
      return undefined;
  }
}

/** プロバイダを一度だけ登録する（冪等）。 */
export function ensureVideoMetadataProvider(): void {
  if (providerRegistered) {
    return;
  }
  // 高優先度で登録（動画 imageId は他のプロバイダが解決できないため衝突しないが、明示する）。
  metaData.addProvider(videoMetadataProvider, 10_000);
  providerRegistered = true;
}

/**
 * SOP の動画メタデータを登録し、VideoViewport 用 imageId を返す。
 * `setVideo` の前に呼ぶこと（プロバイダが解決できるようにするため）。
 */
export function registerVideoMetadata(sopInstanceUid: string, meta: VideoMetadata): string {
  const imageId = videoImageId(sopInstanceUid);
  const fps = meta.fps > 0 ? meta.fps : (meta.cineRate ?? 0);
  registry.set(imageId, {
    rendered: videoRenderedUrl(sopInstanceUid),
    rows: meta.rows,
    columns: meta.columns,
    cineRate: meta.cineRate && meta.cineRate > 0 ? meta.cineRate : fps,
    numberOfFrames: meta.numberOfFrames,
    frameTimeMs: meta.frameTimeMs ?? (fps > 0 ? 1000 / fps : undefined),
  });
  return imageId;
}
