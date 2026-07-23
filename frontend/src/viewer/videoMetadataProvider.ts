/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Cornerstone3D の VideoViewport 用メタデータプロバイダ。
//
// VideoViewport.setVideo(imageId) は imageId を「imageUrlModule / generalSeriesModule / cineModule /
// imagePlaneModule」の 4 モジュールでメタデータ解決する（VideoViewport.js 実装で確認済）。
// - imageUrlModule.rendered … <video>.src に入る MP4 URL（必須。無いと throw）
// - cineModule … `{ cineRate, numberOfFrames }` を分割代入で読むため必ずオブジェクトを返す（undefined は不可）
// - imagePlaneModule … getImageDataMetadata が rows/columns/cosines を参照するため必ず返す（cosines 省略で既定）
// - generalSeriesModule … Modality のみ（表示用）
//
// 動画は backend `/video-metadata` から諸元を取ってから setVideo を呼ぶ。ここは同期プロバイダなので、
// VideoViewer が setVideo 前に registerVideoMetadata(sop, meta) で諸元を登録しておく。
import { metaData } from "@cornerstonejs/core";
import { videoRenderedUrl, type VideoMetadata } from "../api";

/** 動画 imageId スキーム（`graphy-video:<sop>`）。 */
export const VIDEO_SCHEME = "graphy-video";

/** SOP UID → 動画 imageId。 */
export const videoImageId = (sopUid: string): string => `${VIDEO_SCHEME}:${sopUid}`;

interface Entry {
  sopUid: string;
  meta: VideoMetadata;
}

/** imageId → 登録済みエントリ。 */
const entries = new Map<string, Entry>();

let registered = false;

/**
 * 動画の諸元と rendered URL を登録し、対応する imageId を返す。setVideo の前に呼ぶこと。
 */
export function registerVideoMetadata(sopUid: string, meta: VideoMetadata): string {
  const imageId = videoImageId(sopUid);
  entries.set(imageId, { sopUid, meta });
  return imageId;
}

/**
 * VideoViewport 用メタデータプロバイダを登録する。冪等（何度呼ばれても 1 回だけ）。
 * cornerstone 初期化後・setVideo の前に呼ぶ。
 */
export function registerVideoMetadataProvider(): void {
  if (registered) return;
  registered = true;

  metaData.addProvider((type: string, ...query: string[]): unknown => {
    const imageId = query[0];
    const entry = entries.get(imageId);
    if (!entry) return undefined;
    const { sopUid, meta } = entry;

    switch (type) {
      case "imageUrlModule":
        return { rendered: videoRenderedUrl(sopUid) };
      case "generalSeriesModule":
        // Modality は表示用のみ（動画由来モダリティ不明時は XC=External-camera Photography）。
        return { Modality: "XC" };
      case "cineModule":
        return {
          cineRate: meta.fps ?? meta.cineRate ?? undefined,
          numberOfFrames: meta.numberOfFrames || undefined,
        };
      case "imagePlaneModule":
        // cosines は省略 → VideoViewport が既定（軸平面）を使う。動画は実空間幾何を持たない。
        return { rows: meta.rows, columns: meta.columns };
      default:
        return undefined;
    }
  }, 10000);
}
