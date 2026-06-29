/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Electron が preload で公開するデスクトップ専用 API への薄いアクセサ。
// web/ブラウザでは undefined（呼び出し側で機能を出し分ける）。

export interface GraphyDesktop {
  pickImportPaths: () => Promise<string[]>;
  /** 2d/3d/mpr/slicer 等の独立ビューアを新規ウィンドウで開く。 */
  openViewer?: (screen: string) => Promise<void>;
}

export function desktop(): GraphyDesktop | undefined {
  return (window as unknown as { graphyDesktop?: GraphyDesktop }).graphyDesktop;
}

export const isDesktop = (): boolean => !!desktop();
