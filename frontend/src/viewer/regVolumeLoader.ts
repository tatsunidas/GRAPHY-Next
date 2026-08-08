/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シリーズを丸ごと {@link RegVolume} として読み込む（設計: `fw/registration-design.md` §7）。
 *
 * <p>ここは cornerstone に依存する層。**`regCore` / `regGeometry` / `regMetrics` には
 * cornerstone を持ち込まない**（設計 §11）。境界をこのファイルに閉じることで、
 * 数値の部分をブラウザ無しでテストし続けられる。
 *
 * <p>校正は必ず `pixelCalibration.ts` 経由（`CLAUDE.md` 絶対ルール 2）。
 * `getPixelData()` に直接 slope/intercept を掛けると dicom-image-loader の preScale と
 * 二重適用になり CT で約 −1024 ずれる。
 */

import { imageLoader, metaData } from "@cornerstonejs/core";
import { buildLayoutFromDto, buildSeriesLayout } from "./seriesLayout";
import { imageIdForInstance, type ViewerMode } from "./imageId";
import { getModalityCalibration } from "./pixelCalibration";
import { fetchSeriesLayout, type Instance } from "../api";
import { makeVolume, type RegVolume } from "./regGeometry";
import type { Vec3 } from "./regTransform";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

export interface LoadedRegVolume {
  readonly volume: RegVolume;
  /** DICOM の IOP（行方向 3, 列方向 3）。Worker へ渡すときに要る。 */
  readonly iop: number[];
  /** スライス 1 枚分の移動ベクトル。 */
  readonly sliceStep: Vec3;
  readonly frameOfReferenceUid: string;
  readonly modality: string;
}

/** 読み込み前の見積り。**着手前に予測して確認する**（設計 §7-1）。 */
export interface VolumeEstimate {
  readonly bytes: number;
  readonly dims: [number, number, number];
  /** 空間 Fusion に必要な幾何（IOP/IPP）が揃っているか。 */
  readonly spatial: boolean;
}

/**
 * 読み込まずに大きさだけ見積もる。
 *
 * <p>「黙って進めて OOM で落とさない」ための材料（設計 §7-1）。呼び出し側は
 * fixed と moving の合計にピラミッド分（おおよそ 15%）を足して判断する。
 */
export async function estimateRegVolume(
  mode: ViewerMode,
  studyUid: string,
  seriesUid: string,
  instances: Instance[],
  c = 0,
  t = 0,
): Promise<VolumeEstimate> {
  const dto = await fetchSeriesLayout(studyUid, seriesUid);
  const imageIds = instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid, studyUid, seriesUid));
  const layout = buildLayoutFromDto(dto, mode, studyUid, seriesUid) ?? buildSeriesLayout(imageIds);
  const zStack = layout.zStack(
    Math.min(Math.max(0, c), layout.nC - 1),
    Math.min(Math.max(0, t), layout.nT - 1),
  );
  const cols = dto.imageWidth || 512;
  const rows = dto.imageHeight || 512;
  const nz = zStack.length;
  return {
    bytes: cols * rows * nz * 4,
    dims: [cols, rows, nz],
    spatial: Boolean(dto.imageOrientationPatient && dto.zSpatial?.length),
  };
}

/**
 * シリーズを 1 本の {@link RegVolume} として読み込む。
 *
 * <p>スライスは **法線方向の位置で並べ替える**。ファイル名や InstanceNumber の順を
 * 信じると、逆順・欠番のあるシリーズで z が裏返り、レジストレーションは
 * 「よく合った鏡像」を返す（最も気付きにくい壊れ方）。
 *
 * @returns 幾何（IOP/IPP）が無いシリーズでは `null`。レジストレーションは
 *   実座標が定義できないと成立しない。
 */
