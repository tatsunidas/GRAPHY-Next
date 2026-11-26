/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **H80・H81 — セグメンテーション（ラベルマップ）のマスクを、プラグインへ読み出す。**
 *
 * Wand（2D・3D）・ブラシ・スキャッシュ等が書くのは cornerstone のセグメンテーション（ラベルマップ）で、
 * 注釈（ROI）ではない。H5 の `getRois` は注釈しか返さないので、マスクは見えなかった。
 *
 * <h3>設計</h3>
 * - ラベルマップの imageId 群は**ソースのスタックと 1 対 1・同じ順序**（`createAndCacheDerivedLabelmapImages`）。
 *   返す座標は**タイルのスタック順の `sliceIndex`**で、`getRois`・`getPixelData(tileId, {sliceIndex})` と同じ。
 *   H10 の格子（法線方向の昇順・等間隔限定）へは変換しない（NM は逆順・等間隔でないシリーズは H10 が断る、
 *   という既知の食い違いを本体側で抱えない。プラグインは既存の添字変換を使える）。
 * - **疎**: 前景のあるスライスだけを返す。
 * - **コピー**を返す（labelmap の内部バッファをプラグインが書き換えられない）。
 * - 見つからない・別スタック・存在しない segment は `null`（空の成功を装わない）。上限超過だけは**理由つきの例外**。
 *
 * ビューアの cornerstone に直接触る部分は {@link SegmentAccess} に押し出してあり、ここは純関数
 * （模擬の labelmap でテストできる）。
 */

/** 返すマスクの合計バイトの上限（cols×rows×前景のあるスライス数）。既存に根拠となる値は無く、ここで決めた値。 */
export const MAX_SEGMENT_MASK_BYTES = 256 * 1024 * 1024;

export interface PluginSegment {
  /** ラベルマップの id。`loadSegmentMask` に渡す。 */
  segmentationId: string;
  /** セグメント番号（1 以上。0 は背景）。 */
  segmentIndex: number;
  /** ROI マネージャのマスクの名前。付いていなければ null（名前を作らない）。 */
  label: string | null;
  /** セグメントの名前。付いていなければ null。 */
  segmentLabel: string | null;
}

export interface PluginSegmentSlice {
  /** タイルのスタック上のスライス番号（`getRois` の `sliceIndex` と同じ）。 */
  sliceIndex: number;
  /** そのスライスの SOP インスタンス UID（引けなければ null）。 */
  sopInstanceUid: string | null;
  /** cols×rows の 0/1。行優先（1 行目の左端が添字 0）。 */
  data: Uint8Array;
}

export interface PluginSegmentMask {
  cols: number;
  rows: number;
  /** 前景のボクセルの総数。 */
  voxelCount: number;
  /** 前景のあるスライスだけ（`sliceIndex` の昇順）。 */
  slices: PluginSegmentSlice[];
}

/** cornerstone への薄い窓口。テストでは模擬を渡す。 */
export interface SegmentAccess {
  segmentationIds(): string[];
  /** ラベルマップの imageId 群（スタックと同じ順序）。無ければ undefined。 */
  labelmapImageIds(segmentationId: string): string[] | undefined;
  /** ラベルマップ 1 枚が参照するソースの imageId。 */
  referencedImageId(labelmapImageId: string): string | undefined;
  /** ラベルマップ 1 枚の画素（frameSize 個の整数）。取れなければ null。 */
  plane(labelmapImageId: string, frameSize: number): ArrayLike<number> | null;
  /** ソースの画像の列数・行数。 */
  planeSize(sourceImageId: string): { cols: number; rows: number } | null;
  sopOf(sourceImageId: string): string | null;
  /** マスクに登録されたセグメント番号。 */
  segmentsOf(segmentationId: string): number[];
  /** ROI マネージャのメタ。 */
  metaOf(segmentationId: string): { label?: string; segmentLabels?: Record<string, string> } | undefined;
}

/** ラベルマップがこのスタックのものか（長さが同じで、全スライスの参照先がスタックの同じ位置）。 */
function belongsToStack(access: SegmentAccess, segmentationId: string, stack: readonly string[]): string[] | null {
  const lm = access.labelmapImageIds(segmentationId);
  if (!lm || lm.length !== stack.length || lm.length === 0) return null;
  for (let z = 0; z < lm.length; z++) if (access.referencedImageId(lm[z]) !== stack[z]) return null;
  return lm;
}

/** このスタックに乗っているセグメントの一覧（H80）。 */
export function listSegmentsForStack(access: SegmentAccess, stack: readonly string[]): PluginSegment[] {
  const out: PluginSegment[] = [];
  if (stack.length === 0) return out;
  for (const id of access.segmentationIds()) {
    if (!belongsToStack(access, id, stack)) continue;
    const meta = access.metaOf(id);
    for (const idx of access.segmentsOf(id)) {
      out.push({
        segmentationId: id,
        segmentIndex: idx,
        label: meta?.label?.trim() ? meta.label : null,
        segmentLabel: meta?.segmentLabels?.[String(idx)]?.trim() ? meta.segmentLabels![String(idx)] : null,
      });
    }
  }
  return out;
}

/**
 * 1 セグメントのマスクを読む（H81）。
 *
 * @returns 見つからない・別スタック・登録に無い segment・前景が 1 つも無い、は null
 * @throws 返す大きさが {@link MAX_SEGMENT_MASK_BYTES} を超えるとき（理由つき）
 */
export function readSegmentMask(
  access: SegmentAccess,
  stack: readonly string[],
  segmentationId: string,
  segmentIndex: number,
  maxBytes: number = MAX_SEGMENT_MASK_BYTES,
): PluginSegmentMask | null {
  if (!Number.isInteger(segmentIndex) || segmentIndex < 1) return null;
  const lm = belongsToStack(access, segmentationId, stack);
  if (!lm) return null;
  if (!access.segmentsOf(segmentationId).includes(segmentIndex)) return null;
  const size = access.planeSize(stack[0]);
  if (!size || size.cols < 1 || size.rows < 1) return null;
  const frame = size.cols * size.rows;

  const slices: PluginSegmentSlice[] = [];
  let voxelCount = 0;
  for (let z = 0; z < lm.length; z++) {
    const plane = access.plane(lm[z], frame);
    if (!plane || plane.length < frame) continue;
    let any = false;
    for (let i = 0; i < frame; i++) {
      if (plane[i] === segmentIndex) { any = true; break; }
    }
    if (!any) continue;
    if ((slices.length + 1) * frame > maxBytes) {
      throw new Error(
        `segment mask too large: more than ${maxBytes} bytes (${size.cols}x${size.rows} per slice). ` +
          `Reduce the region or read it in a smaller series.`,
      );
    }
    const data = new Uint8Array(frame); // コピー（labelmap の内部バッファを渡さない）
    for (let i = 0; i < frame; i++) {
      if (plane[i] === segmentIndex) { data[i] = 1; voxelCount++; }
    }
    slices.push({ sliceIndex: z, sopInstanceUid: access.sopOf(stack[z]), data });
  }
  if (slices.length === 0) return null;
  return { cols: size.cols, rows: size.rows, voxelCount, slices };
}
