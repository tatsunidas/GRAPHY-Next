/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * セグメンテーション用の軽量メタデータプロバイダ。
 *
 * 目的: 空マスク（labelmap）作成に **source 画素のロードを不要**にする。
 * `createAndCacheDerivedLabelmapImage` は `imagePlaneModule`（rows/cols/spacing/IPP/IOP）だけを読み、
 * 空の Uint8Array を確保する（source 画素は読まない）。ところが imageId は wadouri（1スライス1ファイル）で、
 * ファイルをパースするまで Cornerstone にジオメトリが登録されないため、現状は全スライスをプリロードしていた。
 *
 * ここでは backend の `SeriesLayoutDto`（IOP/PixelSpacing/幅高さ/per-Z IPP/FoR = ZCT レイアウト取得時に既に fetch 済）
 * から各 imageId の `imagePlaneModule`・`generalSeriesModule` を供給する Cornerstone メタデータプロバイダを登録する。
 * → labelmap 生成が画素ロードゼロで即時化。設計 `fw/segmentation-tools-design.md` §3.4。
 *
 * 優先度は **低め（-1）** に登録し、実ファイルのロード後は wadouri の実メタデータ（高優先）が勝つ（整合性維持）。
 */
import { metaData } from "@cornerstonejs/core";
import type { SeriesLayoutDto } from "../api";
import type { SeriesLayout } from "./seriesLayout";

type Vec3 = [number, number, number];

interface PlaneMeta {
  rows: number;
  columns: number;
  imageOrientationPatient: number[];
  rowCosines: Vec3;
  columnCosines: Vec3;
  imagePositionPatient: Vec3;
  pixelSpacing: [number, number]; // [row, col]
  rowPixelSpacing: number;
  columnPixelSpacing: number;
  frameOfReferenceUID?: string;
}

interface SeriesMeta {
  seriesInstanceUID: string;
  modality?: string;
}

const planeByImageId = new Map<string, PlaneMeta>();
const seriesByImageId = new Map<string, SeriesMeta>();

let providerRegistered = false;

/** Cornerstone にプロバイダを 1 度だけ登録する（`ensureCornerstoneInitialized` から呼ぶ）。 */
export function registerSegMetadataProvider(): void {
  if (providerRegistered) return;
  providerRegistered = true;
  metaData.addProvider((type: string, imageId: string) => {
    if (type === "imagePlaneModule") return planeByImageId.get(imageId);
    if (type === "generalSeriesModule") return seriesByImageId.get(imageId);
    return undefined;
  }, -1);
}

/**
 * `SeriesLayoutDto` ＋構築済み `SeriesLayout` から、当該シリーズの全 imageId にジオメトリを登録する。
 * 画素ロードは一切行わない。ジオメトリ未取得（IOP/幅高さ/zSpatial なし）なら false を返す（呼び出し側はフォールバック）。
 */
export function registerSegGeometryFromLayout(
  dto: SeriesLayoutDto | null | undefined,
  layout: SeriesLayout,
  seriesUid: string,
  modality?: string | null,
): boolean {
  if (!dto) return false;
  const iop = dto.imageOrientationPatient;
  const rows = dto.imageHeight;
  const cols = dto.imageWidth;
  if (!iop || iop.length < 6 || rows <= 0 || cols <= 0) return false;

  const rowCos: Vec3 = [iop[0], iop[1], iop[2]];
  const colCos: Vec3 = [iop[3], iop[4], iop[5]];
  const psRow = dto.pixelSpacingRow || 1;
  const psCol = dto.pixelSpacingCol || 1;
  const forUid = dto.frameOfReferenceUID ?? undefined;
  const series: SeriesMeta = { seriesInstanceUID: seriesUid, modality: modality ?? undefined };

  const nZ = layout.nZ;
  const nC = Math.max(1, layout.nC);
  const nT = Math.max(1, layout.nT);
  let registered = 0;
  for (let c = 0; c < nC; c++) {
    for (let t = 0; t < nT; t++) {
      const stack = layout.zStack(c, t);
      for (let z = 0; z < nZ && z < stack.length; z++) {
        const imageId = stack[z];
        if (!imageId) continue;
        const ipp = (layout.ippAt?.(z) as Vec3 | null) ?? [0, 0, z];
        planeByImageId.set(imageId, {
          rows,
          columns: cols,
          imageOrientationPatient: iop,
          rowCosines: rowCos,
          columnCosines: colCos,
          imagePositionPatient: ipp,
          pixelSpacing: [psRow, psCol],
          rowPixelSpacing: psRow,
          columnPixelSpacing: psCol,
          frameOfReferenceUID: forUid,
        });
        seriesByImageId.set(imageId, series);
        registered++;
      }
    }
  }
  return registered > 0;
}

/** 指定 imageId 群のジオメトリが（プロバイダまたは実ロード経由で）揃っているか。 */
export function hasPlaneMetadata(imageId: string): boolean {
  if (planeByImageId.has(imageId)) return true;
  const m = metaData.get("imagePlaneModule", imageId) as { rows?: number; columns?: number } | undefined;
  return !!(m && m.rows && m.columns);
}
