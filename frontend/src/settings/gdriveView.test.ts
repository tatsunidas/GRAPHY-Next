import { describe, expect, it } from "vitest";
import {
  actionErrorKey,
  canSyncNow,
  canTakeOver,
  needsSignIn,
  reasonKey,
  restorePercent,
  stateView,
  type GdriveRestoreProgress,
  type GdriveSyncStatus,
} from "./gdriveView";
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
  ...o,
});

const ds = (o: Partial<{ configured: boolean; signedIn: boolean }> = {}) => ({
  configured: true,
  pickerReady: true,
  signedIn: true,
  email: "a@example.com",
  folder: null,
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
    for (const c of ["no-oauth-client", "no-picker-key", "not-signed-in", "already-enabled", "parent-read-only",
      "parent-not-folder", "timeout", "busy", "dest-not-empty", "not-empty", "already-running",
      "main-channel-disabled", "md5-mismatch", "snapshot-md5-mismatch", "network", "http-404", "http-403", "???"]) {
      keys.add(actionErrorKey(c));
    }
    expect(keys.size).toBeGreaterThan(20);
    for (const k of keys) {
      expect(ja[k], `ja ${k}`).toBeTruthy();
      expect(en[k], `en ${k}`).toBeTruthy();
    }
  });
});
