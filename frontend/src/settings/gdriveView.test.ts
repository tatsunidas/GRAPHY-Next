import { describe, expect, it } from "vitest";
import {
  actionErrorKey,
  cacheUsage,
  canLocalize,
  canSyncNow,
  canTakeOver,
  formatBytes,
  localizePercent,
  lowDiskWarning,
  needsSignIn,
  parseLimitGb,
  reasonKey,
  restorePercent,
  stateView,
  type GdriveLocalizeProgress,
  type GdriveRestoreProgress,
  type GdriveSyncStatus,
} from "./gdriveView";
import { storageReasonKey } from "../storageUnavailable";
import { ja } from "../i18n/ja";
import { en } from "../i18n/en";

const st = (o: Partial<GdriveSyncStatus>): GdriveSyncStatus => ({
  state: "CONNECTED",
  reason: null,
  pending: 0,
  blocked: 0,
  synced: 0,
  lastSyncAt: null,
  lastError: null,
  lockedBy: null,
  lastSnapshotAt: null,
  mode: "backup",
  cacheBytes: 0,
  cacheLimitBytes: 0,
  localCount: 0,
  evictedCount: 0,
  adopted: 0,
  usableBytes: 0,
  ...o,
});

const ds = (o: Partial<{ configured: boolean; signedIn: boolean }> = {}) => ({
  configured: true,
  pickerReady: true,
  signedIn: true,
  email: "a@example.com",
  folder: null,
  defaultCacheLimitBytes: 15 * 1024 ** 3,
  minCacheLimitBytes: 1024 ** 3,
  ...o,
});

const rp = (o: Partial<GdriveRestoreProgress>): GdriveRestoreProgress => ({
  phase: "RUNNING",
  total: 0,
  done: 0,
  skipped: 0,
  snapshotRestored: false,
  error: null,
  ...o,
});

