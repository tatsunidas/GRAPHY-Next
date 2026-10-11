/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DB 間のコピー・移動の表示ロジック。
 */
import type { DbFolderRow } from "../desktopBridge";
import type { InboxStatus } from "./dbTransferApi";

/** backend の理由コード（`target-not-found` や `study-not-found: <uid>`）→ 文言のキー。 */
const REASON_KEYS: Record<string, string> = {
  "target-missing": "dbTransfer.reason.targetMissing",
  "target-not-absolute": "dbTransfer.reason.targetNotFound",
  "target-not-found": "dbTransfer.reason.targetNotFound",
  "target-not-writable": "dbTransfer.reason.targetNotWritable",
  "target-has-semicolon": "dbTransfer.reason.targetHasSemicolon",
  "target-is-current": "dbTransfer.reason.targetIsCurrent",
  "target-not-db-folder": "dbTransfer.reason.targetNotDbFolder",
  "not-enough-space": "dbTransfer.reason.notEnoughSpace",
  "study-not-found": "dbTransfer.reason.studyNotFound",
  "local-only": "dbTransfer.reason.localOnly",
};

/** 既知の理由コードなら文言のキー、そうでなければ null（backend の文をそのまま出す）。 */
export function transferReasonKey(message: string): string | null {
  const code = message.split(":")[0].trim();
  return REASON_KEYS[code] ?? null;
}

/** 移し先の候補: 今使っている DB と、見つからない DB は除く。 */
export function targetCandidates(folders: DbFolderRow[]): DbFolderRow[] {
  return folders.filter((f) => !f.active && f.exists);
}

/** 起動時に一度だけ知らせる内容があるか（取り込み中は待つ）。 */
export function hasInboxNews(s: InboxStatus | null): boolean {
  return !!s && !s.running && (s.results.length > 0 || s.stalePartials.length > 0);
}

/** 同じ起動で 2 回知らせないための印（結果の id と残骸の名前から作る）。 */
export function inboxNewsKey(s: InboxStatus): string {
  return [...s.results.map((r) => r.id), ...s.stalePartials].sort().join(",");
}
