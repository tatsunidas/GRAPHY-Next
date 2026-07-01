/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シリーズの Z 並べ替え（GRAPHY Praparat の SeriesSortMode 相当）。
 *
 * <p>並べ替えは **Z 次元のみ**を対象にし、各 Z 断面が持つ C(チャンネル)/T(時間) の割当は保持する
 * （ZCT インデックスモデルを崩さない）。`SeriesLayout.zStack(c,t)` が返す Z 配列に、Z の並び替え
 * 置換を全 (c,t) 一律に適用する。
 *
 * <p>対応モード:
 * - InstanceNumber 昇順/降順（各 Z 断面の代表 = 最小 InstanceNumber で整列）
 * - ImagePositionPatient（IPP）昇順/降順（スライス法線への投影量で整列）
 *
 * <p>IPP が無いシリーズでは IPP 並べ替えは不可。動画(ビデオ)IOD は呼び出し側でブロックする。
 */
import { type SeriesLayoutDto, type Instance } from "../api";
import { type SeriesLayout } from "./seriesLayout";

export type SortMode = "instanceAsc" | "instanceDesc" | "ippAsc" | "ippDesc";

/** 並べ替えに必要な Z ごとのメタ（InstanceNumber・IPP 法線投影）。 */
export interface SortMeta {
  nZ: number;
  /** 各 Z の代表 InstanceNumber（その Z の C/T セル中の最小）。無ければ null。 */
  instByZ: (number | null)[];
  /** 各 Z の IPP をスライス法線へ投影した値[mm]。IPP/法線が無ければ null。 */
  projByZ: (number | null)[];
  /** IPP による並べ替えが可能か（いずれかの Z に投影値あり）。 */
  hasSpatial: boolean;
  /** InstanceNumber による並べ替えが可能か。 */
  hasInstance: boolean;
}

export function isIppMode(mode: SortMode): boolean {
  return mode === "ippAsc" || mode === "ippDesc";
}

/** レイアウト DTO＋インスタンス（sop→InstanceNumber）＋法線から SortMeta を構築する。 */
export function buildSortMeta(
  dto: SeriesLayoutDto,
  instances: Instance[],
  normal: [number, number, number] | null,
): SortMeta {
  const nZ = Math.max(0, dto.nZ);

  // sop → InstanceNumber。
  const instBySop = new Map<string, number>();
  for (const i of instances) {
    if (i.instanceNumber != null) instBySop.set(i.sopInstanceUid, i.instanceNumber);
  }
  // 各 Z の最小 InstanceNumber（C/T セルを跨いで代表値）。
  const minInst = new Array<number>(nZ).fill(Number.POSITIVE_INFINITY);
  for (const cell of dto.cells) {
    if (cell.z < 0 || cell.z >= nZ) continue;
    const inst = instBySop.get(cell.sopInstanceUid);
    if (inst != null && inst < minInst[cell.z]) minInst[cell.z] = inst;
  }
  const instByZ: (number | null)[] = minInst.map((v) => (Number.isFinite(v) ? v : null));

  // 各 Z の IPP を法線へ投影（= テーブル位置 mm）。
  const ippByZ = new Map<number, [number, number, number]>();
  if (dto.zSpatial) {
    for (const zs of dto.zSpatial) ippByZ.set(zs.z, zs.imagePositionPatient);
  }
  const projByZ: (number | null)[] = new Array(nZ).fill(null);
  if (normal) {
    for (let z = 0; z < nZ; z++) {
      const ipp = ippByZ.get(z);
      projByZ[z] = ipp ? ipp[0] * normal[0] + ipp[1] * normal[1] + ipp[2] * normal[2] : null;
    }
  }

  return {
    nZ,
    instByZ,
    projByZ,
    hasSpatial: projByZ.some((v) => v != null),
    hasInstance: instByZ.some((v) => v != null),
  };
}

/**
 * 指定モードの Z 表示順を返す。`order[displayZ] = originalZ`。
 * 昇順は「値の小さい順・null は末尾」、降順はその反転（GRAPHY の Collections.reverse 準拠）。
 */
export function computeZOrder(meta: SortMeta, mode: SortMode): number[] {
  const key = isIppMode(mode) ? meta.projByZ : meta.instByZ;
  const asc = Array.from({ length: meta.nZ }, (_, z) => z).sort((a, b) => {
    const ka = key[a];
    const kb = key[b];
    if (ka == null && kb == null) return a - b;
    if (ka == null) return 1; // null は末尾
    if (kb == null) return -1;
    if (ka === kb) return a - b; // 安定
    return ka - kb;
  });
  const desc = mode === "instanceDesc" || mode === "ippDesc";
  return desc ? asc.reverse() : asc;
}

/**
 * Z 並べ替え置換を適用した新しい SeriesLayout を返す（nZ/nC/nT・次元名・法線は不変）。
 * zStack は全 (c,t) に同一置換を適用し、ippAt も置換後の Z へ対応させる。
 */
export function applySortToLayout(layout: SeriesLayout, order: number[]): SeriesLayout {
  const baseIpp = layout.ippAt;
  return {
    ...layout,
    zStack: (c, t) => {
      const base = layout.zStack(c, t);
      return order.map((oz) => base[oz]);
    },
    ippAt: baseIpp ? (z) => baseIpp(order[z] ?? z) : baseIpp,
  };
}
