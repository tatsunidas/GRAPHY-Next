/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ データ管理 ＞ DB フォルダ の表示ロジック（検査規則は main の dbFolders.js に 1 つだけ）。
 */
import type { DbFolderRow } from "../desktopBridge";

/** main が返す理由コード → 表示文言のキー。未知のコードは汎用の文言にする（コードは併記）。 */
const REASON_KEYS: Record<string, string> = {
  "not-absolute": "settings.dbFolder.reason.notAbsolute",
  "has-semicolon": "settings.dbFolder.reason.hasSemicolon",
  "not-found": "settings.dbFolder.reason.notFound",
  "not-directory": "settings.dbFolder.reason.notDirectory",
  "not-writable": "settings.dbFolder.reason.notWritable",
  "not-a-db-folder": "settings.dbFolder.reason.notDbFolder",
  "not-empty": "settings.dbFolder.reason.notEmpty",
  "in-use": "settings.dbFolder.reason.inUse",
  "already-active": "settings.dbFolder.reason.alreadyActive",
};

export function reasonKey(reason: string | undefined): string {
  return (reason && REASON_KEYS[reason]) || "settings.dbFolder.reason.unknown";
}

/** 行に付ける札（表示順どおり）。 */
export function badgeKeys(row: DbFolderRow): string[] {
  const out: string[] = [];
  if (row.active) out.push("settings.dbFolder.badge.active");
  if (row.isDefault) out.push("settings.dbFolder.badge.default");
  if (!row.exists) out.push("settings.dbFolder.badge.missing");
  return out;
}

export function canSwitch(row: DbFolderRow): boolean {
  return !row.active && row.exists;
}

/** 既定の DB と使用中の DB は一覧から外せない。 */
export function canForget(row: DbFolderRow): boolean {
  return !row.isDefault && !row.active;
}
