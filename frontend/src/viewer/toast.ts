/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ビューア用の軽量トースト emitter。ビューポート側（Viewer2D 等）から理由メッセージを流し、
 * 画面（Viewer2DScreen）が購読して表示する。i18n 済み文字列を渡す。
 */
const listeners = new Set<(msg: string) => void>();

/** トーストを表示（i18n 済み文字列）。 */
export function emitToast(msg: string): void {
  for (const l of [...listeners]) {
    try {
      l(msg);
    } catch {
      /* ignore */
    }
  }
}

/** 購読（画面側）。 */
export function subscribeToast(l: (msg: string) => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
