/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** 削除の記録（新しい順）。自動削除の設定とメイン画面の知らせから開く。 */
import { useEffect, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchRetentionEvents } from "./retentionApi";
import { formatBytes, formatTime, reasonKey, resultColor, resultKey, type RetentionEvent } from "./retentionView";

export function RetentionLogDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const [events, setEvents] = useState<RetentionEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    fetchRetentionEvents()
      .then((e) => !stop && setEvents(e))
      .catch((e) => !stop && setError(String(e)));
    return () => {
      stop = true;
    };
  }, []);

  return (
    <div style={overlay} role="dialog" aria-modal="true" data-testid="retention-log">
      <div style={dialog}>
        <h3 style={{ margin: "0 0 8px" }}>{t("retention.log")}</h3>
        {error && <p style={{ color: "#b00020", fontSize: 12 }}>{error}</p>}
        {!events && !error && <p style={muted}>…</p>}
        {events && events.length === 0 && <p style={muted}>{t("retention.log.empty")}</p>}
        {events && events.length > 0 && (
          <div style={{ maxHeight: 360, overflow: "auto" }}>
            <table style={table} data-testid="retention-log-table">
              <thead>
                <tr>
                  <th>{t("retention.col.at")}</th>
                  <th>{t("retention.col.patient")}</th>
                  <th>{t("retention.col.studyDate")}</th>
                  <th>{t("retention.col.modality")}</th>
                  <th>{t("retention.col.size")}</th>
                  <th>{t("retention.col.reason")}</th>
                  <th>{t("retention.col.result")}</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} data-result={e.result}>
                    <td>{formatTime(e.at)}</td>
                    <td>{e.patientName || e.patientId || ""}</td>
                    <td>{e.studyDate ?? ""}</td>
                    <td>{e.modality ?? ""}</td>
                    <td style={{ textAlign: "right" }}>{formatBytes(e.sizeBytes)}</td>
                    <td>{e.reason ? t(reasonKey(e.reason)) : ""}</td>
                    <td style={{ color: resultColor(e.result), fontWeight: 600 }}>
                      {t(resultKey(e.result))}
                      {e.failedFiles > 0 ? ` (${e.failedFiles})` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div style={{ textAlign: "right", marginTop: 10 }}>
          <button data-testid="retention-log-close" onClick={onClose} style={{ fontSize: 12 }}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

const muted: CSSProperties = { color: "#889", fontSize: 12, margin: "4px 0" };
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
const dialog: CSSProperties = { background: "#fff", borderRadius: 8, padding: 18, width: 820, maxWidth: "94vw", boxShadow: "0 8px 32px rgba(0,0,0,0.3)" };
