/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { importNonDicom, type NonDicomResult, type Study } from "../api";
import { desktop } from "../desktopBridge";
import { useI18n } from "../i18n/i18n";

/** Electron はレンダラの File オブジェクトに絶対パス(`path`)を付与する（standalone のローカル取込用）。 */
function filePath(f: File): string | undefined {
  const p = (f as File & { path?: string }).path;
  return p && p.length > 0 ? p : undefined;
}

const IMAGE_EXT = ["png", "jpg", "jpeg", "bmp", "gif", "tif", "tiff"];
const VIDEO_EXT = ["mp4", "m4v", "mov", "avi", "mpg", "mpeg", "mkv", "webm", "wmv"];

type FileKind = "pdf" | "image" | "video" | "other";

function kindOf(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXT.includes(ext)) return "image";
  if (VIDEO_EXT.includes(ext)) return "video";
  return "other";
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * NonDicomImporter: 非 DICOM（PDF/画像/動画）を DICOM 化して取り込む。
 * 患者/スタディ紐付け（既存スタディに追加 or 新規）＋ファイル選択。standalone のローカル FS 前提。
 * 動画は現状未対応（取込時に skip 表示。将来 ffmpeg 対応, fw 参照）。
 */
export function NonDicomImportDialog({
  open,
  onClose,
  study,
  onImported,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
  onImported?: () => void;
}) {
  const { t } = useI18n();
  const hasDesktop = !!desktop();

  const [target, setTarget] = useState<"existing" | "new">("new");
  const [pid, setPid] = useState("");
  const [pname, setPname] = useState("");
  const [birth, setBirth] = useState("");
  const [sex, setSex] = useState("");
  const [studyDesc, setStudyDesc] = useState("");
  const [accession, setAccession] = useState("");
  const [seriesDesc, setSeriesDesc] = useState("Imported");
  const [paths, setPaths] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<NonDicomResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTarget(study ? "existing" : "new");
    setPid("");
    setPname("");
    setBirth("");
    setSex("");
    setStudyDesc("");
    setAccession("");
    setSeriesDesc("Imported");
    setPaths([]);
    setError(null);
    setResult(null);
  }, [open, study]);

  if (!open) return null;

  // 複数ファイル選択（ファイルのみ）。Electron では File.path で絶対パスを取得する。
  const pickFiles = () => fileInputRef.current?.click();

  const onFilesChosen = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = ""; // 同じファイルを再選択できるようリセット
    if (files.length === 0) return;
    const picked = files.map(filePath).filter((p): p is string => !!p);
    if (picked.length === 0) {
      setError(t("nondicom.pathUnavailable"));
      return;
    }
    setError(null);
    setPaths((prev) => [...new Set([...prev, ...picked])]);
  };

  const removePath = (p: string) => setPaths((prev) => prev.filter((x) => x !== p));

  const effectivePatientId = target === "existing" ? study?.patientId ?? "" : pid;
  const canRun = paths.length > 0 && effectivePatientId.trim() !== "" && !busy;

  const run = async () => {
    if (!canRun) return;
    // 一般画像・PDF・動画が混在している場合は中止して混在させないよう促す（種別ごとに取込）。
    const kinds = new Set(paths.map(kindOf).filter((k) => k !== "other"));
    if (kinds.size > 1) {
      window.alert(t("nondicom.mixed"));
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const req =
        target === "existing" && study
          ? {
              paths,
              patientId: study.patientId,
              patientName: study.patientName ?? "",
              studyInstanceUid: study.studyInstanceUid,
              studyDescription: study.studyDescription ?? "",
              seriesDescription: seriesDesc,
            }
          : {
              paths,
              patientId: pid,
              patientName: pname,
              patientBirthDate: birth,
              patientSex: sex,
              studyDescription: studyDesc,
              accessionNumber: accession,
              seriesDescription: seriesDesc,
            };
      const r = await importNonDicom(req);
      setResult(r);
      if (r.imported > 0) onImported?.();
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("nondicom.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        <div style={bodyStyle}>
          {!hasDesktop && <div style={{ color: "#b00020", marginBottom: 10 }}>{t("nondicom.standaloneOnly")}</div>}

          {/* 紐付け先 */}
          <Section title={t("nondicom.target")}>
            {study && (
              <label style={radio}>
                <input type="radio" checked={target === "existing"} onChange={() => setTarget("existing")} />
                {t("nondicom.target.existing", {
                  name: study.patientName || study.patientId,
                  desc: study.studyDescription || study.studyDate || study.studyInstanceUid,
                })}
              </label>
            )}
            <label style={radio}>
              <input type="radio" checked={target === "new"} onChange={() => setTarget("new")} />
              {t("nondicom.target.new")}
            </label>
          </Section>

          {target === "new" && (
            <Section title={t("nondicom.patient")}>
              <Field label={`${t("field.patientId")} *`}>
                <input value={pid} onChange={(e) => setPid(e.target.value)} style={input} />
              </Field>
              <Field label={t("field.patientName")}>
                <input value={pname} onChange={(e) => setPname(e.target.value)} style={input} />
              </Field>
              <Field label={t("field.birthDate")}>
                <input value={birth} onChange={(e) => setBirth(e.target.value)} placeholder="19800101" style={input} />
              </Field>
              <Field label={t("field.sex")}>
                <select value={sex} onChange={(e) => setSex(e.target.value)} style={input}>
                  <option value="">—</option>
                  <option value="M">M</option>
                  <option value="F">F</option>
                  <option value="O">O</option>
                </select>
              </Field>
              <Field label={t("field.description")}>
                <input value={studyDesc} onChange={(e) => setStudyDesc(e.target.value)} style={input} />
              </Field>
              <Field label={t("main.search.accession")}>
                <input value={accession} onChange={(e) => setAccession(e.target.value)} style={input} />
              </Field>
            </Section>
          )}

          <Section title={t("nondicom.series")}>
            <Field label={t("field.description")}>
              <input value={seriesDesc} onChange={(e) => setSeriesDesc(e.target.value)} style={input} />
            </Field>
          </Section>

          {/* ファイル */}
          <Section title={t("nondicom.files")}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                // 拡張子と MIME ワイルドカードを混在させると Chromium/Electron が拡張子を無視し
                // PDF 等が選べなくなるため、すべて明示的な拡張子で指定する。
                accept=".pdf,.png,.jpg,.jpeg,.bmp,.gif,.tif,.tiff,.mp4,.m4v,.mov,.avi,.mpg,.mpeg,.mkv,.webm,.wmv"
                onChange={onFilesChosen}
                style={{ display: "none" }}
              />
              <button onClick={pickFiles} disabled={!hasDesktop} style={btn}>
                {t("nondicom.pickFiles")}
              </button>
              <span style={{ fontSize: 12, color: "#667" }}>{t("nondicom.supported")}</span>
            </div>
            {paths.length === 0 && <div style={{ color: "#8a98a6", fontSize: 12 }}>{t("nondicom.noFiles")}</div>}
            <div style={fileList}>
              {paths.map((p) => {
                const k = kindOf(p);
                const unsupported = k === "video" || k === "other";
                return (
                  <div key={p} style={fileRow}>
                    <span title={p} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                      {kindIcon(k)} {baseName(p)}
                      {unsupported && (
                        <span style={{ color: "#b07d00", fontSize: 11 }}>
                          {" "}
                          ({k === "video" ? t("nondicom.video.soon") : t("nondicom.unsupported")})
                        </span>
                      )}
                    </span>
                    <button style={removeBtn} onClick={() => removePath(p)} aria-label={t("common.delete")}>
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </Section>

          {error && <div style={{ color: "#b00020", marginTop: 6 }}>{error}</div>}

          {result && (
            <Section title={t("nondicom.result")}>
              <div style={{ fontSize: 13, marginBottom: 6 }}>
                {t("nondicom.result.summary", {
                  imported: result.imported,
                  skipped: result.skipped,
                  failed: result.failed,
                })}
              </div>
              <div style={fileList}>
                {result.files.map((f, i) => (
                  <div key={i} style={{ ...fileRow, color: statusColor(f.status) }}>
                    <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {statusIcon(f.status)} {f.filename}
                      {f.message && <span style={{ color: "#8a98a6", fontSize: 11 }}> — {f.message}</span>}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          )}
        </div>

        <div style={footer}>
          <button onClick={onClose} style={btn}>
            {t("common.close")}
          </button>
          <button
            onClick={run}
            disabled={!canRun}
            style={{
              ...btn,
              background: canRun ? "#0b5cad" : "#9fb6cf",
              color: "#fff",
              cursor: canRun ? "pointer" : "default",
            }}
          >
            {busy ? t("nondicom.running") : t("nondicom.run")}
          </button>
        </div>
      </div>
    </div>
  );
}

function kindIcon(k: FileKind): string {
  return k === "pdf" ? "📄" : k === "image" ? "🖼" : k === "video" ? "🎞" : "❔";
}
function statusIcon(s: string): string {
  return s === "imported" ? "✅" : s === "failed" ? "⛔" : "⚠️";
}
function statusColor(s: string): string {
  return s === "imported" ? "#2e7d32" : s === "failed" ? "#b00020" : "#8a6d00";
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#334", marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "5px 0" }}>
      <div style={{ width: 130, fontSize: 13, color: "#445" }}>{label}</div>
      <div style={{ flex: 1, maxWidth: 320 }}>{children}</div>
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
  width: 680,
  maxWidth: "96vw",
  height: 640,
  maxHeight: "92vh",
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
const bodyStyle: React.CSSProperties = { flex: 1, overflow: "auto", padding: "14px 18px" };
const footer: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const radio: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "4px 0", cursor: "pointer" };
const input: React.CSSProperties = { padding: "5px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, width: "100%", boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const fileList: React.CSSProperties = { maxHeight: 150, overflow: "auto", border: "1px solid #eef1f4", borderRadius: 6 };
const fileRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 8px",
  fontSize: 12,
  borderBottom: "1px solid #f3f5f7",
};
const removeBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#88a", fontSize: 12 };
