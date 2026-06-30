/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useState } from "react";
import { extractTags, fetchTagInfo, type Study, type Series } from "../api";
import { useI18n } from "../i18n/i18n";

/** 選択中タグ（番号＋解決済みキーワード/VR）。 */
interface TagItem {
  tag: string; // 8 桁 hex（大文字）
  keyword: string;
  vr: string;
}

/** よく使うタグのプリセット（クイック追加用）。 */
const PRESET_TAGS = [
  "00100020", // PatientID
  "00100010", // PatientName
  "00100030", // PatientBirthDate
  "00100040", // PatientSex
  "00080020", // StudyDate
  "00081030", // StudyDescription
  "00080050", // AccessionNumber
  "00080060", // Modality
  "00200011", // SeriesNumber
  "0008103E", // SeriesDescription
  "00200013", // InstanceNumber
  "00180050", // SliceThickness
  "00180060", // KVP
  "00080070", // Manufacturer
];

/**
 * TagExtractor: 選択スタディ（または絞り込んだシリーズ）から指定タグ群を CSV/JSON で一括抽出する。
 * backend `/api/extract/tags` を叩き、返ってきたファイルをブラウザ/Electron でダウンロードする。
 */
export function TagExtractorDialog({
  open,
  onClose,
  study,
  series,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
  series: Series | null;
}) {
  const { t } = useI18n();
  const [tags, setTags] = useState<TagItem[]>([]);
  const [input, setInput] = useState("");
  const [scope, setScope] = useState<"study" | "series">("study");
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const addTag = async (raw: string) => {
    const hex = raw.replace(/[^0-9A-Fa-f]/g, "").toUpperCase();
    if (hex.length !== 8) {
      setError(t("tagext.error.invalidTag", { tag: raw }));
      return;
    }
    if (tags.some((x) => x.tag === hex)) {
      setInput("");
      return; // 重複は無視
    }
    setError(null);
    try {
      const info = await fetchTagInfo(hex);
      setTags((prev) => [...prev, { tag: hex, keyword: info.keyword, vr: info.vr }]);
      setInput("");
    } catch {
      // 解決に失敗してもタグ自体は追加できる
      setTags((prev) => [...prev, { tag: hex, keyword: "", vr: "" }]);
      setInput("");
    }
  };

  const removeTag = (tag: string) => setTags((prev) => prev.filter((x) => x.tag !== tag));

  const run = async () => {
    if (!study || tags.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { blob, filename } = await extractTags({
        studyUid: study.studyInstanceUid,
        seriesUid: scope === "series" && series ? series.seriesInstanceUid : undefined,
        tags: tags.map((x) => x.tag),
        format,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
    }
  };

  const presetAvailable = PRESET_TAGS.filter((p) => !tags.some((x) => x.tag === p));

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("tagext.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 18px" }}>
          {!study ? (
            <div style={{ color: "#b00020" }}>{t("tagext.noStudy")}</div>
          ) : (
            <>
              {/* スコープ */}
              <Section title={t("tagext.scope")}>
                <div style={{ fontSize: 13, color: "#445", marginBottom: 8 }}>
                  {study.patientName || study.patientId} / {study.studyDate || "—"} /{" "}
                  {study.studyDescription || "—"}
                </div>
                <label style={radio}>
                  <input
                    type="radio"
                    checked={scope === "study"}
                    onChange={() => setScope("study")}
                  />
                  {t("tagext.scope.study", { count: study.numberOfInstances })}
                </label>
                <label style={{ ...radio, opacity: series ? 1 : 0.5 }}>
                  <input
                    type="radio"
                    checked={scope === "series"}
                    disabled={!series}
                    onChange={() => setScope("series")}
                  />
                  {series
                    ? t("tagext.scope.series", {
                        name: series.seriesDescription || series.modality || series.seriesInstanceUid,
                        count: series.numberOfInstances,
                      })
                    : t("tagext.scope.noSeries")}
                </label>
              </Section>

              {/* タグ選択 */}
              <Section title={t("tagext.tags")}>
                <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                  <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && addTag(input)}
                    placeholder={t("tagext.tags.placeholder")}
                    style={textInput}
                  />
                  <button onClick={() => addTag(input)} style={btn}>
                    {t("common.add")}
                  </button>
                </div>

                {tags.length === 0 && (
                  <div style={{ color: "#8a98a6", fontSize: 12, marginBottom: 8 }}>
                    {t("tagext.tags.empty")}
                  </div>
                )}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  {tags.map((x) => (
                    <span key={x.tag} style={chip}>
                      <b>{x.keyword || `(${x.tag})`}</b>
                      <span style={{ color: "#8a98a6", fontSize: 11 }}>
                        {x.tag}
                        {x.vr ? ` ${x.vr}` : ""}
                      </span>
                      <button style={chipX} onClick={() => removeTag(x.tag)} aria-label={t("common.delete")}>
                        ✕
                      </button>
                    </span>
                  ))}
                </div>

                {presetAvailable.length > 0 && (
                  <div>
                    <div style={{ fontSize: 12, color: "#667", marginBottom: 4 }}>{t("tagext.presets")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {presetAvailable.map((p) => (
                        <button key={p} onClick={() => addTag(p)} style={presetBtn}>
                          + {p}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </Section>

              {/* 出力形式 */}
              <Section title={t("tagext.format")}>
                <label style={radio}>
                  <input type="radio" checked={format === "csv"} onChange={() => setFormat("csv")} />
                  CSV
                </label>
                <label style={radio}>
                  <input type="radio" checked={format === "json"} onChange={() => setFormat("json")} />
                  JSON
                </label>
              </Section>

              {error && <div style={{ color: "#b00020", marginTop: 8 }}>{error}</div>}
            </>
          )}
        </div>

        <div style={footer}>
          <button onClick={onClose} style={btn}>
            {t("common.close")}
          </button>
          <button
            onClick={run}
            disabled={busy || !study || tags.length === 0}
            style={{
              ...btn,
              background: busy || !study || tags.length === 0 ? "#9fb6cf" : "#0b5cad",
              color: "#fff",
              cursor: busy || !study || tags.length === 0 ? "default" : "pointer",
            }}
          >
            {busy ? t("tagext.running") : t("tagext.export")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#334", marginBottom: 8 }}>{title}</div>
      {children}
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
  width: 620,
  maxWidth: "94vw",
  height: 600,
  maxHeight: "90vh",
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
const footer: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 16px",
  borderTop: "1px solid #eee",
};
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const textInput: React.CSSProperties = { padding: "6px 8px", border: "1px solid #cdd5de", borderRadius: 6, fontSize: 13, flex: 1, boxSizing: "border-box" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
const radio: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 13, margin: "4px 0", cursor: "pointer" };
const chip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "3px 6px 3px 10px",
  border: "1px solid #cdd9e6",
  borderRadius: 14,
  background: "#f2f7fc",
  fontSize: 12,
};
const chipX: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", color: "#88a", fontSize: 12, padding: 0 };
const presetBtn: React.CSSProperties = { padding: "2px 8px", border: "1px dashed #c2cdd8", borderRadius: 12, background: "#fff", cursor: "pointer", fontSize: 11, color: "#456" };
