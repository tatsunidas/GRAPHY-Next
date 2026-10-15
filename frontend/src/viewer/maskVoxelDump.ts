/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * マスク（3D ROI）の統計に使ったボクセルの書き出し。純関数（`fw/roi-stats-design.md` §6.3）。
 *
 * <ul>
 *   <li>母集団は統計と同じ（label &gt; 0 の前景）。1 枚の表にし、スライス順・画素順に並べる。</li>
 *   <li>{@code slice} はビューアのスライス番号と同じ 1 始まり。col/row は 2D の画素 CSV と同じ 0 始まり。</li>
 *   <li>座標・値の空セルの決め方は 2D の {@link ./roiPixelDump} と同じ（0 で埋めない・行は残す）。</li>
 *   <li>数十万行になり得るので、行オブジェクトを溜めずに CSV の塊（文字列の配列）で返す。</li>
 * </ul>
 */
import { imageToWorldOnPlane, type PlaneGeometry } from "./imageCoords";
import { cell } from "./roiStatsCsv";
import { isSegmentForeground } from "./maskStatsCore";

export interface MaskDumpSlice {
  /** スタック内の位置（0 始まり）。CSV には +1 して出す。 */
  sliceIndex: number;
  imageId: string;
  width: number;
  /** segment 番号（0 = 背景）。 */
  labels: ArrayLike<number>;
  /** 校正済みの値。読めなければ null（値セルを空にする）。 */
  values: ArrayLike<number> | null;
  /** 幾何が無ければ null（座標セルを空にする）。 */
  plane: PlaneGeometry | null;
}

export interface MaskVoxelRow {
  slice: number;
  segment: number;
  col: number;
  row: number;
  x?: number;
  y?: number;
  z?: number;
  value?: number;
  imageId: string;
}

export interface MaskVoxelDumpMeta {
  label: string;
  maskId: string;
  unit: string;
  /** 指定すると、その segment のボクセルだけを出す（ROI 1 件ぶん）。 */
  segmentIndex?: number;
}

/** 前景ボクセルをスライス順・画素順に 1 行ずつ返す。 */
export function* iterateMaskVoxels(
  slices: ReadonlyArray<MaskDumpSlice>,
  segmentIndex?: number,
): Generator<MaskVoxelRow> {
  const ordered = [...slices].sort((a, b) => a.sliceIndex - b.sliceIndex);
  for (const s of ordered) {
    const { labels, values, plane, width } = s;
    for (let i = 0; i < labels.length; i++) {
      const seg = labels[i];
      if (!isSegmentForeground(seg, segmentIndex)) continue;
      const row = Math.floor(i / width);
      const col = i - row * width;
      const out: MaskVoxelRow = { slice: s.sliceIndex + 1, segment: seg, col, row, imageId: s.imageId };
      const v = values && i < values.length ? values[i] : undefined;
      if (v !== undefined && Number.isFinite(v)) out.value = v;
      if (plane) {
        const w = imageToWorldOnPlane(plane, [col + 0.5, row + 0.5]);
        if (w.every(Number.isFinite)) [out.x, out.y, out.z] = w;
      }
      yield out;
    }
  }
}

const n = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? "" : String(v));

export function maskVoxelDumpHeader(unit: string): string[] {
  return [
    "label",
    "maskId",
    "slice",
    "segment",
    "col",
    "row",
    "x[mm]",
    "y[mm]",
    "z[mm]",
    unit ? `value[${unit}]` : "value",
    "imageId",
  ];
}

/**
 * ダウンロード用の CSV（BOM 付き・CRLF）を塊の配列で返す。`new Blob(chunks)` にそのまま渡す。
 * 1 本の文字列に連結しないこと（大きいマスクで文字列長の上限に当たる）。
 */
export function maskVoxelDumpCsvChunks(
  slices: ReadonlyArray<MaskDumpSlice>,
  meta: MaskVoxelDumpMeta,
  linesPerChunk = 10000,
): string[] {
  const chunks: string[] = [];
  const label = cell(meta.label);
  const maskId = cell(meta.maskId);
  let buf: string[] = [maskVoxelDumpHeader(meta.unit).map(cell).join(",")];
  for (const r of iterateMaskVoxels(slices, meta.segmentIndex)) {
    buf.push(
      [label, maskId, r.slice, r.segment, r.col, r.row, n(r.x), n(r.y), n(r.z), n(r.value), cell(r.imageId)].join(","),
    );
    if (buf.length >= linesPerChunk) {
      chunks.push(buf.join("\r\n") + "\r\n");
      buf = [];
    }
  }
  if (buf.length) chunks.push(buf.join("\r\n") + "\r\n");
  chunks[0] = `﻿${chunks[0]}`;
  return chunks;
}
