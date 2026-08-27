/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * モバイルのレポートエディタ（`fw/mobile-ui-design.md` M8・§5.3）。
 *
 * <p>既存の `report/ReportEditorDialog.tsx` は狭幅で使えない: dialog が `width: 1040 / height: 780`
 * 固定、`fieldsRow` / `footer` が `flexWrap` なしで溢れ、`MarkdownEditor` の `panes` が
 * **textarea とプレビューの左右 50/50 固定分割**（375px 幅では各 ~180px でどちらも使えない）。
 * そこで**縦積みではなくタブ切替**にして、textarea に画面の高さをすべて渡す。
 *
 * <p>移植に有利な性質はそのまま活かす: API は `api.ts` に完全分離済みで、エディタは
 * contentEditable ではなく素の `<textarea>` ＋ `react-markdown` プレビュー（リッチテキスト非依存）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createReport,
  finalizeReport,
  getReport,
  listReportsByStudy,
  updateReport,
  type ReportDetail,
  type ReportKeyImageInput,
  type Study,
} from "../api";
import { useI18n } from "../i18n/i18n";

/** 編集者名の保存キー。デスクトップの `report/ReportEditorDialog.tsx` と**同じキー**を使う。 */
const EDITOR_NAME_KEY = "graphy.report.editorName";

/**
 * プレビューの遅延 [ms]。デスクトップの `MarkdownEditor` と同じ値。
 * ⚠️ これは「入力中にタブが応答なしになる」過去バグへの対策。**低スペック端末では 400ms でも
 * 不足する可能性がある**ので実機で確認する（§5.3）。
 */
const PREVIEW_DEBOUNCE_MS = 400;

/** ビューアから引き渡される「いま見ている画像」。 */
export interface PendingKeyImage {
  sopInstanceUid: string;
  seriesInstanceUid: string;
}

