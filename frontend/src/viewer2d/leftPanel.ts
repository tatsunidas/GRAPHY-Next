/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** 2D ビューア左パネル（検索・シリーズ一覧）の表示まわりの純関数。 */

/** 左パネルの表示状態を保存する localStorage のキー。 */
export const LEFT_PANEL_OPEN_KEY = "graphy.viewer2d.leftPanelOpen";

/** 保存値 → 表示するか。`"false"` だけが非表示で、欠損・不正値は表示（読めないときに検索パネルが消えたままにならないように）。 */
export function parseLeftPanelOpen(raw: string | null | undefined): boolean {
  return raw !== "false";
}

/** 「表示中」一覧の 1 行ぶん。連結タイルは名前を `+` でつなぎ、`concat` を立てる（接頭辞の語は呼び出し側で i18n）。 */
export function tileListLabel(tile: {
  concat?: { labels: readonly string[] };
  series: { seriesNumber?: number | string | null; modality?: string | null; seriesDescription?: string | null };
}): { text: string; concat: boolean } {
  if (tile.concat) return { text: tile.concat.labels.join(" + "), concat: true };
  const s = tile.series;
  return { text: `#${s.seriesNumber ?? "?"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`.trim(), concat: false };
}
