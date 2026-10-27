/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ データ管理 ＞ Google Drive バックアップ（デスクトップのみ）。
 *
 * <p>ログイン・保存先の選択・解除・復元の開始は main が行う（トークンは main の safeStorage だけ）。
 * 同期の状態は backend（`GET /api/gdrive/status`）が持つので、この画面は問い合わせて表示するだけ。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import { useDateFormat, formatDateTime } from "../i18n/dateFormat";
import { desktop, type GdriveDesktopStatus, type GdriveMode } from "../desktopBridge";
import { HttpError } from "../http";
import {
  cancelGdriveLocalize,
  fetchGdriveLocalize,
  fetchGdriveRestore,
  fetchGdriveStatus,
  gdriveSyncNow,
  gdriveTakeOver,
  startGdriveLocalize,
} from "./gdriveApi";
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
  restorePercent,
  stateView,
  type GdriveLocalizeProgress,
  type GdriveRestoreProgress,
  type GdriveSyncStatus,
  type Tone,
} from "./gdriveView";

const STATUS_POLL_MS = 4000;
const RESTORE_POLL_MS = 1000;

export function GdrivePanel() {
  const { t } = useI18n();
  useDateFormat(); // 書式の設定が変わったら再描画する
  const d = desktop();
  const [ds, setDs] = useState<GdriveDesktopStatus | null>(null);
  const [sync, setSync] = useState<GdriveSyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<GdriveRestoreProgress | null>(null);
  const [restoredFolder, setRestoredFolder] = useState<string | null>(null);
  const [restoredMode, setRestoredMode] = useState<GdriveMode>("backup");
  /** 有効化の前に選ぶ保存方式／復元のしかた。 */
  const [enableMode, setEnableMode] = useState<GdriveMode>("backup");
  const [restoreMode, setRestoreMode] = useState<GdriveMode>("backup");
  const [localize, setLocalize] = useState<GdriveLocalizeProgress | null>(null);
  const [limitInput, setLimitInput] = useState<string | null>(null);
  const [limitMsg, setLimitMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const alive = useRef(true);

  const failure = useCallback(
    (code: string | undefined) =>
      setError(t("settings.gdrive.error", { reason: t(actionErrorKey(code)), code: code ?? "?" })),
    [t],
  );

  const refreshDesktop = useCallback(async () => {
    if (!d?.gdriveStatus) return;
    try {
      const s = await d.gdriveStatus();
      if (alive.current) setDs(s);
    } catch (e) {
      if (alive.current) setError(String(e));
    }
  }, [d]);

  const refreshSync = useCallback(async () => {
    try {
      const s = await fetchGdriveStatus();
      if (alive.current) setSync(s);
    } catch {
      if (alive.current) setSync(null); // 届かない間は「確認できない」と出す
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refreshDesktop();
    return () => {
      alive.current = false;
    };
  }, [refreshDesktop]);

  const enabled = !!ds?.folder;
  useEffect(() => {
    if (!enabled) {
      setSync(null);
      return;
    }
    void refreshSync();
    const id = setInterval(() => void refreshSync(), STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [enabled, refreshSync]);

  const cacheMode = enabled && sync?.mode === "cache";
  const localizing = localize?.phase === "RUNNING";
  useEffect(() => {
    if (!cacheMode) {
      setLocalize(null);
      return;
    }
    const poll = async () => {
      try {
        const p = await fetchGdriveLocalize();
        if (alive.current) setLocalize(p);
      } catch {
        // 次の周期で取り直す
      }
    };
    void poll();
    const id = setInterval(() => void poll(), localizing ? RESTORE_POLL_MS : STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [cacheMode, localizing]);

  const restoring = restore?.phase === "RUNNING";
  useEffect(() => {
    if (!restoring) return;
    const id = setInterval(async () => {
      try {
        const p = await fetchGdriveRestore();
        if (alive.current) setRestore(p);
      } catch {
        // 次の周期で取り直す
      }
    }, RESTORE_POLL_MS);
    return () => clearInterval(id);
  }, [restoring]);

  if (!d?.gdriveStatus) return null;

  const run = async (name: string, op: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await op();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      void refreshDesktop();
      if (enabled) void refreshSync();
    }
  };

  const signIn = () =>
    run("signin", async () => {
      const r = await d.gdriveSignIn!();
      if (!r.ok) failure(r.error);
    });

  const signOut = () =>
    run("signout", async () => {
      const r = await d.gdriveSignOut!();
      if (!r.ok) failure(r.error);
    });

  const enable = () =>
    run("enable", async () => {
      const r = await d.gdriveEnable!(enableMode);
      if (!r.ok && !r.canceled) failure(r.error);
    });

  const disable = () =>
    run("disable", async () => {
      const r = await d.gdriveDisable!();
      if (!r.ok && !r.canceled) failure(r.error);
    });

  const switchMode = () => {
    const target: GdriveMode = ds?.folder?.mode === "cache" ? "backup" : "cache";
    const limit = formatBytes(ds?.folder?.cacheLimitBytes ?? ds?.defaultCacheLimitBytes ?? 0);
    const ok = window.confirm(t(target === "cache" ? "settings.gdrive.mode.confirmToCache" : "settings.gdrive.mode.confirmToBackup", { limit }));
    d.refocus?.();
    if (!ok) return;
    void run("switchMode", async () => {
      const r = await d.gdriveSetMode!(target);
      if (!r.ok) failure(r.error);
    });
  };

  const saveLimit = () =>
    run("limit", async () => {
      setLimitMsg(null);
      const min = ds?.minCacheLimitBytes ?? 0;
      const parsed = parseLimitGb(limitInput ?? "", min);
      if (!parsed.ok) {
        setLimitMsg({
          ok: false,
          text: parsed.error === "too-small" ? t("settings.gdrive.cache.limitTooSmall", { min: formatBytes(min) }) : t("settings.gdrive.cache.limitInvalid"),
        });
        return;
      }
      const r = await d.gdriveSetCacheLimit!(parsed.bytes);
      if (!r.ok) {
        failure(r.error);
        return;
      }
      setLimitInput(null);
      setLimitMsg({ ok: true, text: t("settings.gdrive.cache.limitSaved", { limit: formatBytes(parsed.bytes) }) });
    });

  const startLocalize = () =>
    run("localize", async () => {
      try {
        await startGdriveLocalize();
        setLocalize({ phase: "RUNNING", total: sync?.evictedCount ?? 0, done: 0, failed: 0, bytesTotal: 0, error: null });
      } catch (e) {
        failure(e instanceof HttpError ? e.message : undefined);
      }
    });

  const cancelLocalize = () =>
    run("cancelLocalize", async () => {
      await cancelGdriveLocalize();
      setLocalize(await fetchGdriveLocalize());
    });

  const syncNow = () =>
    run("sync", async () => {
      await gdriveSyncNow();
    });

  const takeOver = () => {
    const ok = window.confirm(t("settings.gdrive.takeover.confirm", { host: sync?.lockedBy ?? "?" }));
    d.refocus?.();
    if (!ok) return;
    void run("takeover", async () => {
      await gdriveTakeOver();
    });
  };

  const startRestore = () =>
    run("restore", async () => {
      setRestoredFolder(null);
      const r = await d.gdriveRestore!(t("settings.gdrive.restore.dialogTitle"), restoreMode);
      if (!r.ok) {
        if (!r.canceled) failure(r.error);
        return;
      }
      setRestoredFolder(r.folder);
      setRestoredMode(r.mode ?? restoreMode);
      setRestore({ phase: "RUNNING", total: 0, done: 0, skipped: 0, snapshotRestored: false, error: null });
    });

  const view = stateView(enabled ? sync : null);
  const percent = restorePercent(restore);
  const usage = cacheUsage(enabled ? sync : null);
  const lowDisk = lowDiskWarning(enabled ? sync : null);
  const locPercent = localizePercent(localize);
  const limitShown = limitInput ?? gbText(ds?.folder?.cacheLimitBytes ?? ds?.defaultCacheLimitBytes ?? 0);

  return (
    <section data-testid="gdrive-panel" style={{ marginBottom: 22 }}>
      <h3 style={sectionTitle}>{t("settings.gdrive.title")}</h3>
      <p style={note}>{t("settings.gdrive.help")}</p>
      {error && <div style={{ color: "#b00020", margin: "6px 0" }}>{error}</div>}

      {ds && !ds.configured && <p style={note}>{t("settings.gdrive.notConfigured")}</p>}

      {ds?.configured && (
        <div style={{ margin: "6px 0" }}>
          {ds.signedIn ? (
            <>
              <span>{t("settings.gdrive.signedInAs", { email: ds.email ?? "?" })}</span>
              <button style={btn} disabled={!!busy} onClick={signOut}>
                {t("settings.gdrive.signOut")}
              </button>
            </>
          ) : (
            <>
              <button data-testid="gdrive-signin" style={btn} disabled={!!busy} onClick={signIn}>
                {busy === "signin" ? t("settings.gdrive.signingIn") : t("settings.gdrive.signIn")}
              </button>
              <p style={note}>{t("settings.gdrive.signIn.help")}</p>
            </>
          )}
          {ds.signedIn && needsSignIn(ds, sync) && (
            <button style={btn} disabled={!!busy} onClick={signIn}>
              {t("settings.gdrive.signIn")}
            </button>
          )}
        </div>
      )}

      {ds?.configured && ds.signedIn && !enabled && (
        <div style={{ margin: "8px 0" }}>
          <fieldset data-testid="gdrive-mode-choice" style={fieldset}>
            <legend style={legend}>{t("settings.gdrive.mode.title")}</legend>
            {(["backup", "cache"] as const).map((m) => (
              <label key={m} style={radioRow}>
                <input
                  type="radio"
                  name="gdrive-mode"
                  data-testid={`gdrive-mode-${m}`}
                  checked={enableMode === m}
                  disabled={!!busy}
                  onChange={() => setEnableMode(m)}
                />
                <span>
                  <span>{t(`settings.gdrive.mode.${m}`)}</span>
                  <span style={{ ...note, display: "block", margin: "2px 0 0" }}>{t(`settings.gdrive.mode.${m}.help`)}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <button data-testid="gdrive-enable" style={btn} disabled={!!busy || !ds.pickerReady} onClick={enable}>
            {busy === "enable" ? t("settings.gdrive.enabling") : t("settings.gdrive.enable")}
          </button>
          <p style={note}>{t("settings.gdrive.enable.help")}</p>
        </div>
      )}

      {enabled && ds?.folder && (
        <div data-testid="gdrive-enabled" style={{ margin: "8px 0" }}>
          <div>
            {t("settings.gdrive.folder", { name: ds.folder.name })}
            <span style={badge}>{ds.folder.shared ? t("settings.gdrive.shared") : t("settings.gdrive.myDrive")}</span>
            <span data-testid="gdrive-mode-badge" data-mode={ds.folder.mode} style={{ ...badge, background: ds.folder.mode === "cache" ? "#efe6fa" : "#e6effa", color: ds.folder.mode === "cache" ? "#5b2d91" : "#0b5cad" }}>
              {t(`settings.gdrive.mode.badge.${ds.folder.mode}`)}
            </span>
          </div>
          <div style={{ margin: "6px 0" }}>
            <span data-testid="gdrive-state" data-tone={view.tone} style={{ ...stateBadge, ...TONES[view.tone] }}>
              {t(view.labelKey)}
            </span>
            {view.detailKey && (
              <span style={{ marginLeft: 8, fontSize: 12 }}>
                {t(view.detailKey, view.params)}
              </span>
            )}
          </div>
          {sync && (
            <div style={note}>
              <div>{t("settings.gdrive.counts", { synced: sync.synced })}</div>
              <div>
                {t("settings.gdrive.lastSync", { time: formatTime(sync.lastSyncAt, t("settings.gdrive.never")) })}
              </div>
              <div>
                {t("settings.gdrive.lastSnapshot", { time: formatTime(sync.lastSnapshotAt, t("settings.gdrive.never")) })}
              </div>
            </div>
          )}
          {usage && sync && (
            <div data-testid="gdrive-cache" style={cacheBox}>
              <h4 style={h4}>{t("settings.gdrive.cache.title")}</h4>
              <div data-testid="gdrive-usage" data-over={usage.over ? "1" : "0"}>
                {t("settings.gdrive.cache.usage", {
                  used: formatBytes(sync.cacheBytes),
                  limit: formatBytes(sync.cacheLimitBytes),
                  percent: Math.round(usage.ratio * 100),
                })}
              </div>
              <div style={barTrack}>
                <div style={{ ...barFill, width: `${Math.min(100, Math.round(usage.ratio * 100))}%`, background: usage.over ? "#d98a00" : "#2e7d32" }} />
              </div>
              <div style={note}>
                {t("settings.gdrive.cache.counts", { local: usage.localCount, total: usage.totalCount, evicted: sync.evictedCount })}
              </div>
              {usage.over && (
                <div data-testid="gdrive-cache-over" style={warnText}>
                  {t("settings.gdrive.cache.over")}
                </div>
              )}
              {lowDisk && (
                <div data-testid="gdrive-cache-lowdisk" style={warnText}>
                  {t("settings.gdrive.cache.lowDisk", {
                    free: formatBytes(sync.usableBytes),
                    need: formatBytes(Math.max(0, sync.cacheLimitBytes - sync.cacheBytes)),
                  })}
                </div>
              )}
              {sync.adopted > 0 && <div style={note}>{t("settings.gdrive.cache.adopted", { count: sync.adopted })}</div>}
              <div style={{ margin: "8px 0 2px" }}>
                <label>
                  {t("settings.gdrive.cache.limitLabel")}{" "}
                  <input
                    data-testid="gdrive-limit-input"
                    type="text"
                    inputMode="decimal"
                    value={limitShown}
                    disabled={!!busy}
                    onChange={(e) => setLimitInput(e.target.value)}
                    style={{ width: 70, padding: "3px 6px" }}
                  />{" "}
                  GB
                </label>
                <button data-testid="gdrive-limit-save" style={btn} disabled={!!busy || limitInput === null} onClick={saveLimit}>
                  {t("settings.gdrive.cache.limitSave")}
                </button>
              </div>
              {limitMsg && (
                <div data-testid="gdrive-limit-msg" style={{ fontSize: 12, color: limitMsg.ok ? "#1b6b2c" : "#b00020" }}>
                  {limitMsg.text}
                </div>
              )}
              <p style={note}>
                {t("settings.gdrive.cache.limitHelp", {
                  default: formatBytes(ds?.defaultCacheLimitBytes ?? 0),
                  min: formatBytes(ds?.minCacheLimitBytes ?? 0),
                })}
              </p>
              <div>
                <button data-testid="gdrive-localize" style={{ ...btn, marginLeft: 0 }} disabled={!!busy || !canLocalize(sync, localize)} onClick={startLocalize}>
                  {t("settings.gdrive.localize.button")}
                </button>
                {localizing && (
                  <button data-testid="gdrive-localize-cancel" style={btn} disabled={!!busy} onClick={cancelLocalize}>
                    {t("settings.gdrive.localize.cancel")}
                  </button>
                )}
              </div>
              <p style={note}>{t("settings.gdrive.localize.help")}</p>
              {localizing && localize && (
                <div data-testid="gdrive-localize-progress">
                  <div>{t("settings.gdrive.localize.running", { done: localize.done, total: localize.total })}</div>
                  {locPercent !== null && <progress value={locPercent} max={100} style={{ width: "100%" }} />}
                </div>
              )}
              {localize?.phase === "DONE" && (
                <div data-testid="gdrive-localize-done" style={{ fontSize: 12, color: "#1b6b2c" }}>
                  {t("settings.gdrive.localize.done", { total: localize.total })}
                </div>
              )}
              {localize?.phase === "FAILED" && (
                <div data-testid="gdrive-localize-failed" style={{ fontSize: 12, color: "#b00020" }}>
                  {t("settings.gdrive.localize.failed", { failed: localize.failed, reason: t(actionErrorKey(localize.error ?? undefined)) })}
                </div>
              )}
              {localize?.phase === "CANCELLED" && <div style={note}>{t("settings.gdrive.localize.cancelled")}</div>}
            </div>
          )}
          <div>
            <button style={btn} disabled={!!busy || !canSyncNow(sync)} onClick={syncNow}>
              {t("settings.gdrive.syncNow")}
            </button>
            {canTakeOver(sync) && (
              <button style={btn} disabled={!!busy} onClick={takeOver}>
                {t("settings.gdrive.takeover")}
              </button>
            )}
            <button data-testid="gdrive-switch-mode" style={btn} disabled={!!busy || !sync || localizing} onClick={switchMode}>
              {t(ds.folder.mode === "cache" ? "settings.gdrive.mode.switchToBackup" : "settings.gdrive.mode.switchToCache")}
            </button>
            <button style={btn} disabled={!!busy} onClick={disable}>
              {t(ds.folder.mode === "cache" ? "settings.gdrive.disable.cache" : "settings.gdrive.disable")}
            </button>
          </div>
        </div>
      )}

      {ds?.configured && ds.signedIn && ds.pickerReady && (
        <div data-testid="gdrive-restore" style={{ marginTop: 14 }}>
          <h4 style={{ fontSize: 13, margin: "0 0 4px", color: "#444" }}>{t("settings.gdrive.restore.title")}</h4>
          <p style={note}>{t("settings.gdrive.restore.help")}</p>
          <fieldset data-testid="gdrive-restore-mode" style={fieldset}>
            <legend style={legend}>{t("settings.gdrive.restore.mode.title")}</legend>
            {(["backup", "cache"] as const).map((m) => (
              <label key={m} style={radioRow}>
                <input
                  type="radio"
                  name="gdrive-restore-mode"
                  data-testid={`gdrive-restore-mode-${m}`}
                  checked={restoreMode === m}
                  disabled={!!busy || restoring}
                  onChange={() => setRestoreMode(m)}
                />
                <span>{t(`settings.gdrive.restore.mode.${m}`)}</span>
              </label>
            ))}
          </fieldset>
          <button data-testid="gdrive-restore-button" style={btn} disabled={!!busy || restoring} onClick={startRestore}>
            {busy === "restore" ? t("settings.gdrive.restore.starting") : t("settings.gdrive.restore.button")}
          </button>
          {restoring && (
            <div style={{ marginTop: 6 }}>
              <div>{t("settings.gdrive.restore.running", { done: restore!.done, total: restore!.total })}</div>
              {percent !== null && <progress value={percent} max={100} style={{ width: "100%" }} />}
            </div>
          )}
          {restore?.phase === "DONE" && (
            <div style={{ marginTop: 6 }}>
              <div>
                {restoredMode === "cache" ? t("settings.gdrive.restore.doneIndex") : t("settings.gdrive.restore.done", { done: restore.done })}
              </div>
              {!restore.snapshotRestored && <div style={{ ...note, color: "#8a5a00" }}>{t("settings.gdrive.restore.noSnapshot")}</div>}
              {restore.skipped > 0 && (
                <div style={{ ...note, color: "#8a5a00" }}>{t("settings.gdrive.restore.skipped", { count: restore.skipped })}</div>
              )}
              {restoredFolder && (
                <button style={btn} disabled={!!busy} onClick={() => void d.dbFoldersSwitch?.(restoredFolder)}>
                  {t("settings.gdrive.restore.open")}
                </button>
              )}
            </div>
          )}
          {restore?.phase === "FAILED" && (
            <div style={{ color: "#b00020", marginTop: 6 }}>
              {t("settings.gdrive.restore.failed", { code: restore.error ?? "?" })}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** バイト → 入力欄に出す GB の数（整数なら小数なし、そうでなければ 1 桁）。 */
function gbText(bytes: number): string {
  const g = bytes / 1024 ** 3;
  return Number.isInteger(g) ? String(g) : g.toFixed(1);
}

function formatTime(ms: number | null, none: string): string {
  return ms ? formatDateTime(ms) : none;
}

const TONES: Record<Tone, CSSProperties> = {
  ok: { background: "#e3f4e6", color: "#1b6b2c" },
  busy: { background: "#e6effa", color: "#0b5cad" },
  warn: { background: "#fff1d6", color: "#8a5a00" },
  error: { background: "#fde4e4", color: "#b00020" },
  off: { background: "#eee", color: "#666" },
};

const sectionTitle: CSSProperties = { fontSize: 14, margin: "0 0 8px", color: "#444" };
const note: CSSProperties = { fontSize: 12, color: "#666", margin: "0 0 8px" };
const badge: CSSProperties = {
  marginLeft: 6,
  padding: "1px 6px",
  fontSize: 11,
  borderRadius: 8,
  background: "#e6effa",
  color: "#0b5cad",
};
const stateBadge: CSSProperties = { padding: "2px 8px", fontSize: 12, borderRadius: 8 };
const btn: CSSProperties = { marginLeft: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" };
const fieldset: CSSProperties = { border: "1px solid #dde3ea", borderRadius: 6, margin: "0 0 8px", padding: "6px 10px" };
const legend: CSSProperties = { fontSize: 12, color: "#555", padding: "0 4px" };
const radioRow: CSSProperties = { display: "flex", gap: 8, alignItems: "flex-start", margin: "4px 0", fontSize: 13 };
const cacheBox: CSSProperties = { border: "1px solid #e3e8ee", borderRadius: 6, padding: "8px 10px", margin: "8px 0", background: "#fafbfc" };
const h4: CSSProperties = { fontSize: 13, margin: "0 0 6px", color: "#444" };
const barTrack: CSSProperties = { height: 8, background: "#e8ecf1", borderRadius: 4, margin: "4px 0", overflow: "hidden" };
const barFill: CSSProperties = { height: "100%", borderRadius: 4 };
const warnText: CSSProperties = { fontSize: 12, color: "#8a5a00", margin: "4px 0" };
