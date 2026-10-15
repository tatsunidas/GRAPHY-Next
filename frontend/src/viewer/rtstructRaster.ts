/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * RTSTRUCT の 1 構造（輪郭群）を、スライスごとの塗りつぶしに直す純関数。
 *
 * 穴は別の閉輪郭として入っている（本アプリの書き出しも同じ）。そのため輪郭ごとに塗って足し合わせる
 * （OR）と穴が埋まってしまう。同じスライスの閉輪郭をまとめて画素中心の偶奇判定で塗り、穴を穴のまま戻す。
 */
import type { RtStructImportContour } from "../api";
import { fillPolygonsEvenOdd, type Pt } from "./maskContour";

export interface StructureRaster {
  /** スライス番号 → 前景（cols*rows）。 */
  slices: Map<number, Uint8Array>;
  /** 閉輪郭ではない（OPEN_PLANAR / POINT など）ため塗らなかった輪郭数。 */
  skippedNotClosed: number;
  /** 参照 SOP が表示中スタックに無く、置き場が決まらなかった輪郭数。 */
  skippedNoSlice: number;
}

/**
 * @param sopToZ  参照 SOPInstanceUID → 表示中スタックのスライス番号
 * @param toImage スライス z の画像で、world(mm) → 画素座標（左上隅が原点、画素 (c,r) は [c,c+1]×[r,r+1]）
 */
export function rasterizeStructure(
  contours: ReadonlyArray<RtStructImportContour>,
  sopToZ: ReadonlyMap<string, number>,
  toImage: (z: number, world: [number, number, number]) => Pt,
  cols: number,
  rows: number,
): StructureRaster {
  const polysByZ = new Map<number, Pt[][]>();
  let skippedNotClosed = 0;
  let skippedNoSlice = 0;
  for (const c of contours) {
    if ((c.geometricType || "CLOSED_PLANAR") !== "CLOSED_PLANAR" || !c.points || c.points.length < 9) {
      skippedNotClosed++;
      continue;
    }
    const z = c.referencedSopInstanceUid ? sopToZ.get(c.referencedSopInstanceUid) : undefined;
    if (z === undefined) {
      skippedNoSlice++;
      continue;
    }
    const poly: Pt[] = [];
    for (let i = 0; i + 2 < c.points.length; i += 3) poly.push(toImage(z, [c.points[i], c.points[i + 1], c.points[i + 2]]));
    const list = polysByZ.get(z) ?? [];
    list.push(poly);
    polysByZ.set(z, list);
  }
  const slices = new Map<number, Uint8Array>();
  for (const [z, polys] of polysByZ) {
    const fg = fillPolygonsEvenOdd(polys, cols, rows);
    if (fg.some((v) => v)) slices.set(z, fg);
  }
  return { slices, skippedNotClosed, skippedNoSlice };
}
