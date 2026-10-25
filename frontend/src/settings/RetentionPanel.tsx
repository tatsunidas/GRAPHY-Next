/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 自動削除。条件を入れて「試算」で消える検査を確かめ、確認のうえで有効にする。
 * 判定・削除・保護は backend（standalone のみ）。この画面は条件の保存と状態の表示だけを行い、削除そのものは行わない。
 * 🔴 条件を変えたら試算の結果を捨てる（古い試算で有効にさせない）。有効にできるのは、保存済みの条件で試算した直後だけ。
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { emitDbChanged } from "../dbEvents";
import { useI18n } from "../i18n/i18n";
import { RetentionLogDialog } from "./RetentionLogDialog";
import {
  disableRetention,
  enableRetention,
  fetchRetentionConfig,
  fetchRetentionStatus,
  previewRetention,
  runRetentionNow,
  saveRetentionConfig,
} from "./retentionApi";
import {
  apiErrorKey,
  canApplyForm,
  configFromForm,
  formatBytes,
  formatTime,
  formFromConfig,
  invalidFields,
  lowFreeWarning,
  protectedSummary,
  protectionKey,
  reasonKey,
  sameConfig,
  splitWarnings,
  warningView,
  type RetentionConfig,
  type RetentionForm,
  type RetentionPreview,
  type RetentionStatus,
} from "./retentionView";

const STATUS_POLL_MS = 3000;

