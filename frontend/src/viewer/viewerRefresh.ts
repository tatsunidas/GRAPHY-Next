/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D Viewer 内の「シリーズ検索結果（左ツリー）」再取得トリガ。
 * 新シリーズ生成（DICOM SEG 書出など）後に呼ぶと、同一ウィンドウのツリーが再検索・再取得される。
 * （BroadcastChannel の `dbEvents` は送信元ウィンドウには届かないため、同一ウィンドウ用に別途用意。）
 */
const listeners = new Set<() => void>();

export function emitSeriesRefresh(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function subscribeSeriesRefresh(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
