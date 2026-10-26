/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 自動取り込み。指定したフォルダを一定間隔で走査し、書き込みが止まったファイルを保管庫へ取り込む。
 * 走査と台帳は backend（standalone のみ）。この画面は設定を保存し、状態を問い合わせて表示する。
 * 原本のファイルは読むだけで、移動も削除もしない。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { useDateFormat, formatClockTime } from "../i18n/dateFormat";
import { fetchImportWatchStatus, scanImportWatchNow } from "./importWatchApi";
import {
  canSave,
  errorKey,
  heldView,
  formFromStatus,
  toSettings,
  type ImportWatchForm,
  type ImportWatchStatus,
} from "./importWatchView";
import { saveSettings } from "./settingsApi";

const STATUS_POLL_MS = 2000;

export function ImportWatchPanel() {
  const { t } = useI18n();
  useDateFormat(); // 書式の設定が変わったら再描画する
  const d = desktop();
  const [status, setStatus] = useState<ImportWatchStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [form, setForm] = useState<ImportWatchForm | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [scanningNow, setScanningNow] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const alive = useRef(true);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const refresh = useCallback(async () => {
    try {
      const s = await fetchImportWatchStatus();
      if (!alive.current) return;
      setStatus(s);
      setUnavailable(false);
      // 入力の途中は、状態の更新で入力欄を巻き戻さない
      setForm((cur) => (cur === null || !dirtyRef.current ? formFromStatus(s) : cur));
    } catch {
      if (alive.current) setUnavailable(true); // web モード（404）または backend に届かない
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  if (unavailable) return <p style={muted}>{t("importWatch.unavailable")}</p>;
  if (!form || !status) return <p style={muted}>…</p>;

  const edit = (patch: Partial<ImportWatchForm>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
    setMessage(null);
  };

  const pick = async () => {
    if (!d?.pickDirectory) return;
    const p = await d.pickDirectory();
    if (p) edit({ folder: p });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveSettings(toSettings(form));
      setDirty(false);
      dirtyRef.current = false;
      setMessage(t("importWatch.saved"));
      await refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSaving(false);
    }
  };

  const scanNow = async () => {
    setScanningNow(true);
    setMessage(null);
    try {
      const s = await scanImportWatchNow();
      if (alive.current) setStatus(s);
    } catch (e) {
      if (alive.current) setMessage(String(e));
    } finally {
      if (alive.current) setScanningNow(false);
    }
  };

  const heldText = (code: string | null): string => {
    const v = heldView(code);
    return v.reasonKey
      ? t(v.key, { reason: t(v.reasonKey, { column: v.column ?? "" }) })
      : t(v.key);
  };

  const err = status.enabled && status.error ? status.error : null;

  return (
    <div data-testid="import-watch-panel">
      <p style={note}>{t("importWatch.intro")}</p>

      <label style={row}>
        <input
          type="checkbox"
          data-testid="import-watch-enabled"
          checked={form.enabled}
          onChange={(e) => edit({ enabled: e.target.checked })}
        />
        <span>{t("importWatch.enable")}</span>
      </label>

      <div style={row}>
        <span style={lbl}>{t("importWatch.folder")}</span>
        <input
          style={{ ...input, flex: 1 }}
          data-testid="import-watch-folder"
          value={form.folder}
          onChange={(e) => edit({ folder: e.target.value })}
        />
        {d?.pickDirectory && (
          <button style={ghostBtn} onClick={() => void pick()}>
            {t("importWatch.pick")}
          </button>
        )}
      </div>

      <div style={row}>
        <span style={lbl}>{t("importWatch.interval")}</span>
        <input
          style={{ ...input, width: 80 }}
          data-testid="import-watch-interval"
          inputMode="numeric"
          value={form.intervalSec}
          onChange={(e) => edit({ intervalSec: e.target.value })}
        />
        <span style={muted}>{t("importWatch.intervalUnit")}</span>
      </div>
      <p style={muted}>{t("importWatch.rule")}</p>

      <p style={note}>{t("importWatch.delivery")}</p>
      <label style={row}>
        <input
          type="checkbox"
          data-testid="import-watch-csv-overwrite"
          checked={form.csvOverwriteDicom}
          onChange={(e) => edit({ csvOverwriteDicom: e.target.checked })}
        />
        <span>{t("importWatch.csvOverwrite")}</span>
      </label>
      <p style={muted}>{t("importWatch.csvOverwrite.warn")}</p>

      <div style={{ ...row, justifyContent: "flex-end" }}>
        {message && <span style={muted}>{message}</span>}
        <button
          style={ghostBtn}
          data-testid="import-watch-scan-now"
          disabled={scanningNow || saving || !status.enabled}
          onClick={() => void scanNow()}
        >
          {t("importWatch.scanNow")}
        </button>
        <button
          style={primaryBtn}
          data-testid="import-watch-save"
          disabled={saving || !canSave(form)}
          onClick={() => void save()}
        >
          {t("importWatch.save")}
        </button>
      </div>

      <h3 style={h3}>{t("importWatch.status")}</h3>
      {err && (
        <div style={errBox} data-testid="import-watch-error">
          {t(errorKey(err))}
          {errorKey(err) === "importWatch.err.unknown" ? ` (${err})` : ""}
        </div>
      )}
      <div style={stats} data-testid="import-watch-stats">
        <span>
          {t("importWatch.lastScan")}:{" "}
          <b data-testid="import-watch-last">
            {status.lastScanAt ? formatClockTime(status.lastScanAt, { seconds: true }) : t("importWatch.never")}
          </b>
        </span>
        <span>
          {t("importWatch.waiting")}: <b data-testid="import-watch-waiting">{status.waiting}</b>
        </span>
        <span>
          {t("importWatch.imported")}: <b data-testid="import-watch-imported">{status.imported}</b>
        </span>
        <span>
          {t("importWatch.skipped")}: <b data-testid="import-watch-skipped">{status.skipped}</b>
        </span>
        <span>
          {t("importWatch.failed")}: <b data-testid="import-watch-failed">{status.failed}</b>
        </span>
        <span>
          {t("importWatch.changed")}: <b data-testid="import-watch-changed">{status.changed}</b>
        </span>
        <span>
          {t("importWatch.held")}: <b data-testid="import-watch-held">{status.held}</b>
        </span>
      </div>
      {status.heldItems.length > 0 && (
        <ul style={heldList} data-testid="import-watch-held-items">
          {status.heldItems.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code>: {heldText(f.error)}
            </li>
          ))}
        </ul>
      )}
      {status.failures.length > 0 && (
        <ul style={failList} data-testid="import-watch-failures">
          {status.failures.map((f) => (
            <li key={f.path}>
              <code>{f.path}</code>
              {f.error ? `: ${f.error}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const note: CSSProperties = { color: "#445", fontSize: 13, margin: "0 0 10px" };
const muted: CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "8px 0" };
const lbl: CSSProperties = { width: 110, fontSize: 13, color: "#223" };
const input: CSSProperties = { border: "1px solid #c5ccd6", borderRadius: 6, padding: "4px 8px", fontSize: 13 };
const h3: CSSProperties = { fontSize: 14, margin: "18px 0 8px", color: "#223" };
const stats: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 16, fontSize: 13 };
const errBox: CSSProperties = {
  color: "#b00020",
  background: "#fdecea",
  border: "1px solid #f3b8b0",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12.5,
  margin: "0 0 8px",
};
const heldList: CSSProperties = { fontSize: 12, color: "#8a5a00", margin: "8px 0", paddingLeft: 18, wordBreak: "break-all" };
const failList: CSSProperties = { fontSize: 12, color: "#8a1f11", margin: "8px 0", paddingLeft: 18, wordBreak: "break-all" };
const ghostBtn: CSSProperties = { background: "transparent", color: "#0b5cad", border: "1px solid #b8d0ea", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 };
const primaryBtn: CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 6, padding: "5px 16px", cursor: "pointer", fontSize: 13 };
