/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D Viewer のコマンドレジストリ（グローバル）。
 *
 * 各 base `Viewer2D`（SliderView）が `tileId` をキーに命令ハンドラを登録し、
 * 画面の `Viewer2DToolbar` / `Viewer2DMenuBar` が対象タイル群（選択 or 全）へコマンドを送出する。
 * Viewer2D 内部の命令的操作（Fit/回転/Invert/LUT…）を外から起動するための薄い仲介。
 * referenceLines/sliceSync と同じモジュールレベル・レジストリ方式。
 */
import type { LutData } from "../api";

export interface ViewerCommands {
  fit(): void;
  reset(): void;
  rotate90(): void;
  flipH(): void;
  flipV(): void;
  /** 階調反転トグル（カラー画像では no-op）。 */
  invert(): void;
  /** LUT 適用（null でグレースケールに戻す）。 */
  applyLut(lut: LutData | null): void;
  /** W/L プリセット適用（windowCenter / windowWidth、モダリティ値=HU 等）。 */
  setWindowLevel(center: number, width: number): void;
  /** DICOM 既定ウィンドウ（WindowCenter/Width）に戻す。 */
  resetWindow(): void;
  /** 現在の表示 VOI（モダリティ値=HU 等の中心/幅）と対象 imageId を返す。取得不能なら null。 */
  getWindowState(): { imageId: string; center: number; width: number } | null;
  /** 左ドラッグに割り当てる操作/計測/ブラシツールを切替（toolName は Cornerstone のツール名 or 消しゴム id）。 */
  setActiveTool(toolName: string): void;
  /** ROI ブラシ径(px)。 */
  setBrushSize(size: number): void;
  /** 2D Wand のトレランス（シード輝度からの許容差）。 */
  setWandTolerance(tol: number): void;
  /** 計測（ROI）注釈を全消去。 */
  clearAnnotations(): void;
  undo(): void;
  redo(): void;
}

const registry = new Map<string, ViewerCommands>();

/** tileId をキーにコマンドを登録。返り値で解除。 */
export function registerViewerCommands(key: string, cmds: ViewerCommands): () => void {
  registry.set(key, cmds);
  return () => {
    if (registry.get(key) === cmds) registry.delete(key);
  };
}

/** 対象 tileId 群へ同一コマンドを送出する（未登録キーは無視）。 */
export function runViewerCommand(keys: string[], fn: (c: ViewerCommands) => void): void {
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

/** 指定キーが登録済みか。 */
export function hasViewerCommands(key: string): boolean {
  return registry.has(key);
}

/** 単一 tileId のコマンドから値を取得する（未登録・例外なら null）。 */
export function queryViewerCommand<T>(key: string, fn: (c: ViewerCommands) => T): T | null {
  const c = registry.get(key);
  if (!c) return null;
  try {
    return fn(c);
  } catch {
    return null;
  }
}
