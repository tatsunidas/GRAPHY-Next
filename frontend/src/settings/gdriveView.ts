/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ データ管理 ＞ Google Drive バックアップ の表示ロジック。
 * 状態の判断は backend（`GdriveSyncService`）と main にあり、ここはコードを文言のキーに写すだけ。
 */
import type { GdriveDesktopStatus } from "../desktopBridge";

export type GdriveState = "DISABLED" | "CONNECTED" | "SYNCING" | "OFFLINE" | "NEEDS_LOGIN" | "NEEDS_ATTENTION";

/** `GET /api/gdrive/status` */
export interface GdriveSyncStatus {
  state: GdriveState;
  reason: string | null;
  pending: number;
  blocked: number;
  synced: number;
  lastSyncAt: number | null;
  lastError: string | null;
  lockedBy: string | null;
  lastSnapshotAt: number | null;
}

/** `GET /api/gdrive/restore` */
export interface GdriveRestoreProgress {
  phase: "IDLE" | "RUNNING" | "DONE" | "FAILED";
  total: number;
  done: number;
  skipped: number;
  snapshotRestored: boolean;
  error: string | null;
}

export type Tone = "ok" | "busy" | "warn" | "error" | "off";

export interface StateView {
  tone: Tone;
  labelKey: string;
  /** 補足の文言（無ければ null）。 */
  detailKey: string | null;
  params: Record<string, string | number>;
}

const REASON_KEYS: Record<string, string> = {
  quota: "settings.gdrive.reason.quota",
  "blocked-items": "settings.gdrive.reason.blockedItems",
  "locked-by-other": "settings.gdrive.reason.lockedByOther",
  "lock-lost": "settings.gdrive.reason.lockLost",
  "drive-error": "settings.gdrive.reason.driveError",
  "credentials-missing": "settings.gdrive.reason.config",
  "bad-folder-id": "settings.gdrive.reason.config",
  "bad-device-id": "settings.gdrive.reason.config",
};

export function reasonKey(reason: string | null | undefined): string {
  return (reason && REASON_KEYS[reason]) || "settings.gdrive.reason.unknown";
}

/** backend の状態 → 札と補足。backend に届かない（null）ときは「確認できない」。 */
export function stateView(s: GdriveSyncStatus | null): StateView {
  if (!s) return { tone: "off", labelKey: "settings.gdrive.state.unknown", detailKey: null, params: {} };
  switch (s.state) {
    case "DISABLED":
      return { tone: "off", labelKey: "settings.gdrive.state.disabled", detailKey: null, params: {} };
    case "CONNECTED":
      return { tone: "ok", labelKey: "settings.gdrive.state.connected", detailKey: null, params: {} };
    case "SYNCING":
      return {
        tone: "busy",
        labelKey: "settings.gdrive.state.syncing",
        detailKey: "settings.gdrive.pending",
        params: { count: s.pending },
      };
    case "OFFLINE":
      return {
        tone: "warn",
        labelKey: "settings.gdrive.state.offline",
        detailKey: "settings.gdrive.offlineHelp",
        params: { count: s.pending },
      };
    case "NEEDS_LOGIN":
      return { tone: "error", labelKey: "settings.gdrive.state.needsLogin", detailKey: "settings.gdrive.needsLoginHelp", params: {} };
    case "NEEDS_ATTENTION":
      return {
        tone: "error",
        labelKey: "settings.gdrive.state.needsAttention",
        detailKey: reasonKey(s.reason),
        params: { host: s.lockedBy ?? "?", count: s.blocked, pending: s.pending },
      };
  }
}

/** ログインが要る（main の状態か backend の状態のどちらかが言っている）。 */
export function needsSignIn(d: GdriveDesktopStatus | null, s: GdriveSyncStatus | null): boolean {
  if (!d || !d.configured) return false;
  return !d.signedIn || s?.state === "NEEDS_LOGIN";
}

/** 他の端末のロックで止まっている → 利用者が確認すれば引き継げる。 */
export function canTakeOver(s: GdriveSyncStatus | null): boolean {
  return s?.state === "NEEDS_ATTENTION" && s.reason === "locked-by-other";
}

export function canSyncNow(s: GdriveSyncStatus | null): boolean {
  return !!s && s.state !== "DISABLED" && s.state !== "NEEDS_LOGIN";
}

/** 復元の進み具合（％）。件数がまだ分からない間は null。 */
export function restorePercent(p: GdriveRestoreProgress | null): number | null {
  if (!p || p.phase === "IDLE") return null;
  if (p.phase === "DONE") return 100;
  if (p.total <= 0) return null;
  return Math.min(100, Math.floor(((p.done + p.skipped) / p.total) * 100));
}

const ACTION_ERROR_KEYS: Record<string, string> = {
  "no-oauth-client": "settings.gdrive.err.noClient",
  "no-picker-key": "settings.gdrive.err.noPickerKey",
  "not-signed-in": "settings.gdrive.err.notSignedIn",
  "already-enabled": "settings.gdrive.err.alreadyEnabled",
  "parent-read-only": "settings.gdrive.err.readOnly",
  "parent-not-folder": "settings.gdrive.err.notFolder",
  timeout: "settings.gdrive.err.timeout",
  busy: "settings.gdrive.err.busy",
  "not-backup-folder": "settings.gdrive.err.notBackup",
  "dest-not-empty": "settings.gdrive.err.destNotEmpty",
  "not-empty": "settings.gdrive.err.destNotEmpty",
  "already-running": "settings.gdrive.err.alreadyRunning",
  "main-channel-disabled": "settings.gdrive.err.noBackend",
  "md5-mismatch": "settings.gdrive.err.corrupt",
  "snapshot-md5-mismatch": "settings.gdrive.err.corrupt",
  network: "settings.gdrive.err.network",
  "http-404": "settings.gdrive.err.notFound",
  "http-403": "settings.gdrive.err.forbidden",
};

/** 有効化・復元などの失敗コード → 文言のキー（未知は汎用。コードは画面に併記する）。 */
export function actionErrorKey(code: string | undefined): string {
  if (!code) return "settings.gdrive.err.unknown";
  if (ACTION_ERROR_KEYS[code]) return ACTION_ERROR_KEYS[code];
  const m = /^(http-\d+)/.exec(code);
  return (m && ACTION_ERROR_KEYS[m[1]]) || "settings.gdrive.err.unknown";
}
