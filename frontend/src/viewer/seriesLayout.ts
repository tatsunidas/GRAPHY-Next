/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { type SeriesLayoutDto } from "../api";
import { imageIdForCell, imageIdForBlank, type ViewerMode } from "./imageId";

/**
 * シリーズの 5 次元（x,y は画像内）＝ Z(スライス) × C(チャンネル) × T(時間/フレーム) 構造。
 * GRAPHY Praparat の ZCT インデックスモデルに対応。
 */
export interface SeriesLayout {
  nZ: number;
  nC: number;
  nT: number;
  /** C 次元の DICOM 由来（"Echo"/"Bvalue" 等。単一次元なら null）。UI 併記用。 */
  cDimension?: string | null;
  /** T 次元の DICOM 由来（"Temporal"/"Trigger" 等。単一次元なら null）。 */
  tDimension?: string | null;
  /** 指定 (c, t) に対する Z スタック（imageId 配列, z 昇順）。 */
  zStack(c: number, t: number): string[];
}

/** 単一次元フォールバック（nC=nT=1, nZ=スライス数）。backend 未取得時に使用。 */
export function buildSeriesLayout(imageIds: string[]): SeriesLayout {
  return {
    nZ: Math.max(1, imageIds.length),
    nC: 1,
    nT: 1,
    zStack: () => imageIds,
  };
}

/**
 * backend の ZCT レイアウト DTO（IPP→Z / Temporal→T / Echo・Bvalue→C で導出済み）から構築する。
 * 取得不可・空・不整合なら null（呼び出し側は単一次元フォールバック）。
 */
export function buildLayoutFromDto(
  dto: SeriesLayoutDto | null | undefined,
  mode: ViewerMode,
  studyUid: string,
  seriesUid: string,
): SeriesLayout | null {
  if (!dto || dto.nZ <= 0 || dto.nC <= 0 || dto.nT <= 0 || !dto.cells?.length) {
    return null;
  }
  // grid[c][t][z] = imageId
  const grid: (string | undefined)[][][] = Array.from({ length: dto.nC }, () =>
    Array.from({ length: dto.nT }, () => new Array<string | undefined>(dto.nZ)),
  );
  for (const cell of dto.cells) {
    // モザイクは frame>=0 → タイル imageId、非モザイクは whole-image imageId。
    const id = imageIdForCell(mode, cell.sopInstanceUid, cell.frame);
    if (id && grid[cell.c]?.[cell.t] && cell.z >= 0 && cell.z < dto.nZ) {
      grid[cell.c][cell.t][cell.z] = id;
    }
  }
  // 欠損(gap)位置の物理座標（IPP）を z→IPP で引けるようにする（ブランクに正しい位置を持たせる）。
  const ippByZ = new Map<number, [number, number, number]>();
  if (dto.zSpatial) {
    for (const zs of dto.zSpatial) ippByZ.set(zs.z, zs.imagePositionPatient);
  }
  return {
    nZ: dto.nZ,
    nC: dto.nC,
    nT: dto.nT,
    cDimension: dto.cDimension,
    tDimension: dto.tDimension,
    // 欠損(gap)を filter で詰めず、シリーズ最小値ブランク（backend 生成・属性/UID 付き）で埋めて
    // nZ 長を維持する。これにより「同じ Z インデックス = 同じ物理断面」が C/T 間で保たれ、
    // 範囲外は近傍画像での代用ではなくブランクが表示される。
    zStack: (c, t) => {
      const arr = grid[c]?.[t] ?? [];
      const out: string[] = new Array(dto.nZ);
      for (let z = 0; z < dto.nZ; z++) {
        out[z] = arr[z] ?? imageIdForBlank(studyUid, seriesUid, ippByZ.get(z));
      }
      return out;
    },
  };
}
