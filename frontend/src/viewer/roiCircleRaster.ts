/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 円 ROI の前景ラスタ（画素座標）。純関数。
 *
 * <p>Cornerstone の円は world（mm）空間の円。画素間隔が非正方だと画素空間では楕円なので、半径は world で測り
 * （`hypot(Δx·col, Δy·row)`）、x 方向 r/col・y 方向 r/row の楕円の内側を、画素中心（x+0.5, y+0.5）で判定する。
 * `roiStats.polygonizeCircle` と同じ図形（面積を出した多角形と、塗った画素が同じ図形）。
 *
 * @param center     円の中心（画素座標。左上隅が 0、画素中心は +0.5）
 * @param edge       縁のハンドル（画素座標）
 * @param basis      world ↔ 画素の換算に使う間隔 [mm/画素]（`imageCoords.worldSpacingOf`）
 * @returns 前景（cols*rows の 0/1）。半径 0 は半画素の円（従来と同じ最小の円）
 */
export function rasterizeCircleFg(
  center: readonly [number, number],
  edge: readonly [number, number],
  cols: number,
  rows: number,
  basis?: { col: number; row: number },
): Uint8Array {
  const fg = new Uint8Array(cols * rows);
  const col = basis && basis.col > 0 ? basis.col : 1;
  const row = basis && basis.row > 0 ? basis.row : 1;
  const [cx, cy] = center;
  const r = Math.hypot((edge[0] - cx) * col, (edge[1] - cy) * row) || 0.5 * Math.min(col, row);
  const rx = r / col;
  const ry = r / row;
  const x0 = Math.max(0, Math.floor(cx - rx)), x1 = Math.min(cols - 1, Math.ceil(cx + rx));
  const y0 = Math.max(0, Math.floor(cy - ry)), y1 = Math.min(rows - 1, Math.ceil(cy + ry));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      if (nx * nx + ny * ny <= 1) fg[y * cols + x] = 1;
    }
  }
  return fg;
}
