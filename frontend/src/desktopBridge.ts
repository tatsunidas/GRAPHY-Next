/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Electron が preload で公開するデスクトップ専用 API への薄いアクセサ。
// web/ブラウザでは undefined（呼び出し側で機能を出し分ける）。

/** Electron screen.getAllDisplays() の一部を平坦化したもの（モニター診断用）。 */
export interface DisplayInfo {
  id: number;
  label: string;
  primary: boolean;
  internal: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  workArea: { x: number; y: number; width: number; height: number };
  size: { width: number; height: number };
  scaleFactor: number;
  rotation: number;
  colorDepth: number;
  colorSpace: string;
  depthPerComponent: number;
  displayFrequency: number;
  monochrome: boolean;
}

export interface GraphyDesktop {
  pickImportPaths: () => Promise<string[]>;
  /** 単一の出力先フォルダを選ぶ（SeriesExtractor のコピー先など）。キャンセル時 null。 */
  pickDirectory?: () => Promise<string | null>;
  /** 2d/3d/mpr/slicer 等の独立ビューアを新規ウィンドウで開く。 */
  openViewer?: (screen: string) => Promise<void>;
  /** 接続中の全ディスプレイ情報を取得（モニター診断、デスクトップのみ）。 */
  listDisplays?: () => Promise<DisplayInfo[]>;
  /** 指定モニターに目視テストパターンをフルスクリーン表示する（デスクトップのみ）。 */
  openMonitorQc?: (displayId: number) => Promise<void>;
  /** PNG dataURL を OS のネイティブドラッグで外部（デスクトップ/他アプリ）へ書き出す。 */
  startDrag?: (dataUrl: string, filename: string) => void;
  /** OS 標準のメモリ/システムモニタ（Windows=タスクマネージャ, macOS=アクティビティモニタ, Linux=システムモニタ）を起動する。 */
  openMemoryMonitor?: () => Promise<void>;
  /** 外部 URL / mailto を OS の既定アプリ（ブラウザ・メーラ）で開く。 */
  openExternal?: (url: string) => void;
  /** GitHub Releases の最新リリース情報を取得（更新確認、デスクトップのみ）。失敗時 null。 */
  checkForUpdate?: () => Promise<{
    tagName: string;
    name: string;
    body: string;
    htmlUrl: string;
    publishedAt: string | null;
  } | null>;
  /** アプリ全体を再起動する（DICOM 自局設定などの反映用、デスクトップのみ）。 */
  relaunch?: () => Promise<void>;
}

export function desktop(): GraphyDesktop | undefined {
  return (window as unknown as { graphyDesktop?: GraphyDesktop }).graphyDesktop;
}

export const isDesktop = (): boolean => !!desktop();
