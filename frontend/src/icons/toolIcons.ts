/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ツールアイコンの単一レジストリ。
 *
 * 目的: 「ツールを追加したら必ずアイコンを設定する」を仕組みで担保する。
 *   1. 実体の PNG は frontend/public/icons/tools/ に置く（web/standalone 共通・単一ソース）。
 *   2. ツール ID → ファイル名の対応をこの TOOL_ICON_FILES に 1 行足す。
 *   3. 未登録のツールは dev 起動時に verifyToolIcons() が console.warn で通知する。
 *
 * 参照は base:"./" 前提の相対パス（絶対 "/icons/..." は Electron の file:// で壊れる）。
 */
import type { CSSProperties } from "react";
import { TOOL_IDS } from "../viewer/toolIds";

/** public/icons/tools/ 配下の相対 URL を返す。 */
export function toolIconUrl(file: string): string {
  return `./icons/tools/${file}`;
}

/**
 * ツール ID（TOOL_IDS の値）→ アイコンファイル名。
 * 新規ツールを追加したら、ここに必ず 1 行追加する（アイコンが無ければ tools/ に用意してから登録）。
 */
export const TOOL_ICON_FILES: Partial<Record<string, string>> = {
  [TOOL_IDS.windowLevel]: "WL_opacity_black_48dp.png",
  [TOOL_IDS.pan]: "others/pan.png",
  [TOOL_IDS.zoom]: "others/zoom.png",
  [TOOL_IDS.length]: "outline_square_foot_black_48dp.png",
  [TOOL_IDS.angle]: "roi_angle.png",
  [TOOL_IDS.ellipse]: "roi_oval_circle.png",
  [TOOL_IDS.rect]: "roi_rectangle.png",
  [TOOL_IDS.probe]: "roi_point_scan_64dp.png",
  [TOOL_IDS.brush]: "roi_brush_48dp.png",
  [TOOL_IDS.eraser]: "roi_brush_48dp.png",
  [TOOL_IDS.region3d]: "3d_sphere_roi_48dp_1F1F1F.png",
  // 未登録: wand2d（適切な PNG を用意でき次第ここに追加）
};

/** ツール ID からアイコン URL を返す（未登録なら undefined）。 */
export function toolIcon(id: string): string | undefined {
  const file = TOOL_ICON_FILES[id];
  return file ? toolIconUrl(file) : undefined;
}

/**
 * ツールバー/メニューの「アクション」用アイコン（cornerstone ツール以外）。
 * キーは意味を表す任意名。値は tools/ からの相対ファイル名（サブフォルダ可）。
 * 対応するアイコンが無いボタンはここに載せず、呼び出し側で従来のグリフを維持する。
 */
export const UI_ICON_FILES = {
  // --- メインツールバー: データ I/O ---
  import: "folder_open_FILL0_wght400_GRAD0_opsz24.png",
  export: "others/export_series.png",
  send: "ic_send_black_48dp.png",
  nonDicomImport: "outline_add_photo_alternate_black_48dp.png",
  anonymizer: "anonymize_48dp_1F1F1F.png",
  tagExtractor: "tag_extractor2_48dp_1F1F1F.png",
  tagViewer: "others/metadata_viewerpage.png",
  seriesExtractor: "ConditionalSeriesExtractor_48dp_1F1F1F.png",
  refresh: "autorenew_black_48dp.png",
  db: "database_black_48dp.png",
  settings: "ic_settings_black_48dp.png",
  // --- メインツールバー: ビューア起動 ---
  qr: "others/search.png",
  viewer2d: "open_series_eye.png",
  viewer3d: "others/Cube3D.png",
  slicer: "slicer.png",
  // --- 2D ビューアツールバー（pan/zoom/W/L/brush 等は cornerstone ツール = TOOL_ICON_FILES 側）---
  sync: "others/Link.png",
  refLines: "others/scout.png",
  invert: "others/invert.png",
  rotate: "others/rotate_right.png",
  flipH: "others/flip_horizontal.png",
  flipV: "others/flip_vertical.png",
  fit: "others/entire.png",
  reset: "others/reset.png",
} as const;

/** UI アクションアイコンの相対 URL を返す。 */
export function uiIcon(key: keyof typeof UI_ICON_FILES): string {
  return toolIconUrl(UI_ICON_FILES[key]);
}

/** アクティブ（青背景 #0b5cad）ボタン上で黒アイコンを白へ反転させて視認性を確保する。 */
export const ACTIVE_ICON_STYLE: CSSProperties = { filter: "invert(1) brightness(2)" };

/**
 * dev 専用ガード: TOOL_IDS のうちアイコン未登録のものを一括で警告する。
 * 新しいツールを追加してアイコン登録を忘れた場合に気づけるようにする（本番では何もしない）。
 */
export function verifyToolIcons(): void {
  if (!import.meta.env.DEV) return;
  const missing = Object.entries(TOOL_IDS)
    .filter(([, id]) => !TOOL_ICON_FILES[id])
    .map(([key]) => key);
  if (missing.length) {
    console.warn(
      `[toolIcons] アイコン未登録のツール: ${missing.join(", ")}\n` +
        `→ frontend/public/icons/tools/ に PNG を置き、` +
        `frontend/src/icons/toolIcons.ts の TOOL_ICON_FILES に登録してください。`,
    );
  }
}