export function RetentionPanel() {
  const { t } = useI18n();
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [saved, setSaved] = useState<RetentionConfig | null>(null);
  const [form, setForm] = useState<RetentionForm | null>(null);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const alive = useRef(true);

  const errText = useCallback(
    (e: unknown): string => {
      const m = e instanceof Error ? e.message : String(e);
      const k = apiErrorKey(m);
      return k ? t(k) : m;
    },
    [t],
  );

  const refreshStatus = useCallback(async () => {
    try {
      const s = await fetchRetentionStatus();
      if (!alive.current) return;
      setStatus(s);
      setUnavailable(false);
    } catch {
      if (alive.current) setUnavailable(true); // web モード（404）または backend に届かない
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const c = await fetchRetentionConfig();
        if (!alive.current) return;
        setSaved(c);
        setForm(formFromConfig(c));
      } catch {
        if (alive.current) setUnavailable(true);
      }
      await refreshStatus();
    })();
    const id = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => {
      alive.current = false;
      clearInterval(id);
    };
  }, [refreshStatus]);

  if (unavailable) return <p style={muted}>{t("retention.unavailable")}</p>;
  if (!form || !status || !saved) return <p style={muted}>…</p>;

  const cacheMode = status.cacheMode;
  const bad = invalidFields(form);
  const formCfg = canApplyForm(form) || (!form.daysOn && !form.maxOn && !form.freeOn) ? configFromForm(form) : null;
  const dirty = formCfg == null || !sameConfig(formCfg, saved);
  const savedHasCondition = saved.days != null || saved.maxGb != null || saved.minFreeGb != null;

  const edit = (patch: Partial<RetentionForm>) => {
    setForm({ ...form, ...patch });
    setPreview(null); // 条件を変えたら、見せた試算は無効
    setMessage(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      if (alive.current) setMessage(errText(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = () =>
    run(async () => {
      if (!formCfg) return;
      const c = await saveRetentionConfig(formCfg);
      setSaved(c);
      setForm(formFromConfig(c));
      setPreview(null);
      setMessage(t("retention.saved"));
      await refreshStatus();
    });

  const doPreview = () =>
    run(async () => {
      setPreview(await previewRetention());
    });

  const doEnable = () =>
    run(async () => {
      if (!preview) return;
      setConfirmOpen(false);
      const s = await enableRetention(preview.previewId);
      setStatus(s);
      setMessage(t("retention.enabledMsg"));
    });

  const doDisable = () =>
    run(async () => {
      setStatus(await disableRetention());
      setMessage(t("retention.disabledMsg"));
    });

  const doRunNow = () =>
    run(async () => {
      const r = await runRetentionNow();
      setMessage(
        t("retention.ranMsg", {
          deleted: r.deleted,
          partial: r.partial,
          failed: r.failed,
          skipped: r.skipped,
          size: formatBytes(r.bytesFreed),
        }),
      );
      if (r.deleted + r.partial > 0) emitDbChanged({ reason: "retention" }, { includeSelf: true });
      setPreview(null);
      await refreshStatus();
    });

  const stateText = status.enabled
    ? status.firstRunPending
      ? t("retention.state.onFirst")
      : t("retention.state.on")
    : t("retention.state.off");

  const lastRun = status.lastRun;

  return (
    <div data-testid="retention-panel">
      <div style={warnBox}>{t("retention.warn.irreversible")}</div>
      <p style={muted}>{t("retention.warn.drive")}</p>
      <p style={muted}>{t("retention.warn.files")}</p>
      {cacheMode && (
        <div style={errBox} data-testid="retention-cache-mode">
          {t("retention.cacheMode")}
        </div>
      )}

      <div style={row}>
        <span style={lbl}>{t("retention.state")}</span>
        <b data-testid="retention-state" data-enabled={status.enabled ? "true" : "false"}>
          {stateText}
        </b>
        {status.enabled && (
          <button style={ghostBtn} data-testid="retention-disable" disabled={busy} onClick={() => void doDisable()}>
            {t("retention.disable")}
          </button>
        )}
      </div>

      <h3 style={h3}>{t("retention.conditions")}</h3>
      <p style={muted}>{t("retention.conditions.hint")}</p>
      <label style={row}>
        <input
          type="checkbox"
          data-testid="retention-days-on"
          disabled={cacheMode}
          checked={form.daysOn}
          onChange={(e) => edit({ daysOn: e.target.checked })}
        />
        <span>{t("retention.cond.days.pre")}</span>
        <input
          style={{ ...input, width: 80, ...(bad.includes("days") ? badInput : null) }}
          data-testid="retention-days"
          inputMode="numeric"
          disabled={cacheMode || !form.daysOn}
          value={form.days}
          onChange={(e) => edit({ days: e.target.value })}
        />
        <span>{t("retention.cond.days.post")}</span>
      </label>
      <label style={row}>
        <input
          type="checkbox"
          data-testid="retention-max-on"
          disabled={cacheMode}
          checked={form.maxOn}
          onChange={(e) => edit({ maxOn: e.target.checked })}
        />
        <span>{t("retention.cond.max.pre")}</span>
        <input
          style={{ ...input, width: 90, ...(bad.includes("maxGb") ? badInput : null) }}
          data-testid="retention-max"
          inputMode="decimal"
          disabled={cacheMode || !form.maxOn}
          value={form.maxGb}
          onChange={(e) => edit({ maxGb: e.target.value })}
        />
        <span>{t("retention.cond.max.post")}</span>
      </label>
      <label style={row}>
        <input
          type="checkbox"
          data-testid="retention-free-on"
          disabled={cacheMode}
          checked={form.freeOn}
          onChange={(e) => edit({ freeOn: e.target.checked })}
        />
        <span>{t("retention.cond.free.pre")}</span>
        <input
          style={{ ...input, width: 90, ...(bad.includes("minFreeGb") ? badInput : null) }}
          data-testid="retention-free"
          inputMode="decimal"
          disabled={cacheMode || !form.freeOn}
          value={form.minFreeGb}
          onChange={(e) => edit({ minFreeGb: e.target.value })}
        />
        <span>{t("retention.cond.free.post")}</span>
      </label>
      {bad.length > 0 && <p style={{ ...muted, color: "#b00020" }}>{t("retention.invalid")}</p>}
      {lowFreeWarning(saved.minFreeGb, status.largestStudyBytes) && (
        <p style={{ ...muted, color: "#8a5a00" }} data-testid="retention-low-free">
          {t("retention.lowFree", { largest: formatBytes(status.largestStudyBytes) })}
        </p>
      )}

      <div style={refBox} data-testid="retention-reference">
        <div>
          {t("retention.ref.disk", {
            total: formatBytes(status.diskTotalBytes),
            free: formatBytes(status.diskFreeBytes),
            store: formatBytes(status.storeBytes),
          })}
        </div>
        <div>
          {t("retention.ref.largest", { largest: formatBytes(status.largestStudyBytes), studies: status.studies })}
          {status.maxDailyIntakeBytes != null &&
            ` ／ ${t("retention.ref.intake", { size: formatBytes(status.maxDailyIntakeBytes), days: status.recordedDays })}`}
        </div>
        <div>{t("retention.ref.locked", { n: status.lockedStudies })}</div>
      </div>
      <p style={muted}>{t("retention.protects")}</p>

      <div style={{ ...row, justifyContent: "flex-end" }}>
        {message && (
          <span style={muted} data-testid="retention-message">
            {message}
          </span>
        )}
        <button style={ghostBtn} data-testid="retention-log-open" onClick={() => setLogOpen(true)}>
          {t("retention.log")}
        </button>
        <button
          style={ghostBtn}
          data-testid="retention-run-now"
          disabled={busy || !status.enabled}
          onClick={() => void doRunNow()}
        >
          {t("retention.runNow")}
        </button>
        <button
          style={ghostBtn}
          data-testid="retention-preview"
          disabled={busy || dirty || !savedHasCondition || cacheMode}
          onClick={() => void doPreview()}
        >
          {t("retention.preview")}
        </button>
        <button
          style={primaryBtn}
          data-testid="retention-save"
          disabled={busy || !dirty || formCfg == null || cacheMode}
          onClick={() => void save()}
        >
          {t("retention.save")}
        </button>
      </div>
      {dirty && savedHasCondition && !cacheMode && <p style={muted}>{t("retention.saveFirst")}</p>}
      {status.enabled && <p style={muted}>{t("retention.saveDisables")}</p>}

      {preview && (
        <div style={previewBox} data-testid="retention-preview-result">
          <div data-testid="retention-preview-summary">
            <b>{t("retention.preview.summary", { n: preview.plan.items.length, size: formatBytes(preview.plan.totalBytes) })}</b>
            {protectedSummary(preview.plan.protectedSkips).length > 0 && (
              <span style={muted}>
                {" "}
                （{t("retention.preview.protected")}:{" "}
                {protectedSummary(preview.plan.protectedSkips)
                  .map((p) => `${t(protectionKey(p.code))} ${p.n}`)
                  .join("・")}
                ）
              </span>
            )}
          </div>
          {preview.plan.warnings
            .filter((w) => !w.startsWith("protected:"))
            .map((w) => (
              <div key={w} style={{ ...muted, color: "#8a5a00" }}>
                {t(warningView(w).key)}
              </div>
            ))}
          {preview.plan.items.length === 0 ? (
            <p style={muted}>{t("retention.preview.none")}</p>
          ) : (
            <div style={tableWrap}>
              <table style={table} data-testid="retention-preview-table">
                <thead>
                  <tr>
                    <th>{t("retention.col.patient")}</th>
                    <th>{t("retention.col.studyDate")}</th>
                    <th>{t("retention.col.modality")}</th>
                    <th>{t("retention.col.received")}</th>
                    <th>{t("retention.col.size")}</th>
                    <th>{t("retention.col.reason")}</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.plan.items.map((it) => (
                    <tr key={it.studyUid}>
                      <td>{it.patientName || it.patientId || ""}</td>
                      <td>{it.studyDate ?? ""}</td>
                      <td>{it.modality ?? ""}</td>
                      <td>{formatTime(it.lastReceivedAt)}</td>
                      <td style={{ textAlign: "right" }}>{formatBytes(it.sizeBytes)}</td>
                      <td>{t(reasonKey(it.reason))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ ...row, justifyContent: "flex-end" }}>
            <button style={ghostBtn} data-testid="retention-preview-cancel" onClick={() => setPreview(null)}>
              {t("retention.cancel")}
            </button>
            <button
              style={primaryBtn}
              data-testid="retention-enable"
              disabled={busy || status.enabled || cacheMode}
              onClick={() => setConfirmOpen(true)}
            >
              {t("retention.enable")}
            </button>
          </div>
        </div>
      )}

      {lastRun && (
        <div style={{ ...muted, marginTop: 12 }} data-testid="retention-last-run">
          {t("retention.lastRun", {
            at: formatTime(lastRun.at),
            deleted: lastRun.deleted,
            partial: lastRun.partial,
            failed: lastRun.failed,
            size: formatBytes(lastRun.bytesFreed),
          })}
          {splitWarnings(lastRun.warnings)
            .filter((w) => !w.startsWith("protected:"))
            .map((w) => (
              <span key={w} style={{ color: "#8a5a00" }}>
                {" "}
                ／ {t(warningView(w).key)}
              </span>
            ))}
        </div>
      )}

      {confirmOpen && preview && (
        <div style={overlay} role="dialog" aria-modal="true" data-testid="retention-confirm">
          <div style={dialog}>
            <h3 style={{ margin: "0 0 8px" }}>{t("retention.confirm.title")}</h3>
            <p style={{ fontSize: 13, margin: "0 0 8px" }}>
              {t("retention.confirm.body", { n: preview.plan.items.length, size: formatBytes(preview.plan.totalBytes) })}
            </p>
            <p style={{ ...muted, color: "#b00020" }}>{t("retention.warn.irreversible")}</p>
            <p style={muted}>{t("retention.confirm.later")}</p>
            <div style={{ ...row, justifyContent: "flex-end" }}>
              <button style={ghostBtn} data-testid="retention-confirm-cancel" onClick={() => setConfirmOpen(false)}>
                {t("retention.cancel")}
              </button>
              <button style={dangerBtn} data-testid="retention-confirm-ok" disabled={busy} onClick={() => void doEnable()}>
                {t("retention.confirm.ok")}
              </button>
            </div>
          </div>
        </div>
      )}

      {logOpen && <RetentionLogDialog onClose={() => setLogOpen(false)} />}
    </div>
  );
}

const muted: CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0" };
const row: CSSProperties = { display: "flex", alignItems: "center", gap: 8, margin: "8px 0", flexWrap: "wrap" };
const lbl: CSSProperties = { width: 110, fontSize: 13, color: "#223" };
const input: CSSProperties = { border: "1px solid #c5ccd6", borderRadius: 6, padding: "4px 8px", fontSize: 13 };
const badInput: CSSProperties = { borderColor: "#b00020", background: "#fdecea" };
const h3: CSSProperties = { fontSize: 14, margin: "16px 0 4px", color: "#223" };
const warnBox: CSSProperties = {
  color: "#7a2a00",
  background: "#fff4e5",
  border: "1px solid #f0c48a",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 13,
  margin: "0 0 6px",
};
const errBox: CSSProperties = {
  color: "#b00020",
  background: "#fdecea",
  border: "1px solid #f3b8b0",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12.5,
  margin: "6px 0",
};
const refBox: CSSProperties = {
  background: "#f4f6f9",
  border: "1px solid #dde3ea",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12.5,
  color: "#334",
  margin: "10px 0 6px",
  lineHeight: 1.6,
};
const previewBox: CSSProperties = { border: "1px solid #c5ccd6", borderRadius: 6, padding: 10, marginTop: 10 };
const tableWrap: CSSProperties = { maxHeight: 260, overflow: "auto", margin: "8px 0" };
const table: CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 12 };
const ghostBtn: CSSProperties = { background: "transparent", color: "#0b5cad", border: "1px solid #b8d0ea", borderRadius: 6, padding: "3px 10px", cursor: "pointer", fontSize: 12 };
const primaryBtn: CSSProperties = { background: "#0b5cad", color: "#fff", border: "none", borderRadius: 6, padding: "5px 16px", cursor: "pointer", fontSize: 13 };
const dangerBtn: CSSProperties = { background: "#b00020", color: "#fff", border: "none", borderRadius: 6, padding: "5px 16px", cursor: "pointer", fontSize: 13 };
const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2000,
};
const dialog: CSSProperties = { background: "#fff", borderRadius: 8, padding: 18, maxWidth: 460, boxShadow: "0 8px 32px rgba(0,0,0,0.3)" };
