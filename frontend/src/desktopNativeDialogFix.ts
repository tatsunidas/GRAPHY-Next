/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Electron の既知挙動対策: ネイティブダイアログ（window.confirm / alert / prompt）を閉じた後、
// レンダラのキーボードフォーカスが失われ、入力欄にフォーカスがあっても文字が打てなくなる。
// （例: DB 管理でスタディ削除の confirm を出した後、検索欄に入力できない → ウィンドウを
//  開き直す＝再フォーカスすると復帰、という症状。）
//
// 呼び出し側（confirm/alert を使う数十箇所）を個別に直すのではなく、起動時に一度だけ
// window.confirm/alert/prompt をラップし、ダイアログが閉じた直後に main プロセス経由で
// webContents を再フォーカスして入力を復帰させる。web/ブラウザでは何もしない。

import { desktop } from "./desktopBridge";

export function installNativeDialogFocusFix(): void {
  const refocus = desktop()?.refocus;
  if (!refocus) return; // デスクトップ（Electron）以外では対処不要

  const wrap = <T extends (...args: never[]) => unknown>(orig: T): T =>
    ((...args: Parameters<T>) => {
      try {
        return orig(...args);
      } finally {
        // ネイティブダイアログは同期ブロッキングのため、この時点で既に閉じている。
        try {
          refocus();
        } catch {
          // 復帰失敗は致命ではない（最悪ウィンドウを一度クリックすれば戻る）。
        }
      }
    }) as T;

  window.confirm = wrap(window.confirm.bind(window));
  window.alert = wrap(window.alert.bind(window));
  window.prompt = wrap(window.prompt.bind(window));
}
