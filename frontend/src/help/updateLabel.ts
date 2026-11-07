/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Help メニューの「更新を確認」の表示（進行中・保留中は、ダイアログを閉じていても状態が分かるように括弧で添える）。

import type { UpdateProgress } from "../desktopBridge";
import { updateProgressPercent } from "./update";

export function updateMenuLabel(t: (key: string, params?: Record<string, string>) => string, base: string, us: UpdateProgress): string {
  // 括弧は言語ごと（日本語は全角、英語は半角＋空白）。help.update.menu.suffix の {{state}} に状態を入れる
  const wrap = (state: string) => `${base}${t("help.update.menu.suffix", { state })}`;
  switch (us.phase) {
    case "downloading": {
      const pct = updateProgressPercent(us.bytes, us.total);
      return wrap(`${t("help.update.menu.downloading")}${pct !== null ? ` ${pct}%` : ""}`);
    }
    case "verifying":
      return wrap(t("help.update.menu.verifying"));
    case "ready":
      return wrap(t("help.update.menu.pending"));
    case "applying":
      return wrap(t("help.update.menu.applying"));
    default:
      return base;
  }
}
