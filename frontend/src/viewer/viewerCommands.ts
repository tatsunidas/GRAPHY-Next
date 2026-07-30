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

/**
 * タイル 1 枚が「いま何を表示しているか」（プラグイン host API の H1・fw/plugin-architecture.md §7）。
 *
 * <p>`tileId` は付与しない: レジストリのキー＝tileId なので、問い合わせた側が知っている。
 */
export interface ViewerTargetInfo {
  studyUid: string;
  seriesUid: string;
  /** 画面に出ているシリーズ名（"3: AXIAL CT" 等）。 */
  seriesLabel: string;
  /** 表示中スライスの imageId。 */
  imageId: string;
  /** 表示中スライス（Z）の 0 始まり index と、そのスタックの総数。 */
  sliceIndex: number;
  sliceCount: number;
  /** ZCT モデルのチャンネル / 時相（多次元でないシリーズは 0）。 */
  c: number;
  t: number;
  modality: string;
}

/**
 * タイル 1 枚の表示状態（プラグイン host API の H2）。
 *
 * <p>W/L は**モダリティ値空間**（CT なら HU、SUV 校正済み PET なら Bq/mL）。表示単位は `unit`。
 */
export interface ViewerViewState {
  windowCenter: number;
  windowWidth: number;
  /** 校正済み画素値の単位（RescaleType、無ければ CT のみ "HU"、それ以外は ""）。 */
  unit: string;
  /**
   * 適用中の LUT 名（LUT ダイアログの名前。例 `"10_Percent"`）。グレースケール（未適用）なら null。
   * 本体の内部登録名 `graphy-lut-…` / `graphy-gray` は出さない。
   */
  colormap: string | null;
  invert: boolean;
  flipH: boolean;
  flipV: boolean;
  /** 度。 */
  rotation: number;
  /** Fit を 1.0 とした相対倍率。 */
  zoom: number;
  /** 既定（画像が中央）からのオフセット（world mm）。 */
  pan: [number, number];
}

/** `getPixelData` の任意指定。 */
export interface ViewerPixelDataOptions {
  /**
   * 読み出すスライス（Z）の 0 始まり index。既定は表示中スライス。
   * **範囲外は拒否（null）**＝黙って別のスライスを返さない。
   */
  sliceIndex?: number;
}

/**
 * タイル 1 枚の画素（プラグイン host API の H3）。
 *
 * <p>値は **`pixelCalibration.readModalitySlice()` 経由のモダリティ値**（CT なら HU、
 * SUV 校正済み PET なら SUV）。カラー（RGB）画像は輝度（ITU-R BT.601）で `unit="raw"`。
 * 表示 W/L は掛かっていない（8bit の見た目ではなく定量値）。
 */
export interface ViewerPixelData {
  imageId: string;
  /** 実際に読み出したスライスの index（要求を省略したときは表示中スライス）。 */
  sliceIndex: number;
  /** 行数（height）・列数（width）。`data.length === rows * cols`。 */
  rows: number;
  cols: number;
  /** row-major。`data[y * cols + x]`。 */
  data: Float32Array;
  /** 値の単位（"HU" / "SUVbw" / "" / カラーは "raw"）。 */
  unit: string;
  /** 画素間隔 [列方向(x), 行方向(y), スライス方向(z)] mm。不明な軸は null。 */
  spacing: [number | null, number | null, number | null];
}

/** 画面（複数タイル）視点での H1 の 1 件。どのタイルの話かが要るので tileId を持つ。 */
export interface ViewerTarget extends ViewerTargetInfo {
  tileId: string;
}

/** 画面視点での H2。 */
export interface ViewerTileViewState extends ViewerViewState {
  tileId: string;
}

/** 画面視点での H3。 */
export interface ViewerTilePixelData extends ViewerPixelData {
  tileId: string;
}

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
  /** 現在適用中の LUT データ（未適用/グレースケールは null）。Fusion への LUT 引き継ぎ用。 */
  getLutData(): LutData | null;
  /** W/L プリセット適用（windowCenter / windowWidth、モダリティ値=HU 等）。 */
  setWindowLevel(center: number, width: number): void;
  /** DICOM 既定ウィンドウ（WindowCenter/Width）に戻す。 */
  resetWindow(): void;
  /** 現在の表示 VOI（モダリティ値=HU 等の中心/幅）と対象 imageId を返す。取得不能なら null。 */
  getWindowState(): { imageId: string; center: number; width: number } | null;
  /** SUV 校正ダイアログ用のコンテキスト（表示中 imageId・SeriesUID・モダリティ）。取得不能なら null。 */
  getSuvContext(): { imageId: string; seriesUid: string; modality: string } | null;
  /** いま表示しているスタディ/シリーズ/スライス。プラグイン host API の H1。取得不能なら null。 */
  getTargetInfo(): ViewerTargetInfo | null;
  /** いまの表示状態（W/L・LUT・反転・affine）。プラグイン host API の H2。取得不能なら null。 */
  getViewState(): ViewerViewState | null;
  /**
   * スライス 1 枚の校正済み画素。プラグイン host API の H3。取得不能・範囲外なら null。
   * 読み出しは `pixelCalibration.readModalitySlice()` に委譲する（校正の単一入口）。
   */
  getPixelData(opts?: ViewerPixelDataOptions): Promise<ViewerPixelData | null>;
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