export async function loadRegVolume(
  mode: ViewerMode,
  studyUid: string,
  seriesUid: string,
  instances: Instance[],
  c = 0,
  t = 0,
  onProgress?: (loaded: number, total: number) => void,
): Promise<LoadedRegVolume | null> {
  const dto = await fetchSeriesLayout(studyUid, seriesUid);
  if (!dto.imageOrientationPatient || !dto.zSpatial?.length) return null;

  const imageIds = instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid, studyUid, seriesUid));
  const layout = buildLayoutFromDto(dto, mode, studyUid, seriesUid) ?? buildSeriesLayout(imageIds);
  const zStack = layout.zStack(
    Math.min(Math.max(0, c), layout.nC - 1),
    Math.min(Math.max(0, t), layout.nT - 1),
  );
  if (zStack.length === 0) return null;

  const iop = dto.imageOrientationPatient;
  const rc: Vec3 = [iop[0], iop[1], iop[2]];
  const rr: Vec3 = [iop[3], iop[4], iop[5]];
  const normal: Vec3 = [
    rc[1] * rr[2] - rc[2] * rr[1],
    rc[2] * rr[0] - rc[0] * rr[2],
    rc[0] * rr[1] - rc[1] * rr[0],
  ];

  type Loaded = { ipp: Vec3; pixels: Float32Array; w: number };
  const loaded: Loaded[] = [];
  let modality = "";

  for (let i = 0; i < zStack.length; i++) {
    const imageId = zStack[i];
    if (!imageId) continue;
    let image;
    try {
      image = await imageLoader.loadAndCacheImage(imageId);
    } catch {
      continue;
    }
    const plane: AnyObj = metaData.get("imagePlaneModule", imageId) ?? {};
    const ippArr = plane.imagePositionPatient;
    if (!Array.isArray(ippArr) || ippArr.length < 3) continue;
    if (!modality) {
      const general: AnyObj = metaData.get("generalSeriesModule", imageId) ?? {};
      modality = String(general.modality ?? "");
    }

    const img = image as AnyObj;
    const cols = (img.columns as number | undefined) ?? (img.width as number | undefined) ?? 0;
    const rows = (img.rows as number | undefined) ?? (img.height as number | undefined) ?? 0;
    const raw = img.getPixelData() as ArrayLike<number>;
    if (!cols || !rows || raw.length < cols * rows) continue; // カラー等は非対応

    const cal = getModalityCalibration(image, imageId);
    const pixels = new Float32Array(cols * rows);
    for (let n = 0; n < pixels.length; n++) pixels[n] = raw[n] * cal.scale + cal.offset;

    const ipp: Vec3 = [Number(ippArr[0]), Number(ippArr[1]), Number(ippArr[2])];
    loaded.push({
      ipp,
      pixels,
      w: ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2],
    });
    onProgress?.(loaded.length, zStack.length);
  }
  if (loaded.length === 0) return null;

  loaded.sort((a, b) => a.w - b.w);

  const cols = dto.imageWidth || 512;
  const rows = dto.imageHeight || 512;
  const data = new Float32Array(cols * rows * loaded.length);
  loaded.forEach((s, k) => data.set(s.pixels, k * cols * rows));

  const sliceStep: Vec3 = loaded.length > 1
    ? [loaded[1].ipp[0] - loaded[0].ipp[0], loaded[1].ipp[1] - loaded[0].ipp[1], loaded[1].ipp[2] - loaded[0].ipp[2]]
    : normal;

  const firstId = zStack.find(Boolean);
  const frameOfReferenceUid = firstId
    ? String((metaData.get("frameOfReferenceModule", firstId) as AnyObj)?.frameOfReferenceUID ?? "")
    : "";

  return {
    volume: makeVolume(
      data,
      [cols, rows, loaded.length],
      iop,
      loaded[0].ipp,
      dto.pixelSpacingCol || 1,
      dto.pixelSpacingRow || 1,
      sliceStep,
    ),
    iop: Array.from(iop),
    sliceStep,
    frameOfReferenceUid,
    modality,
  };
}
