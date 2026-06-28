import { type SeriesLayoutDto } from "../api";

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
  imageIdBySop: Map<string, string>,
): SeriesLayout | null {
  if (!dto || dto.nZ <= 0 || dto.nC <= 0 || dto.nT <= 0 || !dto.cells?.length) {
    return null;
  }
  // grid[c][t][z] = imageId
  const grid: (string | undefined)[][][] = Array.from({ length: dto.nC }, () =>
    Array.from({ length: dto.nT }, () => new Array<string | undefined>(dto.nZ)),
  );
  for (const cell of dto.cells) {
    const id = imageIdBySop.get(cell.sopInstanceUid);
    if (id && grid[cell.c]?.[cell.t] && cell.z >= 0 && cell.z < dto.nZ) {
      grid[cell.c][cell.t][cell.z] = id;
    }
  }
  return {
    nZ: dto.nZ,
    nC: dto.nC,
    nT: dto.nT,
    cDimension: dto.cDimension,
    tDimension: dto.tDimension,
    zStack: (c, t) => (grid[c]?.[t] ?? []).filter((x): x is string => !!x),
  };
}
