/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 電子カルテ連携。電子カルテが「いま開いている患者の ID」を書き出すファイル（CSV か bat）を監視し、
 * ID が変わったら、その患者の過去検査を PACS から取り込み、直近の検査を 2D ビューアで開く。
 * 監視・取り込みは backend（standalone のみ）、自動で開くのは main。この画面は設定を保存し、状態を表示する。
 * ファイルは読むだけで実行しない。患者 ID は、画面には先頭と末尾だけを出す。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { fetchRemoteAes, type RemoteAe } from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";
import { checkEmrFile, fetchEmrStatus } from "./emrApi";
import {
  canSave,
  errorKey,
  fetchErrorKey,
  formErrors,
  formFromSettings,
  toSettings,
  type EmrForm,
  type EmrStatus,
} from "./emrView";
import { fetchSettings, saveSettings } from "./settingsApi";

const STATUS_POLL_MS = 2000;

/** 患者 ID は、先頭と末尾の数文字だけ出す（画面の隅に全文を常に出さない）。 */
export function maskId(id: string): string {
  const n = id.length;
  return n >= 6 ? `${id.slice(0, 2)}…${id.slice(n - 2)}` : `${id.slice(0, 1)}…`;
}

export function EmrPanel() {
  const { t } = useI18n();
  const d = desktop();
  const [status, setStatus] = useState<EmrStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [form, setForm] = useState<EmrForm | null>(null);
  const [aes, setAes] = useState<RemoteAe[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [check, setCheck] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchEmrStatus();
      if (!alive.current) return;
      setStatus(s);
      setUnavailable(false);
    } catch {
      if (alive.current) setUnavailable(true); // web モード（404）または backend に届かない
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    // 設定の読み込みは 1 回だけ（入力の途中を巻き戻さない）
    fetchSettings()
      .then((s) => alive.current && setForm((cur) => cur ?? formFromSettings(s)))
      .catch(() => alive.current && setUnavailable(true));
    fetchRemoteAes()
      .then((a) => alive.current && setAes(a))
      .catch(() => undefined);
    const id = setInterval(() => void refresh(), STATUS_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refresh]);

  if (unavailable) return <p style={muted}>{t("emr.unavailable")}</p>;
  if (!form || !status) return <p style={muted}>…</p>;

  const edit = (patch: Partial<EmrForm>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
    setMessage(null);
    setCheck(null);
  };

  const pick = async () => {
    if (!d?.pickDirectory) return;
    const p = await d.pickDirectory();
    if (p) edit({ path: p });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveSettings(toSettings(form));
      setDirty(false);
      setMessage(t("emr.saved"));
      await refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSaving(false);
    }
  };

  const doCheck = async () => {
    setCheck(null);
    try {
      const r = await checkEmrFile();
      setCheck(r.ok ? t("emr.check.ok", { hint: r.hint ?? "", n: r.length }) : t("emr.check.ng", { reason: t(errorKey(r.error)) }));
    } catch (e) {
      setCheck(String(e));
    }
  };

  const errs = formErrors(form);
  const aeOptions = (cur: string) => {
    const names = aes.map((a) => a.aeTitle);
    return cur && !names.includes(cur) ? [cur, ...names] : names;
  };
  const f = status.fetch;
  const fe = f.error ? fetchErrorKey(f.error) : null;

  return (
    <div data-testid="emr-panel">
      <p style={note}>{t("emr.intro")}</p>

      <label style={row}>
        <input type="checkbox" data-testid="emr-enabled" checked={form.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />
        <span>{t("emr.enable")}</span>
      </label>

      <h3 style={h3}>{t("emr.sec.file")}</h3>
      <div style={row}>
        <span style={lbl}>{t("emr.path")}</span>
        <input style={{ ...input, flex: 1 }} data-testid="emr-path" value={form.path} spellCheck={false} onChange={(e) => edit({ path: e.target.value })} />
        {d?.pickDirectory && (
          <button style={ghostBtn} onClick={() => void pick()}>
            {t("emr.pick")}
          </button>
        )}
      </div>
      <p style={muted}>{t("emr.path.hint")}</p>
      <div style={row}>
        <span style={lbl}>{t("emr.format")}</span>
        <select style={input} data-testid="emr-format" value={form.format} onChange={(e) => edit({ format: e.target.value as EmrForm["format"] })}>
          <option value="">{t("emr.choose")}</option>
          <option value="csv">{t("emr.format.csv")}</option>
          <option value="bat">{t("emr.format.bat")}</option>
          <option value="auto">{t("emr.format.auto")}</option>
        </select>
        <span style={lbl}>{t("emr.charset")}</span>
        <select style={input} data-testid="emr-charset" value={form.charset} onChange={(e) => edit({ charset: e.target.value as EmrForm["charset"] })}>
          <option value="">{t("emr.choose")}</option>
          <option value="UTF-8">UTF-8</option>
          <option value="Shift_JIS">Shift_JIS</option>
        </select>
      </div>
      {form.format !== "bat" && form.format !== "" && (
        <div style={row}>
          <span style={lbl}>{t("emr.csv.column")}</span>
          <input style={{ ...input, width: 160 }} data-testid="emr-csv-column" value={form.csvColumn} onChange={(e) => edit({ csvColumn: e.target.value })} />
          <label style={row}>
            <input type="checkbox" data-testid="emr-csv-header" checked={form.csvHeader} onChange={(e) => edit({ csvHeader: e.target.checked })} />
            <span>{t("emr.csv.header")}</span>
          </label>
        </div>
      )}
      {form.format !== "csv" && form.format !== "" && (
        <div style={row}>
          <span style={lbl}>{t("emr.bat.var")}</span>
          <input style={{ ...input, width: 160 }} data-testid="emr-bat-var" placeholder="PATIENT_ID" value={form.batVar} onChange={(e) => edit({ batVar: e.target.value })} />
        </div>
      )}
      <p style={muted}>{t("emr.file.note")}</p>
      <div style={row}>
        <button style={ghostBtn} data-testid="emr-check" disabled={dirty || !status.enabled || !status.valid} onClick={() => void doCheck()}>
          {t("emr.check")}
        </button>
        {check && <span style={muted} data-testid="emr-check-result">{check}</span>}
        {dirty && <span style={muted}>{t("emr.check.saveFirst")}</span>}
      </div>

      <h3 style={h3}>{t("emr.sec.behavior")}</h3>
      <label style={row}>
        <input type="checkbox" data-testid="emr-auto-open" checked={form.autoOpen} onChange={(e) => edit({ autoOpen: e.target.checked })} />
        <span>{t("emr.autoOpen")}</span>
      </label>
      <p style={muted}>{t("emr.autoOpen.note")}</p>

      <h3 style={h3}>{t("emr.sec.retrieve")}</h3>
      <div style={row}>
        <span style={lbl}>{t("emr.pacs")}</span>
        <select style={input} data-testid="emr-pacs-ae" value={form.pacsAe} onChange={(e) => edit({ pacsAe: e.target.value })}>
          <option value="">{t("emr.choose")}</option>
          {aeOptions(form.pacsAe).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span style={lbl}>{t("emr.retrieve")}</span>
        <select style={input} data-testid="emr-retrieve" value={form.retrieve} onChange={(e) => edit({ retrieve: e.target.value as EmrForm["retrieve"] })}>
          <option value="">{t("emr.choose")}</option>
          <option value="move">C-MOVE</option>
          <option value="get">C-GET</option>
        </select>
      </div>
      <p style={muted}>{t("emr.retrieve.note")}</p>
      <div style={row}>
        <span style={lbl}>{t("emr.years")}</span>
        <input style={{ ...input, width: 60 }} inputMode="numeric" data-testid="emr-years" value={form.years} onChange={(e) => edit({ years: e.target.value })} />
        <span style={lbl}>{t("emr.timeout")}</span>
        <input style={{ ...input, width: 80 }} inputMode="numeric" data-testid="emr-timeout" value={form.timeoutSec} onChange={(e) => edit({ timeoutSec: e.target.value })} />
        <span style={muted}>{t("emr.timeoutUnit")}</span>
      </div>
      <p style={muted}>{t("emr.years.note")}</p>

      {errs.length > 0 && (
        <div style={warnBox} data-testid="emr-form-errors">
          {errs.map((c) => t(errorKey(c))).join(" / ")}
        </div>
      )}
      <div style={{ ...row, justifyContent: "flex-end" }}>
        {message && <span style={muted}>{message}</span>}
        <button style={primaryBtn} data-testid="emr-save" disabled={saving || !dirty || !canSave(form)} onClick={() => void save()}>
          {t("common.save")}
        </button>
      </div>

      <h3 style={h3}>{t("emr.sec.status")}</h3>
      <div style={{ ...row, flexDirection: "column", alignItems: "flex-start", gap: 4 }} data-testid="emr-status">
        <span data-testid="emr-status-file">{t(`emr.status.file.${status.file.state}`)}{status.file.error ? `（${t(errorKey(status.file.error))}）` : ""}</span>
        <span data-testid="emr-status-patient">
          {status.patient ? t("emr.status.patient", { hint: maskId(status.patient.id) }) : t("emr.status.noPatient")}
        </span>
        <span data-testid="emr-status-fetch">
          {t(`emr.status.fetch.${f.state}`, { done: f.retrieved, total: f.found })}
        </span>
        {fe && (
          <div style={errBox} data-testid="emr-fetch-error">
            {t(fe.key)}
          </div>
        )}
      </div>
    </div>
  );
}

const note: CSSProperties = { color: "#445", fontSize: 13, margin: "0 0 10px" };
const muted: CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "8px 0", flexWrap: "wrap" };
const lbl: CSSProperties = { minWidth: 110, fontSize: 13, color: "#223" };
const input: CSSProperties = { border: "1px solid #c5ccd6", borderRadius: 6, padding: "4px 8px", fontSize: 13 };
const h3: CSSProperties = { fontSize: 14, margin: "18px 0 8px", color: "#223" };
const errBox: CSSProperties = {
  color: "#b00020", background: "#fdecea", border: "1px solid #f3b8b0", borderRadius: 6, padding: "6px 10px", fontSize: 12.5, margin: "0 0 8px",
};
const warnBox: CSSProperties = { ...errBox, color: "#8a5a00", background: "#fff6e0", border: "1px solid #f0d9a0" };
const ghostBtn: CSSProperties = { background: "transparent", color: "#0b5cad", border: "1px solid #b8d0ea", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 };
const primaryBtn: CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 6, padding: "5px 16px", cursor: "pointer", fontSize: 13 };
