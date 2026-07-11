/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useState } from "react";
import { createReport, deleteReport, listReportsByStudy, type ReportSummary, type Study } from "../api";
import { useI18n } from "../i18n/i18n";

/**
 * 対象スタディのレポート一覧（下書き/確定）をブラウズし、開く/削除する
 * （`fw/report-design.md` §5, R5）。「新規」は新しい下書きを作成して即座に開く
 * （既存の下書き解決とは独立させ、同一スタディに複数レポート＝別 `ReportType` や
 * 将来の addendum を作れるようにする）。
 */
export function ReportManagerDialog({
  open,
  onClose,
  study,
  onOpenReport,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
  onOpenReport: (reportId: string) => void;
  /** 新規作成/削除で件数・状態が変わったときに呼ばれる（StudyList の ●/○ 表示を再取得させる）。 */
  onChanged?: () => void;
}) {
  const { t } = useI18n();
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = () => {
    if (!study) return;
    setError(null);
    listReportsByStudy(study.studyInstanceUid)
      .then(setReports)
      .catch((e: unknown) => setError(String(e)));
  };

  useEffect(() => {
    if (!open || !study) return;
    setReports(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, study?.studyInstanceUid]);

  if (!open) return null;

  const handleNew = async () => {
    if (!study) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createReport({
        patientId: study.patientId,
        studyInstanceUid: study.studyInstanceUid,
        bodyMarkdown: t("report.body.placeholder"),
      });
      onChanged?.();
      onOpenReport(created.id);
    } catch (e) {
      setError(t("report.saveError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (r: ReportSummary) => {
    if (!window.confirm(t("report.deleteConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteReport(r.id);
      reload();
      onChanged?.();
    } catch (e) {
      setError(t("report.deleteError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>
            {t("reportManager.title")}
            {study && (
              <span style={{ fontWeight: 400, color: "#667", fontSize: 13 }}>
                {" "}
                — {study.patientName || study.patientId}
              </span>
            )}
          </span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        <div style={body}>
          {error && <div style={{ color: "#b00020" }}>{error}</div>}
          {!reports && !error && <div>{t("common.loading")}</div>}
          {reports && reports.length === 0 && <div style={{ color: "#666" }}>{t("reportManager.empty")}</div>}

          {reports && reports.length > 0 && (
            <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "2px solid #ddd" }}>
                  <Th>{t("report.field.title")}</Th>
                  <Th>{t("report.field.reportType")}</Th>
                  <Th>{t("field.status")}</Th>
                  <Th>{t("reportManager.updatedAt")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {reports.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #eee" }}>
                    <Td>{r.title || "—"}</Td>
                    <Td>{t(`report.type.${r.reportType}`)}</Td>
                    <Td>{t(`report.status.${r.status}`)}</Td>
                    <Td>{formatDateTime(r.updatedAt)}</Td>
                    <Td>
                      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                        <button style={btn} disabled={busy} onClick={() => onOpenReport(r.id)}>
                          {t("reportManager.open")}
                        </button>
                        {r.status === "DRAFT" && (
                          <button style={dangerBtn} disabled={busy} onClick={() => void handleDelete(r)}>
                            {t("report.delete")}
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div style={footer}>
          <button style={btn} disabled={busy} onClick={() => void handleNew()}>
            {t("reportManager.new")}
          </button>
          <div style={{ flex: 1 }} />
          <button style={btn} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function Th({ children }: { children?: React.ReactNode }) {
  return (
    <th style={{ padding: "6px 10px", color: "#666", fontWeight: 600, whiteSpace: "nowrap" }}>{children}</th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td style={{ padding: "6px 10px" }}>{children}</td>;
}

const overlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.35)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const dialog: React.CSSProperties = {
  width: 720,
  maxWidth: "95vw",
  maxHeight: "80vh",
  background: "#fff",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.3)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  fontFamily: "system-ui, sans-serif",
  color: "#1a1a1a",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "12px 16px",
  borderBottom: "1px solid #eee",
};
const closeBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  fontSize: 16,
  cursor: "pointer",
  color: "#666",
};
const body: React.CSSProperties = { flex: 1, minHeight: 0, overflow: "auto", padding: "12px 16px" };
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const btn: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
const dangerBtn: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #e0b4b4",
  color: "#a02525",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
