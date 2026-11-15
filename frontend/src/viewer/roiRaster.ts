/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ベクタ ROI（画素座標の頂点）→ 前景ラスタ（cols*rows の 0/1）。純関数。
 *
 * <p>**ROI 統計と同じ図形・同じ規則**で塗る: `roiStats.buildRoiMesh` が作る閉多角形を、画素中心（x+0.5, y+0.5）の
 * 偶奇判定（`maskContour.fillPolygonsEvenOdd`。統計の `sampleInsideMesh` と同じ）で塗る。
 * 以前は矩形を外接 bbox の全画素で塗っていたため、統計の面積より大きいマスクができていた（回転表示の楕円も崩れた）。
 * 円は厳密な楕円判定（`rasterizeCircleFg`）。
 *
 * @param tool   Cornerstone のツール名
 * @param ptsPx  頂点（画素座標。左上隅が 0）。円は [中心, 縁]、楕円は [下, 上, 左, 右]、矩形は 4 隅
 * @param closed 輪郭が閉じているか（`contour.closed`。輪郭系以外は undefined）
 * @param basis  world ↔ 画素の換算に使う間隔 [mm/画素]（円の形に使う。`imageCoords.worldSpacingOf`）
 * @returns 前景。面積を持たない ROI・頂点が足りない場合は null
 */
import { buildRoiMesh, pickSampleKind } from "./roiStats";
import { fillPolygonsEvenOdd } from "./maskContour";
import { rasterizeCircleFg } from "./roiCircleRaster";
import type { PointPx } from "./roiRead";

export function rasterizeRoiPx(
  tool: string,
  ptsPx: ReadonlyArray<PointPx>,
  closed: boolean | undefined,
  cols: number,
  rows: number,
  basis?: { col: number; row: number },
): Uint8Array | null {
  if (!ptsPx.length) return null;
  const t = (tool ?? "").trim().toLowerCase();
  if (pickSampleKind(t, closed) !== "area") return null;
  if (t === "circleroi" && ptsPx.length >= 2) {
    return rasterizeCircleFg(ptsPx[0], ptsPx[1], cols, rows, basis);
  }
  const mesh = buildRoiMesh(tool, ptsPx, closed, undefined, basis);
  if (!mesh || !mesh.closed || mesh.pointsPx.length < 3) return null;
  return fillPolygonsEvenOdd([mesh.pointsPx as Array<[number, number]>], cols, rows);
}
