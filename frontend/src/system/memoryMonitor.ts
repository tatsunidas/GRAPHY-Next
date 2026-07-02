/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// System メニューの「MemoryMonitor」: クライアント OS 標準のメモリ/システムモニタを起動する。
// デスクトップ(Electron)では main プロセス経由で OS のツールを spawn。
// web/ブラウザでは OS ツールを起動できないため案内を表示する。

import { desktop } from "../desktopBridge";
import { type TFn } from "../i18n/i18n";
import { log } from "../log";

export async function openMemoryMonitor(t: TFn): Promise<void> {
  const d = desktop();
  if (d?.openMemoryMonitor) {
    try {
      await d.openMemoryMonitor();
    } catch (e) {
      log.error("openMemoryMonitor failed", e);
      window.alert(t("system.memoryMonitor.failed"));
    }
    return;
  }
  // web/ブラウザ: セキュリティ上 OS のモニタは起動できない。
  window.alert(t("system.memoryMonitor.desktopOnly"));
}
