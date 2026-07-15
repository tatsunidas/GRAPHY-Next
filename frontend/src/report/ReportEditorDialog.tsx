/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import {
  createReport,
  deleteReport,
  finalizeReport,
  getReport,
  listReportsByStudy,
  lockReport,
  unlockReport,
  updateReport,
  type ReportDetail,
  type ReportKeyImageInput,
  type ReportParticipantInput,
  type ReportType,
  type Series,
  type Study,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { KeyImageGrid } from "./KeyImageGrid";
import { MarkdownEditor } from "./MarkdownEditor";
import { ParticipantsPanel } from "./ParticipantsPanel";
import { resolveDefaultReportType } from "./reportDefaults";
import type { ViewerMode } from "../viewer/imageId";

const REPORT_TYPES: ReportType[] = ["GENERAL", "IMAGING_DIAGNOSTIC", "TECHNOLOGIST", "MEASUREMENT"];
const EDITOR_NAME_KEY = "graphy.report.editorName";

/**
 * レポート編集ダイアログ。開くと対象スタディの下書きレポートを解決（無ければ既存の最新レポート、
 * それも無ければ新規下書きを作成）し、Markdown 本文・参加者・キー画像を編集できる
 * （`fw/report-design.md` §5, R4）。
 *
 * 認証は無いため「編集者名」はローカル入力（localStorage 保持）で、編集ロック（`lock`/`unlock`）の
 * 名義として使う。ロックが他名義で有効な間は読み取り専用。
 */
export function ReportEditorDialog({
  open,
  onClose,
  study,
  series,
  mode,
  reportId,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
  series: Series | null;
  /** キー画像サムネイル取得の imageId 組み立てに使う（standalone/web）。 */
  mode: ViewerMode;
  /** 指定時はスタディの最新/下書き解決ではなく、この ID のレポートを直接開く（ReportManagerDialog から）。 */
  reportId?: string | null;
  /** 新規作成/確定/削除で状態が変わったときに呼ばれる（StudyList の ●/○ 表示を再取得させる）。 */
  onChanged?: () => void;
}) {
  const { t } = useI18n();

  const [editorName, setEditorName] = useState<string>(() => {
    try {
      return localStorage.getItem(EDITOR_NAME_KEY) ?? "";
    } catch {
      return "";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(EDITOR_NAME_KEY, editorName);
    } catch {
      // localStorage 不可でも動作は継続
    }
  }, [editorName]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReportDetail | null>(null);

  const [title, setTitle] = useState("");
  const [reportType, setReportType] = useState<ReportType>("GENERAL");
  const [clinicalHistory, setClinicalHistory] = useState("");
  const [referringPhysician, setReferringPhysician] = useState("");
  const [bodyMarkdown, setBodyMarkdown] = useState("");
  const [participants, setParticipants] = useState<ReportParticipantInput[]>([]);
  const [keyImages, setKeyImages] = useState<ReportKeyImageInput[]>([]);

  const loadedIdRef = useRef<string | null>(null);

  const applyDetail = (d: ReportDetail) => {
    setReport(d);
    if (loadedIdRef.current !== d.id) {
      loadedIdRef.current = d.id;
      setTitle(d.title ?? "");
      setReportType(d.reportType);
      setClinicalHistory(d.clinicalHistory ?? "");
      setReferringPhysician(d.referringPhysician ?? "");
      setBodyMarkdown(d.bodyMarkdown);
      setParticipants(
        d.participants.map((p) => ({
          name: p.name,
          staffRole: p.staffRole,
          participationType: p.participationType,
          organization: p.organization,
        })),
      );
      setKeyImages(
        d.keyImages.map((k) => ({
          sopInstanceUid: k.sopInstanceUid,
          seriesInstanceUid: k.seriesInstanceUid,
          frameNumber: k.frameNumber,
          label: k.label,
          annotation: k.annotation,
          sortOrder: k.sortOrder,
        })),
      );
    }
  };

  useEffect(() => {
    if (!open || !study) return;
    let cancelled = false;
    loadedIdRef.current = null;
    setReport(null);
    setError(null);
    setLoading(true);
    (async () => {
      try {
        let detail: ReportDetail;
        if (reportId) {
          // ReportManagerDialog から特定のレポートを直接開く。
          detail = await getReport(reportId);
        } else {
          const summaries = await listReportsByStudy(study.studyInstanceUid);
          const draft = summaries.find((s) => s.status === "DRAFT");
          const target = draft ?? summaries[0];
          if (target) {
            detail = await getReport(target.id);
          } else {
            detail = await createReport({
              patientId: study.patientId,
              studyInstanceUid: study.studyInstanceUid,
              bodyMarkdown: t("report.body.placeholder"),
              reportType: await resolveDefaultReportType(),
            });
            onChanged?.();
          }
        }
        if (cancelled) return;
        applyDetail(detail);
        if (detail.status === "DRAFT" && editorName.trim()) {
          try {
            const locked = await lockReport(detail.id, editorName.trim());
            if (!cancelled) setReport(locked);
          } catch {
            // 他ユーザーが編集中: readOnly 判定へ委ねる
          }
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, study?.studyInstanceUid, reportId]);

  if (!open) return null;

  const handleClose = () => {
    if (report && report.status === "DRAFT" && editorName.trim() && report.lockedBy === editorName.trim()) {
      void unlockReport(report.id, editorName.trim()).catch(() => {
        // クローズ時のアンロック失敗は無視（サーバー側のタイムアウトで解消される）
      });
    }
    onClose();
  };

  const saveInternal = async (): Promise<ReportDetail> => {
    if (!report) throw new Error("no report");
    return updateReport(report.id, {
      title,
      bodyMarkdown,
      clinicalHistory,
      referringPhysician,
      participants,
      keyImages,
      editedBy: editorName.trim() || undefined,
    });
  };

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    try {
      const updated = await saveInternal();
      applyDetail(updated);
    } catch (e) {
      setError(t("report.saveError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const handleFinalize = async () => {
    if (!report) return;
    if (!window.confirm(t("report.finalizeConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await saveInternal();
      const finalized = await finalizeReport(report.id);
      applyDetail(finalized);
      onChanged?.();
    } catch (e) {
      setError(t("report.finalizeError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    if (!report) return;
    if (!window.confirm(t("report.deleteConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      await deleteReport(report.id);
      onChanged?.();
      onClose();
    } catch (e) {
      setError(t("report.deleteError", { error: String(e) }));
      setBusy(false);
    }
  };

  const lockedByOther = !!report?.lockedBy && report.lockedBy !== editorName.trim();
  const readOnly = !report || report.status !== "DRAFT" || lockedByOther;

  return (
    <div style={overlay} onClick={handleClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>
            {t("report.title")}
            {study && (
              <span style={{ fontWeight: 400, color: "#667", fontSize: 13 }}>
                {" "}
                — {study.patientName || study.patientId}
              </span>
            )}
          </span>
          <button style={closeBtn} onClick={handleClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {loading && <div style={{ padding: 16 }}>{t("common.loading")}</div>}
        {error && <div style={{ color: "#b00020", padding: "8px 16px" }}>{error}</div>}

        {!loading && report && (
          <div style={body}>
            {report.status !== "DRAFT" && (
              <div style={noticeBar}>{t("report.readOnlyFinal")}</div>
            )}
            {lockedByOther && report.status === "DRAFT" && (
              <div style={noticeBar}>{t("report.lockedByOther", { who: report.lockedBy ?? "" })}</div>
            )}
            {report.status !== "DRAFT" && (
              <div style={infoBar}>
                {report.srSopInstanceUid && <div>{t("report.sr.info", { sop: report.srSopInstanceUid })}</div>}
                {report.koSopInstanceUid && <div>{t("report.ko.info", { sop: report.koSopInstanceUid })}</div>}
              </div>
            )}

            <div style={fieldsRow}>
              <label style={fieldLabel}>
                {t("report.field.title")}
                <input
                  style={fieldInput}
                  value={title}
                  disabled={readOnly}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label style={{ ...fieldLabel, maxWidth: 220 }}>
                {t("report.field.reportType")}
                <select
                  style={fieldInput}
                  value={reportType}
                  disabled={readOnly}
                  onChange={(e) => setReportType(e.target.value as ReportType)}
                >
                  {REPORT_TYPES.map((rt) => (
                    <option key={rt} value={rt}>
                      {t(`report.type.${rt}`)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div style={fieldsRow}>
              <label style={fieldLabel}>
                {t("report.field.clinicalHistory")}
                <input
                  style={fieldInput}
                  value={clinicalHistory}
                  disabled={readOnly}
                  onChange={(e) => setClinicalHistory(e.target.value)}
                />
              </label>
              <label style={fieldLabel}>
                {t("report.field.referringPhysician")}
                <input
                  style={fieldInput}
                  value={referringPhysician}
                  disabled={readOnly}
                  onChange={(e) => setReferringPhysician(e.target.value)}
                />
              </label>
            </div>

            <div style={bodySection}>
              <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>{t("report.body.label")}</div>
              <div style={editorArea}>
                <MarkdownEditor
                  value={bodyMarkdown}
                  onChange={setBodyMarkdown}
                  placeholder={t("report.body.placeholder")}
                  readOnly={readOnly}
                />
              </div>
            </div>

            <div style={panelsRow}>
              <div style={panelBox}>
                <ParticipantsPanel participants={participants} onChange={setParticipants} readOnly={readOnly} />
              </div>
              <div style={panelBox}>
                <KeyImageGrid
                  keyImages={keyImages}
                  onChange={setKeyImages}
                  selectedSeries={series}
                  studyUid={study?.studyInstanceUid ?? null}
                  mode={mode}
                  readOnly={readOnly}
                />
              </div>
            </div>
          </div>
        )}

        <div style={footer}>
          <label style={editorNameLabel}>
            {t("report.participants.name")}:
            <input
              style={editorNameInput}
              value={editorName}
              onChange={(e) => setEditorName(e.target.value)}
              placeholder={t("report.participants.name")}
            />
          </label>
          <div style={{ flex: 1 }} />
          {report && report.status === "DRAFT" && (
            <button style={dangerBtn} disabled={busy} onClick={() => void handleDelete()}>
              {t("report.delete")}
            </button>
          )}
          <button style={btn} onClick={handleClose}>
            {t("common.close")}
          </button>
          {report && report.status === "DRAFT" && (
            <>
              <button style={btn} disabled={busy || readOnly} onClick={() => void handleSave()}>
                {busy ? t("report.saving") : t("report.save")}
              </button>
              <button
                style={{ ...btn, background: "#0b5cad", color: "#fff" }}
                disabled={busy || readOnly}
                onClick={() => void handleFinalize()}
              >
                {busy ? t("report.finalizing") : t("report.finalize")}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
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
  width: 1040,
  maxWidth: "97vw",
  height: 780,
  maxHeight: "94vh",
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
const body: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  padding: "12px 16px",
  display: "flex",
  flexDirection: "column",
  gap: 10,
};
const noticeBar: React.CSSProperties = {
  padding: "6px 10px",
  background: "#fff6e0",
  border: "1px solid #f0dca0",
  borderRadius: 6,
  fontSize: 12,
  color: "#7a5c00",
};
const infoBar: React.CSSProperties = {
  padding: "6px 10px",
  background: "#eef6ec",
  border: "1px solid #d6e6d0",
  borderRadius: 6,
  fontSize: 11,
  color: "#2e5d27",
  fontFamily: "ui-monospace, monospace",
};
const fieldsRow: React.CSSProperties = { display: "flex", gap: 12 };
const fieldLabel: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 3,
  fontSize: 12,
  color: "#556",
};
const fieldInput: React.CSSProperties = {
  padding: "5px 8px",
  border: "1px solid #d7dde3",
  borderRadius: 5,
  fontSize: 13,
  background: "#fff",
};
const bodySection: React.CSSProperties = { display: "flex", flexDirection: "column", flex: "2 1 260px", minHeight: 220 };
const editorArea: React.CSSProperties = { flex: 1, minHeight: 200 };
const panelsRow: React.CSSProperties = { display: "flex", gap: 16, flexWrap: "wrap" };
const panelBox: React.CSSProperties = { flex: "1 1 380px", minWidth: 320 };
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const editorNameLabel: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#556" };
const editorNameInput: React.CSSProperties = {
  padding: "4px 8px",
  border: "1px solid #d7dde3",
  borderRadius: 5,
  fontSize: 12,
  width: 140,
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
