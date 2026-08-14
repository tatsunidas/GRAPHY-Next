/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { type SeriesAxisDto, type SeriesLayoutDto } from "../api";
import { imageIdForCell, imageIdForBlank, imageIdForXaFrame, type ViewerMode } from "./imageId";

/** 軸の種別。UI は空間スライス軸前提の機能（ThickSlab/Sync/参照線/Grid）の可否をこれで決める。 */
export type AxisKind = SeriesAxisDto["kind"];

/** 1 つの軸の提示（`fw/angio-design.md` §5.7）。 */
export interface AxisSpec {
  /** UI ラベル（"Z" / "Run" / "Frame"）。 */
  label: string;
  kind: AxisKind;
  /** DICOM 由来の副題（"Echo"/"Temporal" 等。ラベルの後ろに括弧書きで出す）。 */
  dim?: string | null;
}

/** 既定の軸提示（CT/MR の従来動作）。 */
export const DEFAULT_AXES: { z: AxisSpec; c: AxisSpec; t: AxisSpec } = {
  z: { label: "Z", kind: "slice" },
  c: { label: "C", kind: "generic" },
  t: { label: "T", kind: "temporal" },
};

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
  /**
   * 軸の提示（ラベル・種別）。省略時は {@link DEFAULT_AXES}。
   * UI 側に「XA なら…」の分岐を撒かないための仕組み（`fw/angio-design.md` §5.7）。
   */
  axes?: { z: AxisSpec; c: AxisSpec; t: AxisSpec };
  /**
   * 画像スタック（= Cornerstone StackViewport の imageIds ＝ホイール送り／Grid ／プリフェッチの単位）を
   * どの軸に割り当てるか。既定 `"z"`。XA シネは `"t"`（フレーム送りのたびに setStack が走るのを防ぐ）。
   */
  stackAxis?: "z" | "t";
  /** 指定 (z, c) に対する T スタック（imageId 配列, t 昇順）。`stackAxis="t"` のとき使う。 */
  tStack?(z: number, c: number): string[];
  /** 指定 Z の物理座標 IPP（無ければ null）。シリーズ Sync の座標同期に使う。 */
  ippAt?(z: number): [number, number, number] | null;
  /** スライス法線（IOP 外積・正規化）。座標同期で IPP をテーブル位置(mm)へ投影するのに使う。 */
  normal?: [number, number, number] | null;
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
  // XA シネ（stackAxis="t"）の frame は「同一ファイル内のフレーム番号」なので、サーバ切り出しではなく
  // **ローダ内フレーム指定**の imageId を組む（Part-10 の取得を 1 回で済ませる。fw/angio-design.md §5.3）。
  const xaCine = dto.axes?.stackAxis === "t";
  for (const cell of dto.cells) {
    // モザイクは frame>=0 → タイル imageId、非モザイクは whole-image imageId。
    // web は WADO-RS が study/series/sop を要するため study/series を渡す。
    const id =
      xaCine && cell.frame !== undefined && cell.frame >= 0
        ? imageIdForXaFrame(mode, cell.sopInstanceUid, cell.frame, studyUid, seriesUid)
        : imageIdForCell(mode, cell.sopInstanceUid, cell.frame, studyUid, seriesUid);
    if (id && grid[cell.c]?.[cell.t] && cell.z >= 0 && cell.z < dto.nZ) {
      grid[cell.c][cell.t][cell.z] = id;
    }
  }
  // 欠損(gap)位置の物理座標（IPP）を z→IPP で引けるようにする（ブランクに正しい位置を持たせる）。
  const ippByZ = new Map<number, [number, number, number]>();
  if (dto.zSpatial) {
    for (const zs of dto.zSpatial) ippByZ.set(zs.z, zs.imagePositionPatient);
  }
  // スライス法線 = row×col（IOP 前半3×後半3）。座標同期の投影に使う。
  let normal: [number, number, number] | null = null;
  const iop = dto.imageOrientationPatient;
  if (iop && iop.length >= 6) {
    const nx = iop[1] * iop[5] - iop[2] * iop[4];
    const ny = iop[2] * iop[3] - iop[0] * iop[5];
    const nz = iop[0] * iop[4] - iop[1] * iop[3];
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) normal = [nx / len, ny / len, nz / len];
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
    // T 方向のスタック（stackAxis="t" のときの表示スタック）。
    // ブランク埋めはしない — XA は欠損を最終フレーム保持で backend が既に埋めており、
    // ここでブランクを挟むと再生中に黒画面が点滅する。
    tStack: (z, c) => {
      const out: string[] = [];
      for (let t = 0; t < dto.nT; t++) {
        const id = grid[c]?.[t]?.[z];
        if (id) out.push(id);
      }
      return out;
    },
    axes: axesFromDto(dto),
    stackAxis: dto.axes?.stackAxis === "t" ? "t" : "z",
    ippAt: (z) => ippByZ.get(z) ?? null,
    normal,
  };
}

/**
 * DTO の軸提示を UI 用 {@link AxisSpec} へ。未指定なら既定（Z/C/T）＝ CT/MR の従来動作。
 * DICOM 由来の副題（cDimension/tDimension）は既定・上書きのどちらでも維持する。
 */
function axesFromDto(dto: SeriesLayoutDto): { z: AxisSpec; c: AxisSpec; t: AxisSpec } {
  const a = dto.axes;
  return {
    z: a?.z ? { ...a.z } : { ...DEFAULT_AXES.z },
    c: { ...(a?.c ?? DEFAULT_AXES.c), dim: dto.cDimension },
    t: { ...(a?.t ?? DEFAULT_AXES.t), dim: dto.tDimension },
  };
}
