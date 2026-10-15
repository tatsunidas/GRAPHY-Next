/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 環境設定 ＞ 自動取り込みの表示用の純関数（画面から切り離してテストする）。

/** backend の状態（`GET /api/import/watch/status`）。 */
export interface ImportWatchStatus {
  enabled: boolean;
  folder: string | null;
  intervalSec: number | null;
  scanning: boolean;
  lastScanAt: number | null;
  waiting: number;
  imported: number;
  skipped: number;
  failed: number;
  /** 設定または走査の異常のコード。正常なら null。 */
  error: string | null;
  failures: { path: string; error: string | null }[];
}

export interface ImportWatchForm {
  enabled: boolean;
  folder: string;
  /** 入力欄の文字列（空は未入力）。 */
  intervalSec: string;
}

/** backend が返す異常コード → i18n キー。未知のコードは汎用の文言（コードは別に添える）。 */
export function errorKey(code: string): string {
  switch (code) {
    case "folder-missing":
    case "folder-not-found":
    case "folder-not-directory":
    case "folder-overlaps-db":
    case "interval-invalid":
    case "scan-failed":
      return `importWatch.err.${code}`;
    default:
      return "importWatch.err.unknown";
  }
}

/** 間隔は 1 以上の整数の秒。それ以外は null。 */
export function parseInterval(s: string): number | null {
  if (!/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

/** 有効にして保存するには、フォルダと間隔が要る。無効にするだけなら何も要らない。 */
export function canSave(f: ImportWatchForm): boolean {
  if (!f.enabled) return true;
  return f.folder.trim() !== "" && parseInterval(f.intervalSec) !== null;
}

/** backend の設定キー（`/api/settings` へ送る形）。 */
export function toSettings(f: ImportWatchForm): Record<string, string> {
  const out: Record<string, string> = {
    "import.watch.enabled": String(f.enabled),
    "import.watch.folder": f.folder.trim(),
  };
  const n = parseInterval(f.intervalSec);
  if (n !== null) out["import.watch.intervalSec"] = String(n);
  return out;
}

export function formFromStatus(s: ImportWatchStatus): ImportWatchForm {
  return {
    enabled: s.enabled,
    folder: s.folder ?? "",
    intervalSec: s.intervalSec == null ? "" : String(s.intervalSec),
  };
}
