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
import { desktop, type GdriveDesktopStatus } from "../desktopBridge";
import { fetchGdriveRestore, fetchGdriveStatus, gdriveSyncNow, gdriveTakeOver } from "./gdriveApi";
import {
  actionErrorKey,
  canSyncNow,
  canTakeOver,
  needsSignIn,
  restorePercent,
  stateView,
  type GdriveRestoreProgress,
  type GdriveSyncStatus,
  type Tone,
} from "./gdriveView";

const STATUS_POLL_MS = 4000;
const RESTORE_POLL_MS = 1000;

export function GdrivePanel() {
  const { t } = useI18n();
  const d = desktop();
  const [ds, setDs] = useState<GdriveDesktopStatus | null>(null);
  const [sync, setSync] = useState<GdriveSyncStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restore, setRestore] = useState<GdriveRestoreProgress | null>(null);
  const [restoredFolder, setRestoredFolder] = useState<string | null>(null);
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
      const r = await d.gdriveEnable!();
      if (!r.ok && !r.canceled) failure(r.error);
    });

  const disable = () =>
    run("disable", async () => {
      const r = await d.gdriveDisable!();
      if (!r.ok && !r.canceled) failure(r.error);
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
      const r = await d.gdriveRestore!(t("settings.gdrive.restore.dialogTitle"));
      if (!r.ok) {
        if (!r.canceled) failure(r.error);
        return;
      }
      setRestoredFolder(r.folder);
      setRestore({ phase: "RUNNING", total: 0, done: 0, skipped: 0, snapshotRestored: false, error: null });
    });

  const view = stateView(enabled ? sync : null);
  const percent = restorePercent(restore);

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
          <div>
            <button style={btn} disabled={!!busy || !canSyncNow(sync)} onClick={syncNow}>
              {t("settings.gdrive.syncNow")}
            </button>
            {canTakeOver(sync) && (
              <button style={btn} disabled={!!busy} onClick={takeOver}>
                {t("settings.gdrive.takeover")}
              </button>
            )}
            <button style={btn} disabled={!!busy} onClick={disable}>
              {t("settings.gdrive.disable")}
            </button>
          </div>
        </div>
      )}

      {ds?.configured && ds.signedIn && ds.pickerReady && (
        <div data-testid="gdrive-restore" style={{ marginTop: 14 }}>
          <h4 style={{ fontSize: 13, margin: "0 0 4px", color: "#444" }}>{t("settings.gdrive.restore.title")}</h4>
          <p style={note}>{t("settings.gdrive.restore.help")}</p>
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
              <div>{t("settings.gdrive.restore.done", { done: restore.done })}</div>
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

function formatTime(ms: number | null, none: string): string {
  return ms ? new Date(ms).toLocaleString() : none;
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
