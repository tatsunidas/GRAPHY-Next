/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ データ管理 ＞ Google Drive バックアップ の表示ロジック。
 * 状態の判断は backend（`GdriveSyncService`）と main にあり、ここはコードを文言のキーに写すだけ。
 */
import type { GdriveDesktopStatus, GdriveMode } from "../desktopBridge";

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
  /** "backup" / "cache"。以下のキャッシュの項目は "cache" のときだけ意味がある（"backup" では 0）。 */
  mode: GdriveMode | null;
  cacheBytes: number;
  cacheLimitBytes: number;
  localCount: number;
  /** 手元に実体が無い（Drive にだけある）件数。 */
  evictedCount: number;
  /** Drive にだけあって、索引へ取り込んだ件数（今回の起動以降）。 */
  adopted: number;
  /** 手元の保存先の空き容量（"cache" のときだけ）。 */
  usableBytes: number;
}

/** `GET /api/gdrive/localize`（すべてローカルに保存の進み具合） */
export interface GdriveLocalizeProgress {
  phase: "IDLE" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";
  total: number;
  done: number;
  failed: number;
  bytesTotal: number;
  error: string | null;
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
        // Drive が正本のときは、未送信より「手元に無い画像が開けない」ことが利用者に効く
        detailKey: s.mode === "cache" ? "settings.gdrive.offlineHelpCache" : "settings.gdrive.offlineHelp",
        params: { count: s.pending, evicted: s.evictedCount },
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
  "not-synced": "settings.gdrive.err.notSynced",
  "not-all-local": "settings.gdrive.err.notAllLocal",
  "backend-unavailable": "settings.gdrive.err.backendUnavailable",
  "invalid-limit": "settings.gdrive.err.invalidLimit",
  "invalid-mode": "settings.gdrive.err.invalidMode",
  "not-cache-mode": "settings.gdrive.err.notCacheMode",
  "not-enabled": "settings.gdrive.err.notEnabled",
  "not-enough-space": "settings.gdrive.err.notEnoughSpace",
  "no-snapshot": "settings.gdrive.err.noSnapshot",
  offline: "settings.gdrive.err.network",
  "needs-login": "settings.gdrive.err.notSignedIn",
  "not-on-drive": "settings.gdrive.err.notOnDrive",
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

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

/** バイト → 「15 GB」「800 MB」。1 GB 以上は小数 1 桁まで（整数なら小数なし）。単位は 1024 刻み（OS の表記に合わせる）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= GIB) {
    const g = n / GIB;
    return `${Number.isInteger(g) ? g : g.toFixed(1)} GB`;
  }
  return `${Math.round(n / MIB)} MB`;
}

export interface CacheUsage {
  /** 使用量 / 上限（上限が 0 のとき 0）。1 を超えることがある（未送信・直近に使ったものは消せない）。 */
  ratio: number;
  /** 上限を超えている。 */
  over: boolean;
  /** 手元の件数 / 全件。 */
  localCount: number;
  totalCount: number;
}

export function cacheUsage(s: GdriveSyncStatus | null): CacheUsage | null {
  if (!s || s.mode !== "cache") return null;
  const ratio = s.cacheLimitBytes > 0 ? s.cacheBytes / s.cacheLimitBytes : 0;
  return { ratio, over: s.cacheBytes > s.cacheLimitBytes, localCount: s.localCount, totalCount: s.localCount + s.evictedCount };
}

/**
 * 空きが足りないおそれ: 上限まで増えうる分（上限 − 使用量）より、手元の空きが少ない。
 * 空きが分からない（0）ときは出さない（黙って安心させず、警告も出さない＝情報なし）。
 */
export function lowDiskWarning(s: GdriveSyncStatus | null): boolean {
  if (!s || s.mode !== "cache" || s.usableBytes <= 0) return false;
  return s.usableBytes < Math.max(0, s.cacheLimitBytes - s.cacheBytes);
}

/** 上限の入力（GB）→ バイト。数でない・0 以下・下限未満は理由つきで断る。 */
export function parseLimitGb(input: string, minBytes: number): { ok: true; bytes: number } | { ok: false; error: "invalid" | "too-small" } {
  const text = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(text)) return { ok: false, error: "invalid" };
  const gb = Number(text);
  if (!Number.isFinite(gb) || gb <= 0) return { ok: false, error: "invalid" };
  const bytes = Math.round(gb * GIB);
  if (!Number.isSafeInteger(bytes)) return { ok: false, error: "invalid" };
  if (bytes < minBytes) return { ok: false, error: "too-small" };
  return { ok: true, bytes };
}

/** すべてローカルに保存を始められるか（モード A・手元に無いものがある・実行中でない）。 */
export function canLocalize(s: GdriveSyncStatus | null, p: GdriveLocalizeProgress | null): boolean {
  return !!s && s.mode === "cache" && s.evictedCount > 0 && p?.phase !== "RUNNING";
}

export function localizePercent(p: GdriveLocalizeProgress | null): number | null {
  if (!p || p.phase === "IDLE") return null;
  if (p.phase === "DONE") return 100;
  if (p.total <= 0) return null;
  return Math.min(100, Math.floor(((p.done + p.failed) / p.total) * 100));
}
