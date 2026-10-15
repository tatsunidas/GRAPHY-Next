/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 統計に使った画素の書き出し（画素ダンプ）。純関数（`fw/roi-stats-design.md` §6.2）。
 *
 * <ul>
 *   <li>母集団は統計と同じ。面型は {@link sampleInsideMeshIndices}、点型は統計と同じ {@link nearestIndex}。</li>
 *   <li>座標は患者 LPS mm（画素中心 col+0.5, row+0.5 を {@link imageToWorldOnPlane} で変換）。
 *       幾何（IPP/IOP）が無いときは x/y/z を<b>空セル</b>にする（0 で埋めない）。</li>
 *   <li>非有限値の画素は行を残して値セルを空にする（行数＝統計の sampleCount）。</li>
 *   <li>線 ROI（双一次補間・画素ではない）と非対応ツールは対象外で `null`。</li>
 * </ul>
 */
import { imageToWorldOnPlane, type PlaneGeometry } from "./imageCoords";
import {
  nearestIndex,
  sampleInsideMeshIndices,
  type RoiMesh,
  type RoiSampleKind,
} from "./roiStats";
import { cell } from "./roiStatsCsv";

export interface RoiPixelDumpRow {
  col: number;
  row: number;
  /** 患者 LPS mm。幾何が無い・非有限なら `undefined`（空セル）。 */
  x?: number;
  y?: number;
  z?: number;
  /** 校正後の値。非有限なら `undefined`（空セル）。 */
  value?: number;
}

export interface RoiPixelDumpInput {
  kind: RoiSampleKind;
  mesh: RoiMesh;
  slice: { values: ArrayLike<number>; width: number; height: number };
  /** 幾何が無ければ null。 */
  plane: PlaneGeometry | null;
}

export interface RoiPixelDumpMeta {
  label: string;
  roiUid: string;
  imageId: string;
  unit: string;
}

export function buildRoiPixelDump(input: RoiPixelDumpInput): RoiPixelDumpRow[] | null {
  const { kind, mesh, slice, plane } = input;
  const { width, height, values } = slice;
  let flat: number[];
  if (kind === "area") {
    flat = Array.from(sampleInsideMeshIndices(mesh, values, width, height));
  } else if (kind === "point") {
    const p = mesh.pointsPx[0];
    const idx = p ? nearestIndex(p[0], p[1], width, height) : null;
    flat = idx ? [idx[1] * width + idx[0]] : [];
  } else {
    return null;
  }
  return flat.map((i) => {
    const row = Math.floor(i / width);
    const col = i - row * width;
    const out: RoiPixelDumpRow = { col, row };
    const v = values[i];
    if (Number.isFinite(v)) out.value = v;
    if (plane) {
      const w = imageToWorldOnPlane(plane, [col + 0.5, row + 0.5]);
      if (w.every(Number.isFinite)) [out.x, out.y, out.z] = w;
    }
    return out;
  });
}

const n = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? "" : String(v));

/** CSV 本文（BOM 無し・CRLF）。単位は列名に入れる。 */
export function roiPixelDumpToCsv(rows: ReadonlyArray<RoiPixelDumpRow>, meta: RoiPixelDumpMeta): string {
  const header = [
    "label",
    "roiUid",
    "col",
    "row",
    "x[mm]",
    "y[mm]",
    "z[mm]",
    meta.unit ? `value[${meta.unit}]` : "value",
    "imageId",
  ];
  const lines = [header.map(cell).join(",")];
  for (const r of rows) {
    lines.push(
      [meta.label, meta.roiUid, r.col, r.row, n(r.x), n(r.y), n(r.z), n(r.value), meta.imageId]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/** ダウンロード用（Excel が UTF-8 を化けさせないよう BOM を付ける）。 */
export function roiPixelDumpBlobText(rows: ReadonlyArray<RoiPixelDumpRow>, meta: RoiPixelDumpMeta): string {
  return `﻿${roiPixelDumpToCsv(rows, meta)}\r\n`;
}