export function MobileReportEditor({
  study,
  pendingKeyImages,
  onConsumePending,
}: {
  study: Study;
  /** ビューアの「レポートに添付」で溜まったもの。保存時に本体へ載せる。 */
  pendingKeyImages: PendingKeyImage[];
  onConsumePending: () => void;
}) {
  const { t } = useI18n();
  const [report, setReport] = useState<ReportDetail | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [keyImages, setKeyImages] = useState<PendingKeyImage[]>([]);
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editorName = useMemo(() => {
    try {
      return localStorage.getItem(EDITOR_NAME_KEY) || "";
    } catch {
      return "";
    }
  }, []);

  // スタディの下書きがあれば開き、無ければ空で始める（作成は最初の保存時）。
  useEffect(() => {
    let cancelled = false;
    setStatus(null);
    listReportsByStudy(study.studyInstanceUid)
      .then((list) => {
        const draft = list.find((r) => r.status === "DRAFT");
        if (!draft) return null;
        return getReport(draft.id);
      })
      .then((detail) => {
        if (cancelled || !detail) return;
        setReport(detail);
        setTitle(detail.title ?? "");
        setBody(detail.bodyMarkdown ?? "");
        setKeyImages(
          detail.keyImages.map((k) => ({
            sopInstanceUid: k.sopInstanceUid,
            seriesInstanceUid: k.seriesInstanceUid,
          })),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setStatus(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [study.studyInstanceUid]);

  // ビューアから渡ってきたキー画像を取り込む（重複は入れない）。
  useEffect(() => {
    if (pendingKeyImages.length === 0) return;
    setKeyImages((prev) => {
      const seen = new Set(prev.map((k) => k.sopInstanceUid));
      const merged = [...prev];
      for (const k of pendingKeyImages) {
        if (!seen.has(k.sopInstanceUid)) {
          seen.add(k.sopInstanceUid);
          merged.push(k);
        }
      }
      return merged;
    });
    onConsumePending();
  }, [pendingKeyImages, onConsumePending]);

  // プレビューは入力から切り離してデバウンスする（PREVIEW_DEBOUNCE_MS のコメント参照）。
  const [previewSource, setPreviewSource] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setPreviewSource(body), PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [body]);

  const toKeyImageInputs = useCallback(
    (): ReportKeyImageInput[] =>
      keyImages.map((k, i) => ({
        sopInstanceUid: k.sopInstanceUid,
        seriesInstanceUid: k.seriesInstanceUid,
        sortOrder: i,
      })),
    [keyImages],
  );

  const save = useCallback(async (): Promise<ReportDetail | null> => {
    setBusy(true);
    setStatus(null);
    try {
      let target = report;
      if (!target) {
        target = await createReport({
          patientId: study.patientId,
          studyInstanceUid: study.studyInstanceUid,
          title: title || null,
          bodyMarkdown: body || null,
        });
      }
      const saved = await updateReport(target.id, {
        title: title || null,
        bodyMarkdown: body,
        keyImages: toKeyImageInputs(),
        editedBy: editorName || null,
      });
      setReport(saved);
      setStatus(t("mobile.report.saved"));
      return saved;
    } catch (e: unknown) {
      setStatus(String(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, [report, study, title, body, toKeyImageInputs, editorName, t]);

  /** 確定は不可逆なので確認を挟む。保存してから確定する（未保存の本文を落とさない）。 */
  const finalize = useCallback(async () => {
    if (!window.confirm(t("report.finalizeConfirm"))) return;
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    try {
      const done = await finalizeReport(saved.id);
      setReport(done);
      setStatus(t("mobile.report.finalized"));
    } catch (e: unknown) {
      setStatus(String(e));
    } finally {
      setBusy(false);
    }
  }, [save, t]);

  const readOnly = report?.status === "FINAL";

  return (
    <div style={wrap}>
      <input
        style={titleInput}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={t("report.field.title")}
        readOnly={readOnly}
        data-testid="mobile-report-title"
      />

      <div style={tabRow}>
        <button style={tab === "edit" ? tabOn : tabBtn} onClick={() => setTab("edit")}>
          {t("mobile.report.edit")}
        </button>
        <button style={tab === "preview" ? tabOn : tabBtn} onClick={() => setTab("preview")}>
          {t("mobile.report.preview")}
        </button>
      </div>

      {tab === "edit" ? (
        <textarea
          style={textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={t("report.body.placeholder")}
          readOnly={readOnly}
          data-testid="mobile-report-body"
        />
      ) : (
        <div style={preview} data-testid="mobile-report-preview">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{previewSource || ""}</ReactMarkdown>
        </div>
      )}

      <div style={keyImageBox}>
        <span style={sectionLabel}>
          {t("report.keyImages.title")} ({keyImages.length})
        </span>
        {keyImages.length === 0 && <span style={hint}>{t("mobile.report.attachHint")}</span>}
        {keyImages.map((k) => (
          <div key={k.sopInstanceUid} style={keyImageRow}>
            <span style={keyImageUid}>{k.sopInstanceUid}</span>
            {!readOnly && (
              <button
                style={removeBtn}
                onClick={() => setKeyImages((prev) => prev.filter((p) => p.sopInstanceUid !== k.sopInstanceUid))}
                aria-label={t("common.delete")}
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {status && <p style={statusText}>{status}</p>}

      <div style={footer}>
        <button style={primaryBtn} onClick={() => void save()} disabled={busy || readOnly} data-testid="mobile-report-save">
          {busy ? t("common.saving") : t("common.save")}
        </button>
        <button style={secondaryBtn} onClick={() => void finalize()} disabled={busy || readOnly}>
          {t("report.finalize")}
        </button>
      </div>
    </div>
  );
}

// ── スタイル ──

const wrap: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 10,
  height: "100%",
  minHeight: 0,
};

const titleInput: React.CSSProperties = {
  minHeight: 44,
  padding: "0 12px",
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "#0e1218",
  color: "#e8ecf1",
  // ⚠️ iOS Safari は 16px 未満の入力欄でフォーカス時に自動ズームする。
  fontSize: 16,
};

const tabRow: React.CSSProperties = { display: "flex", gap: 6 };
const tabBtn: React.CSSProperties = {
  flex: 1,
  minHeight: 44,
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#39414d",
  borderRadius: 8,
  background: "transparent",
  color: "#c3cddb",
  fontSize: 13,
  cursor: "pointer",
};
const tabOn: React.CSSProperties = { ...tabBtn, background: "#0b5cad", borderColor: "#2f6db5", color: "#fff" };

const textarea: React.CSSProperties = {
  flex: 1,
  minHeight: 160,
  padding: 12,
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "#0e1218",
  color: "#e8ecf1",
  fontSize: 16, // iOS の自動ズーム回避（上と同じ理由）
  lineHeight: 1.6,
  resize: "none",
};

const preview: React.CSSProperties = {
  flex: 1,
  minHeight: 160,
  padding: 12,
  overflowY: "auto",
  WebkitOverflowScrolling: "touch",
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "#0e1218",
  fontSize: 14,
  lineHeight: 1.7,
};

const keyImageBox: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxHeight: "22%",
  overflowY: "auto",
  padding: 10,
  border: "1px solid #262c35",
  borderRadius: 8,
  background: "#171b22",
};
const sectionLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: "#9fb2c9" };
const hint: React.CSSProperties = { fontSize: 12, color: "#8b9bb0" };
const keyImageRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const keyImageUid: React.CSSProperties = {
  flex: 1,
  fontSize: 11,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#c3cddb",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const removeBtn: React.CSSProperties = {
  minWidth: 44,
  minHeight: 36,
  border: "none",
  background: "transparent",
  color: "#9fb2c9",
  fontSize: 14,
  cursor: "pointer",
};

const statusText: React.CSSProperties = { margin: 0, fontSize: 13, color: "#9fb2c9" };

const footer: React.CSSProperties = { display: "flex", gap: 8 };
const primaryBtn: React.CSSProperties = {
  flex: 1,
  minHeight: 48,
  border: "1px solid #2f6db5",
  borderRadius: 8,
  background: "#0b5cad",
  color: "#fff",
  fontSize: 15,
  cursor: "pointer",
};
const secondaryBtn: React.CSSProperties = {
  flex: 1,
  minHeight: 48,
  border: "1px solid #39414d",
  borderRadius: 8,
  background: "transparent",
  color: "#c3cddb",
  fontSize: 15,
  cursor: "pointer",
};
