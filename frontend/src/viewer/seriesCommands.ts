/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シリーズ（SeriesViewer）レベルのコマンドレジストリ（グローバル）。
 *
 * <p>`viewerCommands`（Viewer2D=描画面の Fit/回転/LUT…）とは別レイヤ。ZCT インデックスの
 * 並べ替えなど「シリーズ管理コントローラ」に属する操作を、画面メニュー/ツールバーから対象
 * タイル群（選択 or 全）へ送出するための薄い仲介。キーは tileId（= Viewer2D の commandKey）。
 */
import { type SortMode } from "./seriesSort";

export interface SeriesCommands {
  /** Z 並べ替えを適用（動画/IPP 不在などは実装側でブロック＋トースト）。 */
  setSortMode(mode: SortMode): void;
}

const registry = new Map<string, SeriesCommands>();

/** tileId をキーにコマンドを登録。返り値で解除。 */
export function registerSeriesCommands(key: string, cmds: SeriesCommands): () => void {
  registry.set(key, cmds);
  return () => {
    if (registry.get(key) === cmds) registry.delete(key);
  };
}

/** 対象 tileId 群へ同一コマンドを送出する（未登録キーは無視）。 */
export function runSeriesCommand(keys: string[], fn: (c: SeriesCommands) => void): void {
  for (const k of keys) {
    const c = registry.get(k);
    if (!c) continue;
    try {
      fn(c);
    } catch {
      /* ビューポート破棄途中などは無視 */
    }
  }
}
