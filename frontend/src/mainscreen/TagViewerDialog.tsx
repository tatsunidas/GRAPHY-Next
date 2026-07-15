/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useState } from "react";
import { fetchInstances, fetchInstanceTags, type Series, type Study, type TagDumpRow } from "../api";
import { useI18n } from "../i18n/i18n";

/**
 * TagViewer（Read only）: MainScreen で表示中の画像（＝選択中シリーズの代表インスタンス）の
 * DICOM 属性ダンプを表示する。GRAPHY の DicomTagsViewer を踏襲。
 *
 * - 列: Tag / Name / VR / Value。
 * - シーケンス(SQ)のネストは深さ分のインデント＋ `>` プレフィックスで表現。
 * - 検索バーで一致箇所をハイライト（フィルタはせず全行表示のまま）。編集不可。
 *
 * 注: 現在のスライス番号は SeriesViewer 内部状態のため、ここでは<b>シリーズ先頭</b>の
 * インスタンスを対象にする（exact-slice 連動は将来課題）。
 */
export function TagViewerDialog({
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
  const [rows, setRows] = useState<TagDumpRow[] | null>(null);
  const [sopUid, setSopUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open || !study || !series) return;
    setRows(null);
    setError(null);
    setSopUid(null);
    setQuery("");
    let cancelled = false;
    (async () => {
      try {
        const insts = await fetchInstances(study.studyInstanceUid, series.seriesInstanceUid);
        if (cancelled) return;
        if (!insts || insts.length === 0) {
          setError(t("tagview.noImage"));
          return;
        }
        const sop = insts[0].sopInstanceUid;
        setSopUid(sop);
        const dump = await fetchInstanceTags(study.studyInstanceUid, series.seriesInstanceUid, sop);
        if (cancelled) return;
        setRows(dump);
      } catch (e) {
        if (!cancelled) setError(t("common.fetchError", { error: String(e) }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, study, series, t]);

  const matchCount = useMemo(() => {
    if (!rows || !query) return 0;
    const q = query.toLowerCase();
    return rows.filter((r) => rowMatches(r, q)).length;
  }, [rows, query]);

  if (!open) return null;

  return (
    <div style={overlay} onClick={onClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("tagview.title")}</span>
          <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {/* 対象画像 + 検索 */}
        <div style={toolbar}>
          <div style={{ fontSize: 12, color: "#556", marginRight: "auto" }}>
            {series?.seriesDescription || series?.modality || ""}
            {sopUid && <span style={{ color: "#8a98a6" }}> · SOP {sopUid}</span>}
          </div>
          <label style={{ fontSize: 13, color: "#445" }}>{t("tagview.search")}</label>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("tagview.search.placeholder")}
            style={searchInput}
            autoFocus
          />
          {query && (
            <span style={{ fontSize: 12, color: "#556" }}>{t("tagview.matches", { count: matchCount })}</span>
          )}
        </div>

        <div style={tableWrap}>
          {!rows && !error && <div style={{ padding: 14, color: "#888" }}>{t("common.loading")}</div>}
          {error && <div style={{ padding: 14, color: "#b00020" }}>{error}</div>}
          {rows && (
            <table style={table}>
              <thead>
                <tr>
                  <Th w={170}>{t("tagview.col.tag")}</Th>
                  <Th w={260}>{t("tagview.col.name")}</Th>
                  <Th w={46}>{t("tagview.col.vr")}</Th>
                  <Th>{t("tagview.col.value")}</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
                  const hit = !!query && rowMatches(r, query.toLowerCase());
                  return (
                    <tr key={i} style={{ background: hit ? "#fffbe6" : i % 2 ? "#fafbfc" : "#fff" }}>
                      <Td mono>
                        <span style={{ paddingLeft: r.depth * 16 }}>
                          {r.depth > 0 && <span style={{ color: "#b0b8c0" }}>{">".repeat(r.depth)} </span>}
                          <Highlight text={r.tag} q={query} />
                        </span>
                      </Td>
                      <Td>
                        <Highlight text={r.name} q={query} />
                      </Td>
                      <Td mono>
                        <Highlight text={r.vr} q={query} />
                      </Td>
                      <Td mono>
                        <Highlight text={r.value} q={query} />
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={footer}>
          <span style={{ fontSize: 12, color: "#667" }}>
            {rows ? t("tagview.rowCount", { count: rows.length }) : ""}
          </span>
          <button onClick={onClose} style={btn}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function rowMatches(r: TagDumpRow, qLower: string): boolean {
  return (
    r.tag.toLowerCase().includes(qLower) ||
    r.name.toLowerCase().includes(qLower) ||
    r.vr.toLowerCase().includes(qLower) ||
    r.value.toLowerCase().includes(qLower)
  );
}

/** text 内の q 一致部分を <mark> でハイライト（大文字小文字無視）。 */
function Highlight({ text, q }: { text: string; q: string }) {
  if (!q || !text) return <>{text}</>;
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  const parts: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  for (;;) {
    const idx = lower.indexOf(ql, i);
    if (idx < 0) {
      parts.push(text.slice(i));
      break;
    }
    if (idx > i) parts.push(text.slice(i, idx));
    parts.push(
      <mark key={key++} style={markStyle}>
        {text.slice(idx, idx + ql.length)}
      </mark>,
    );
    i = idx + ql.length;
  }
  return <>{parts}</>;
}

function Th({ children, w }: { children: React.ReactNode; w?: number }) {
  return (
    <th
      style={{
        position: "sticky",
        top: 0,
        background: "#eef2f6",
        textAlign: "left",
        padding: "6px 10px",
        fontWeight: 600,
        fontSize: 12,
        color: "#445",
        borderBottom: "1px solid #d6dde4",
        width: w,
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      style={{
        padding: "3px 10px",
        verticalAlign: "top",
        fontFamily: mono ? "ui-monospace, monospace" : undefined,
        fontSize: 12,
        wordBreak: "break-all",
      }}
    >
      {children}
    </td>
  );
}

const markStyle: React.CSSProperties = { background: "#ffe27a", color: "inherit", padding: 0 };
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
  width: 900,
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
const toolbar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 16px",
  borderBottom: "1px solid #eef1f4",
};
const tableWrap: React.CSSProperties = { flex: 1, overflow: "auto" };
const table: React.CSSProperties = { borderCollapse: "collapse", width: "100%", tableLayout: "fixed" };
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const searchInput: React.CSSProperties = {
  padding: "5px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  fontSize: 13,
  width: 240,
};
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
