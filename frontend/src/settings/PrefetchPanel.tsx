/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 事前取得。診察の前日・当日に、予約一覧（DICOM MWL か RIS の CSV）の患者の過去検査を PACS から
 * 自局へ取り込んでおく。取得と定時実行は backend（standalone のみ）。この画面は設定を保存し、状態を表示する。
 * 取得した検査は、予約日の終わりまで自動削除の対象から外れる。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { desktop } from "../desktopBridge";
import { fetchRemoteAes, type RemoteAe } from "../api";
import { HttpError } from "../http";
import { useI18n } from "../i18n/i18n";
import { useDateFormat, formatClockTime } from "../i18n/dateFormat";
import { fetchPrefetchStatus, previewPrefetchSchedule, runPrefetchNow } from "./prefetchApi";
import { PrefetchLogDialog } from "./PrefetchLogDialog";
import {
  canSave,
  configCodes,
  errorKey,
  formErrors,
  formatDays,
  formFromSettings,
  runStatusColor,
  runStatusKey,
  toSettings,
  type PrefetchForm,
  type PrefetchStatus,
} from "./prefetchView";
import { fetchSettings, saveSettings } from "./settingsApi";

const STATUS_POLL_MS = 3000;

export function PrefetchPanel() {
  const { t } = useI18n();
  useDateFormat(); // 書式の設定が変わったら再描画する
  const d = desktop();
  const [status, setStatus] = useState<PrefetchStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [form, setForm] = useState<PrefetchForm | null>(null);
  const [aes, setAes] = useState<RemoteAe[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [logOpen, setLogOpen] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const s = await fetchPrefetchStatus();
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

  if (unavailable) return <p style={muted}>{t("prefetch.unavailable")}</p>;
  if (!form || !status) return <p style={muted}>…</p>;

  const edit = (patch: Partial<PrefetchForm>) => {
    setForm({ ...form, ...patch });
    setDirty(true);
    setMessage(null);
  };

  const pick = async () => {
    if (!d?.pickDirectory) return;
    const p = await d.pickDirectory();
    if (p) edit({ csvFolder: p });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await saveSettings(toSettings(form));
      setDirty(false);
      setMessage(t("prefetch.saved"));
      await refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await runPrefetchNow();
      await refresh();
    } catch (e) {
      setMessage(e instanceof HttpError && e.status === 409 ? t("prefetch.err.running") : String(e));
    } finally {
      setBusy(false);
    }
  };

  const doPreview = async () => {
    setBusy(true);
    setMessage(null);
    setPreview(null);
    try {
      const r = await previewPrefetchSchedule();
      setPreview(
        r.error
          ? t(errorKey(r.error))
          : Object.entries(r.days)
              .map(([day, n]) => t("prefetch.preview.day", { day: formatDays(day), n: String(n) }))
              .join(" / ") || t("prefetch.preview.none"),
      );
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  };

  // 保存済みの設定でないと、実行も確認もできない（画面の入力は保存するまで backend に届かない）
  const canRun = status.enabled && status.valid && !dirty && !status.running && !busy;
  const errs = formErrors(form);
  const last = status.runs[0];
  const aeOptions = (cur: string) => {
    const names = aes.map((a) => a.aeTitle);
    return cur && !names.includes(cur) ? [cur, ...names] : names;
  };

  return (
    <div data-testid="prefetch-panel">
      <p style={note}>{t("prefetch.intro")}</p>

      <label style={row}>
        <input
          type="checkbox"
          data-testid="prefetch-enabled"
          checked={form.enabled}
          onChange={(e) => edit({ enabled: e.target.checked })}
        />
        <span>{t("prefetch.enable")}</span>
      </label>

      <h3 style={h3}>{t("prefetch.sec.source")}</h3>
      <div style={row}>
        <span style={lbl}>{t("prefetch.source")}</span>
        <select
          style={input}
          data-testid="prefetch-source"
          value={form.source}
          onChange={(e) => edit({ source: e.target.value as PrefetchForm["source"] })}
        >
          <option value="">{t("prefetch.choose")}</option>
          <option value="mwl">{t("prefetch.source.mwl")}</option>
          <option value="csv">{t("prefetch.source.csv")}</option>
        </select>
      </div>

      {form.source === "mwl" && (
        <>
          <div style={row}>
            <span style={lbl}>{t("prefetch.mwl.ae")}</span>
            <select style={input} data-testid="prefetch-mwl-ae" value={form.mwlAe} onChange={(e) => edit({ mwlAe: e.target.value })}>
              <option value="">{t("prefetch.choose")}</option>
              {aeOptions(form.mwlAe).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div style={row}>
            <span style={lbl}>{t("prefetch.mwl.station")}</span>
            <input style={input} data-testid="prefetch-mwl-station" value={form.mwlStation} onChange={(e) => edit({ mwlStation: e.target.value })} />
            <span style={lbl}>{t("prefetch.mwl.modality")}</span>
            <input style={{ ...input, width: 70 }} data-testid="prefetch-mwl-modality" value={form.mwlModality} onChange={(e) => edit({ mwlModality: e.target.value })} />
          </div>
          <p style={muted}>{t("prefetch.mwl.note")}</p>
        </>
      )}

      {form.source === "csv" && (
        <>
          <div style={row}>
            <span style={lbl}>{t("prefetch.csv.folder")}</span>
            <input style={{ ...input, flex: 1 }} data-testid="prefetch-csv-folder" value={form.csvFolder} onChange={(e) => edit({ csvFolder: e.target.value })} />
            {d?.pickDirectory && (
              <button style={ghostBtn} onClick={() => void pick()}>
                {t("prefetch.pick")}
              </button>
            )}
          </div>
          <div style={row}>
            <span style={lbl}>{t("prefetch.csv.charset")}</span>
            <select
              style={input}
              data-testid="prefetch-csv-charset"
              value={form.csvCharset}
              onChange={(e) => edit({ csvCharset: e.target.value as PrefetchForm["csvCharset"] })}
            >
              <option value="">{t("prefetch.choose")}</option>
              <option value="UTF-8">UTF-8</option>
              <option value="Shift_JIS">Shift_JIS</option>
            </select>
          </div>
          <div style={row}>
            <span style={lbl}>{t("prefetch.csv.colId")}</span>
            <input style={input} data-testid="prefetch-csv-col-id" value={form.csvColPatientId} onChange={(e) => edit({ csvColPatientId: e.target.value })} />
            <span style={lbl}>{t("prefetch.csv.colDate")}</span>
            <input style={input} data-testid="prefetch-csv-col-date" value={form.csvColDate} onChange={(e) => edit({ csvColDate: e.target.value })} />
          </div>
          <p style={muted}>{t("prefetch.csv.note")}</p>
        </>
      )}

      <h3 style={h3}>{t("prefetch.sec.schedule")}</h3>
      <div style={row}>
        <span style={lbl}>{t("prefetch.targetDay")}</span>
        <select
          style={input}
          data-testid="prefetch-target-day"
          value={form.targetDay}
          onChange={(e) => edit({ targetDay: e.target.value as PrefetchForm["targetDay"] })}
        >
          <option value="">{t("prefetch.choose")}</option>
          <option value="today">{t("prefetch.targetDay.today")}</option>
          <option value="tomorrow">{t("prefetch.targetDay.tomorrow")}</option>
          <option value="both">{t("prefetch.targetDay.both")}</option>
        </select>
      </div>
      <div style={row}>
        <span style={lbl}>{t("prefetch.times")}</span>
        <input style={{ ...input, width: 160 }} data-testid="prefetch-times" placeholder="07:00, 18:00" value={form.times} onChange={(e) => edit({ times: e.target.value })} />
      </div>
      <label style={row}>
        <input type="checkbox" data-testid="prefetch-catchup" checked={form.catchUp} onChange={(e) => edit({ catchUp: e.target.checked })} />
        <span>{t("prefetch.catchUp")}</span>
      </label>

      <h3 style={h3}>{t("prefetch.sec.retrieve")}</h3>
      <div style={row}>
        <span style={lbl}>{t("prefetch.pacs")}</span>
        <select style={input} data-testid="prefetch-pacs-ae" value={form.pacsAe} onChange={(e) => edit({ pacsAe: e.target.value })}>
          <option value="">{t("prefetch.choose")}</option>
          {aeOptions(form.pacsAe).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span style={lbl}>{t("prefetch.retrieve")}</span>
        <select
          style={input}
          data-testid="prefetch-retrieve"
          value={form.retrieve}
          onChange={(e) => edit({ retrieve: e.target.value as PrefetchForm["retrieve"] })}
        >
          <option value="">{t("prefetch.choose")}</option>
          <option value="move">C-MOVE</option>
          <option value="get">C-GET</option>
        </select>
      </div>
      <p style={muted}>{t("prefetch.retrieve.note")}</p>
      <div style={row}>
        <span style={lbl}>{t("prefetch.years")}</span>
        <input style={{ ...input, width: 60 }} inputMode="numeric" data-testid="prefetch-years" value={form.years} onChange={(e) => edit({ years: e.target.value })} />
        <span style={lbl}>{t("prefetch.modalities")}</span>
        <input style={{ ...input, width: 110 }} data-testid="prefetch-modalities" placeholder="CT, MR" value={form.modalities} onChange={(e) => edit({ modalities: e.target.value })} />
        <span style={lbl}>{t("prefetch.maxStudies")}</span>
        <input style={{ ...input, width: 60 }} inputMode="numeric" data-testid="prefetch-max-studies" value={form.maxStudies} onChange={(e) => edit({ maxStudies: e.target.value })} />
      </div>
      <p style={muted}>{t("prefetch.filter.note")}</p>
      <div style={row}>
        <span style={lbl}>{t("prefetch.timeout")}</span>
        <input style={{ ...input, width: 80 }} inputMode="numeric" data-testid="prefetch-timeout" value={form.timeoutSec} onChange={(e) => edit({ timeoutSec: e.target.value })} />
        <span style={muted}>{t("prefetch.timeoutUnit")}</span>
      </div>

      {errs.length > 0 && (
        <div style={warnBox} data-testid="prefetch-form-errors">
          {errs.map((c) => t(errorKey(c))).join(" / ")}
        </div>
      )}

      <div style={{ ...row, justifyContent: "flex-end" }}>
        {message && <span style={muted}>{message}</span>}
        <button style={ghostBtn} data-testid="prefetch-preview" disabled={!canRun} onClick={() => void doPreview()}>
          {t("prefetch.preview")}
        </button>
        <button style={ghostBtn} data-testid="prefetch-run-now" disabled={!canRun} onClick={() => void runNow()}>
          {t("prefetch.runNow")}
        </button>
        <button style={primaryBtn} data-testid="prefetch-save" disabled={saving || !canSave(form)} onClick={() => void save()}>
          {t("prefetch.save")}
        </button>
      </div>
      {dirty && <p style={muted}>{t("prefetch.unsaved")}</p>}
      {preview && (
        <p style={note} data-testid="prefetch-preview-result">
          {preview}
        </p>
      )}

      <h3 style={h3}>{t("prefetch.status")}</h3>
      {status.enabled && !status.valid && (
        <div style={errBox} data-testid="prefetch-config-error">
          {status.errors.map((c) => t(errorKey(c))).join(" / ")}
        </div>
      )}
      <div style={stats} data-testid="prefetch-stats">
        <span>
          {t("prefetch.running")}: <b data-testid="prefetch-running">{status.running ? t("prefetch.yes") : t("prefetch.no")}</b>
        </span>
        {last && (
          <>
            <span>
              {t("prefetch.last")}:{" "}
              <b data-testid="prefetch-last" style={{ color: runStatusColor(last.status) }}>
                {t(runStatusKey(last.status))}
                {last.finishedAt ? ` (${formatClockTime(last.finishedAt, { seconds: true })})` : ""}
              </b>
            </span>
            <span>
              {t("prefetch.retrieved")}: <b data-testid="prefetch-retrieved">{last.retrieved}</b>
            </span>
            <span>
              {t("prefetch.existing")}: <b>{last.existing}</b>
            </span>
            <span>
              {t("prefetch.failed")}: <b>{last.failed}</b>
            </span>
            <span>
              {t("prefetch.pending")}: <b>{last.pending}</b>
            </span>
          </>
        )}
        {!last && <span>{t("prefetch.never")}</span>}
      </div>
      {last?.error && (
        <div style={errBox} data-testid="prefetch-last-error">
          {t(errorKey(last.error))}
          {configCodes(last.error).length > 0 ? `: ${configCodes(last.error).map((c) => t(errorKey(c))).join(" / ")}` : ""}
        </div>
      )}
      <div style={{ ...row, justifyContent: "flex-end" }}>
        <button style={ghostBtn} data-testid="prefetch-log-open" onClick={() => setLogOpen(true)}>
          {t("prefetch.log")}
        </button>
      </div>
      {logOpen && <PrefetchLogDialog runs={status.runs} onClose={() => setLogOpen(false)} />}
    </div>
  );
}

const note: CSSProperties = { color: "#445", fontSize: 13, margin: "0 0 10px" };
const muted: CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "8px 0", flexWrap: "wrap" };
const lbl: CSSProperties = { minWidth: 110, fontSize: 13, color: "#223" };
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
const warnBox: CSSProperties = { ...errBox, color: "#8a5a00", background: "#fff6e0", border: "1px solid #f0d9a0" };
const ghostBtn: CSSProperties = { background: "transparent", color: "#0b5cad", border: "1px solid #b8d0ea", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 };
const primaryBtn: CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 6, padding: "5px 16px", cursor: "pointer", fontSize: 13 };