describe("gdriveView", () => {
  it("状態ごとの札と色。届かないときは「確認できない」で、正常には見せない", () => {
    expect(stateView(st({ state: "CONNECTED" })).tone).toBe("ok");
    expect(stateView(st({ state: "SYNCING", pending: 7 }))).toMatchObject({ tone: "busy", params: { count: 7 } });
    expect(stateView(st({ state: "OFFLINE", pending: 3 })).tone).toBe("warn");
    expect(stateView(st({ state: "NEEDS_LOGIN" })).tone).toBe("error");
    expect(stateView(st({ state: "DISABLED" })).tone).toBe("off");
    const unknown = stateView(null);
    expect(unknown.tone).toBe("off");
    expect(unknown.labelKey).toBe("settings.gdrive.state.unknown");
  });

  it("要対応は理由に応じた補足を出し、他端末のときは端末名を渡す", () => {
    const v = stateView(st({ state: "NEEDS_ATTENTION", reason: "locked-by-other", lockedBy: "lab-pc" }));
    expect(v.detailKey).toBe("settings.gdrive.reason.lockedByOther");
    expect(v.params.host).toBe("lab-pc");
    expect(stateView(st({ state: "NEEDS_ATTENTION", reason: "quota" })).detailKey).toBe("settings.gdrive.reason.quota");
    expect(stateView(st({ state: "NEEDS_ATTENTION", reason: "???" })).detailKey).toBe("settings.gdrive.reason.unknown");
    expect(stateView(st({ state: "NEEDS_ATTENTION", reason: "blocked-items", blocked: 4 })).params.count).toBe(4);
  });

  it("引き継ぎは他端末のロックで止まっているときだけ", () => {
    expect(canTakeOver(st({ state: "NEEDS_ATTENTION", reason: "locked-by-other" }))).toBe(true);
    expect(canTakeOver(st({ state: "NEEDS_ATTENTION", reason: "quota" }))).toBe(false);
    expect(canTakeOver(st({ state: "CONNECTED" }))).toBe(false);
    expect(canTakeOver(null)).toBe(false);
  });

  it("今すぐ同期は、無効・要ログイン・届かないときは押せない", () => {
    expect(canSyncNow(st({ state: "CONNECTED" }))).toBe(true);
    expect(canSyncNow(st({ state: "OFFLINE" }))).toBe(true);
    expect(canSyncNow(st({ state: "DISABLED" }))).toBe(false);
    expect(canSyncNow(st({ state: "NEEDS_LOGIN" }))).toBe(false);
    expect(canSyncNow(null)).toBe(false);
  });

  it("再ログインが要るのは、main がログアウト状態か backend が要ログインと言うとき。設定が無ければ要らない", () => {
    expect(needsSignIn(ds({ signedIn: false }), null)).toBe(true);
    expect(needsSignIn(ds(), st({ state: "NEEDS_LOGIN" }))).toBe(true);
    expect(needsSignIn(ds(), st({ state: "CONNECTED" }))).toBe(false);
    expect(needsSignIn(ds({ configured: false, signedIn: false }), null)).toBe(false);
    expect(needsSignIn(null, null)).toBe(false);
  });

  it("復元の進み具合: 件数が分かるまでは null、完了は 100、超えない", () => {
    expect(restorePercent(null)).toBeNull();
    expect(restorePercent(rp({ phase: "IDLE" }))).toBeNull();
    expect(restorePercent(rp({ total: 0 }))).toBeNull();
    expect(restorePercent(rp({ total: 4, done: 1 }))).toBe(25);
    expect(restorePercent(rp({ total: 4, done: 3, skipped: 1 }))).toBe(100);
    expect(restorePercent(rp({ total: 4, done: 9 }))).toBe(100);
    expect(restorePercent(rp({ phase: "DONE", total: 0 }))).toBe(100);
  });

  it("失敗コードは既知なら専用の文言、未知は汎用。http-NNN は先頭で拾う", () => {
    expect(actionErrorKey("parent-read-only")).toBe("settings.gdrive.err.readOnly");
    expect(actionErrorKey("dest-not-empty")).toBe("settings.gdrive.err.destNotEmpty");
    expect(actionErrorKey("http-403-forbidden")).toBe("settings.gdrive.err.forbidden");
    expect(actionErrorKey("http-404")).toBe("settings.gdrive.err.notFound");
    expect(actionErrorKey("???")).toBe("settings.gdrive.err.unknown");
    expect(actionErrorKey(undefined)).toBe("settings.gdrive.err.unknown");
    expect(reasonKey("???")).toBe("settings.gdrive.reason.unknown");
  });

  it("使う文言はすべて ja と en の両方にある", () => {
    const keys = new Set<string>();
    for (const s of ["DISABLED", "CONNECTED", "SYNCING", "OFFLINE", "NEEDS_LOGIN", "NEEDS_ATTENTION"] as const) {
      for (const reason of [null, "quota", "blocked-items", "locked-by-other", "lock-lost", "drive-error",
        "credentials-missing", "bad-folder-id", "bad-device-id", "???"]) {
        const v = stateView(st({ state: s, reason }));
        keys.add(v.labelKey);
        if (v.detailKey) keys.add(v.detailKey);
      }
    }
    keys.add(stateView(null).labelKey);
    keys.add(stateView(st({ state: "OFFLINE", mode: "cache", evictedCount: 4 })).detailKey!);
    keys.add("settings.gdrive.disable.cache");
    for (const c of ["no-oauth-client", "no-picker-key", "not-signed-in", "already-enabled", "parent-read-only",
      "parent-not-folder", "timeout", "busy", "dest-not-empty", "not-empty", "not-backup-folder", "already-running",
      "main-channel-disabled", "md5-mismatch", "snapshot-md5-mismatch", "network", "http-404", "http-403", "???",
      // モード A（Drive 正本）
      "not-synced", "not-all-local", "backend-unavailable", "invalid-limit", "invalid-mode", "not-cache-mode",
      "not-enabled", "not-enough-space", "no-snapshot", "offline", "needs-login", "not-on-drive"]) {
      keys.add(actionErrorKey(c));
    }
    for (const r of ["offline", "needs-login", "drive-disabled", "md5-mismatch", "no-checksum", "not-on-drive", "drive-error", "???", null]) {
      keys.add(storageReasonKey(r));
    }
    expect(keys.size).toBeGreaterThan(20);
    for (const k of keys) {
      expect(ja[k], `ja ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
  });
});

const GIB = 1024 ** 3;

describe("モード A（Drive 正本）の表示ロジック", () => {
  const cache = (o: Partial<GdriveSyncStatus> = {}) =>
    st({ mode: "cache", cacheBytes: 6 * GIB, cacheLimitBytes: 15 * GIB, localCount: 60, evictedCount: 40, usableBytes: 100 * GIB, ...o });

  it("バイトの表記: 1 GB 以上は GB（整数は小数なし）、未満は MB。負・非数は ?", () => {
    expect(formatBytes(15 * GIB)).toBe("15 GB");
    expect(formatBytes(1.5 * GIB)).toBe("1.5 GB");
    expect(formatBytes(GIB)).toBe("1 GB");
    expect(formatBytes(800 * 1024 ** 2)).toBe("800 MB");
    expect(formatBytes(0)).toBe("0 MB");
    expect(formatBytes(-1)).toBe("?");
    expect(formatBytes(Number.NaN)).toBe("?");
  });

  it("使用量: モード B・状態なしは null。上限を超えたら over。件数は手元＋追い出し済みが全件", () => {
    expect(cacheUsage(null)).toBeNull();
    expect(cacheUsage(st({ mode: "backup" }))).toBeNull();
    const u = cacheUsage(cache())!;
    expect(u.ratio).toBeCloseTo(0.4);
    expect(u.over).toBe(false);
    expect(u.localCount).toBe(60);
    expect(u.totalCount).toBe(100);
    expect(cacheUsage(cache({ cacheBytes: 15 * GIB }))!.over).toBe(false);
    expect(cacheUsage(cache({ cacheBytes: 15 * GIB + 1 }))!.over).toBe(true);
    expect(cacheUsage(cache({ cacheBytes: 20 * GIB }))!.ratio).toBeGreaterThan(1);
    expect(cacheUsage(cache({ cacheLimitBytes: 0 }))!.ratio).toBe(0);
  });

  it("空きの警告: 上限まで増えうる分より空きが少ないときだけ。空きが不明（0）なら出さない", () => {
    expect(lowDiskWarning(cache({ usableBytes: 100 * GIB }))).toBe(false);
    expect(lowDiskWarning(cache({ usableBytes: 9 * GIB }))).toBe(false); // 必要量 = 15-6 = 9 GB ちょうどは足りる
    expect(lowDiskWarning(cache({ usableBytes: 9 * GIB - 1 }))).toBe(true);
    expect(lowDiskWarning(cache({ usableBytes: 0 }))).toBe(false);
    expect(lowDiskWarning(cache({ cacheBytes: 20 * GIB, usableBytes: 1 }))).toBe(false); // もう上限超過。増える分は無い
    expect(lowDiskWarning(st({ mode: "backup", usableBytes: 1 }))).toBe(false);
    expect(lowDiskWarning(null)).toBe(false);
  });

  it("上限の入力: 数だけを受け付け、下限未満・0・負・非数・単位つきは理由つきで断る（負例）", () => {
    const min = GIB;
    expect(parseLimitGb("15", min)).toEqual({ ok: true, bytes: 15 * GIB });
    expect(parseLimitGb(" 20.5 ", min)).toEqual({ ok: true, bytes: Math.round(20.5 * GIB) });
    expect(parseLimitGb("1", min)).toEqual({ ok: true, bytes: GIB });
    expect(parseLimitGb("1,000", min)).toEqual({ ok: true, bytes: 1000 * GIB });
    expect(parseLimitGb("0.5", min)).toEqual({ ok: false, error: "too-small" });
    for (const bad of ["", "abc", "0", "-5", "1e3", "15GB", "1.2.3", "NaN", "Infinity", "９９"]) {
      expect(parseLimitGb(bad, min), bad).toEqual({ ok: false, error: "invalid" });
    }
    expect(parseLimitGb("99999999999999999999", min)).toEqual({ ok: false, error: "invalid" });
  });

  const lp = (o: Partial<GdriveLocalizeProgress>): GdriveLocalizeProgress => ({ phase: "RUNNING", total: 0, done: 0, failed: 0, bytesTotal: 0, error: null, ...o });

  it("全件保存を始められる条件: モード A・追い出し済みがある・実行中でない", () => {
    expect(canLocalize(cache(), null)).toBe(true);
    expect(canLocalize(cache(), lp({ phase: "DONE" }))).toBe(true);
    expect(canLocalize(cache(), lp({ phase: "FAILED" }))).toBe(true); // 再実行できる
    expect(canLocalize(cache(), lp({ phase: "RUNNING" }))).toBe(false);
    expect(canLocalize(cache({ evictedCount: 0 }), null)).toBe(false);
    expect(canLocalize(st({ mode: "backup", evictedCount: 5 }), null)).toBe(false);
    expect(canLocalize(null, null)).toBe(false);
  });

  it("全件保存の進み具合（％）", () => {
    expect(localizePercent(null)).toBeNull();
    expect(localizePercent(lp({ phase: "IDLE" }))).toBeNull();
    expect(localizePercent(lp({ total: 0 }))).toBeNull();
    expect(localizePercent(lp({ total: 4, done: 1 }))).toBe(25);
    expect(localizePercent(lp({ total: 4, done: 2, failed: 1 }))).toBe(75);
    expect(localizePercent(lp({ phase: "DONE", total: 0 }))).toBe(100);
    expect(localizePercent(lp({ total: 4, done: 9 }))).toBe(100);
  });

  it("オフライン: Drive 正本では「手元に無い画像が開けない」、バックアップでは未送信の案内（負例: 取り違えない）", () => {
    const cacheOff = stateView(cache({ state: "OFFLINE", evictedCount: 40 }));
    expect(cacheOff.detailKey).toBe("settings.gdrive.offlineHelpCache");
    expect(cacheOff.params.evicted).toBe(40);
    expect(stateView(st({ state: "OFFLINE", mode: "backup", pending: 3 })).detailKey).toBe("settings.gdrive.offlineHelp");
  });

  it("取り寄せ失敗の理由コード（503）→ 文言。未知は汎用", () => {
    expect(storageReasonKey("offline")).toBe("storage.unavailable.offline");
    expect(storageReasonKey("md5-mismatch")).toBe("storage.unavailable.md5-mismatch");
    expect(storageReasonKey("???")).toBe("storage.unavailable.unknown");
    expect(storageReasonKey(null)).toBe("storage.unavailable.unknown");
    expect(storageReasonKey("../x")).toBe("storage.unavailable.unknown");
  });
});
