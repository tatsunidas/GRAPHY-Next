/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** 事前取得の実行の記録（新しい順）。患者名・患者 ID は持たない（件数のみ）。 */
import type { CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import { useDateFormat, formatDateTime } from "../i18n/dateFormat";
import { errorKey, formatDays, runStatusColor, runStatusKey, triggerKey, type PrefetchRun } from "./prefetchView";

export function PrefetchLogDialog({ runs, onClose }: { runs: PrefetchRun[]; onClose: () => void }) {
  const { t } = useI18n();
  useDateFormat(); // 書式の設定が変わったら再描画する
  return (
    <div style={overlay} role="dialog" aria-modal="true" data-testid="prefetch-log">
      <div style={dialog}>
        <h3 style={{ margin: "0 0 8px" }}>{t("prefetch.log")}</h3>
        {runs.length === 0 && <p style={muted}>{t("prefetch.log.empty")}</p>}
        {runs.length > 0 && (
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            <table style={table} data-testid="prefetch-log-table">
              <thead>
                <tr>
                  <th>{t("prefetch.col.at")}</th>
                  <th>{t("prefetch.col.trigger")}</th>
                  <th>{t("prefetch.col.days")}</th>
                  <th>{t("prefetch.col.status")}</th>
                  <th>{t("prefetch.col.patients")}</th>
                  <th>{t("prefetch.retrieved")}</th>
                  <th>{t("prefetch.existing")}</th>
                  <th>{t("prefetch.failed")}</th>
                  <th>{t("prefetch.pending")}</th>
                  <th>{t("prefetch.col.error")}</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} data-status={r.status}>
                    <td>{formatDateTime(r.startedAt, { seconds: true })}</td>
                    <td>{t(triggerKey(r.trigger))}</td>
                    <td>{formatDays(r.targetDays)}</td>
                    <td style={{ color: runStatusColor(r.status), fontWeight: 600 }}>{t(runStatusKey(r.status))}</td>
                    <td style={num}>{r.patients}</td>
                    <td style={num}>{r.retrieved}</td>
                    <td style={num}>{r.existing}</td>
                    <td style={num}>{r.failed}</td>
                    <td style={num}>{r.pending}</td>
                    <td>{r.error ? t(errorKey(r.error)) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ textAlign: "right", marginTop: 10 }}>
          <button data-testid="prefetch-log-close" onClick={onClose} style={{ fontSize: 12 }}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

const muted: CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0" };
const num: CSSProperties = { textAlign: "right" };
const table: CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 12 };
const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 2100,
};
const dialog: CSSProperties = { background: "#fff", borderRadius: 8, padding: 18, width: 900, maxWidth: "94vw", boxShadow: "0 8px 32px rgba(0,0,0,0.3)" };
