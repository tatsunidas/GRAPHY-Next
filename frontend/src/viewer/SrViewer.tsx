/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useState } from "react";
import { fetchSrContent } from "../api";
import { useI18n } from "../i18n/i18n";
import {
  codeLabel,
  formatDicomDate,
  formatDicomTime,
  formatDicomDateTime,
  groupView,
  isMeasurementGroup,
  srToHtml,
  valueText,
  type SrDocument,
  type SrNode,
} from "./srModel";

/**
 * 構造化レポート（SR）の表示。内容の木を、見出し・計測の表・1 行ずつの項目として HTML で出す。
 *
 * <p>**文字は React の要素として描く**（`dangerouslySetInnerHTML` は使わない）。SR は外から取り込んだ入力で、
 * 文字列に `<script>` や `<img onerror=…>` を含みうるが、ここでは文字としてそのまま表示され、実行されない。
 * 節の折りたたみは、ブラウザ標準の `<details>`（状態を持たない）。
 */
export function SrViewer({ studyUid, seriesUid, sopInstanceUid }: { studyUid: string; seriesUid: string; sopInstanceUid: string }) {
  const { t } = useI18n();
  const [doc, setDoc] = useState<SrDocument | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setError(null);
    fetchSrContent(studyUid, seriesUid, sopInstanceUid)
      .then((d) => {
        if (!cancelled) setDoc(d);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [studyUid, seriesUid, sopInstanceUid]);

  const title = useMemo(() => (doc ? codeLabel(doc.root.concept) || t("sr.untitled") : ""), [doc, t]);

  if (error) {
    return (
      <div data-testid="sr-error" style={errorBox}>
        {t("sr.error", { reason: error })}
      </div>
    );
  }
  if (!doc) return <div data-testid="sr-loading" style={muted}>{t("sr.loading")}</div>;

  const h = doc.header;
  const saveHtml = () => {
    const html = srToHtml(doc, title);
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(title || "sr").replace(/[^\p{L}\p{N}._ -]+/gu, "_")}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };
  const when = [formatDicomDate(h.contentDate), formatDicomTime(h.contentTime)].filter((x) => x !== "").join(" ");

  return (
    <article data-testid="sr-viewer" style={page}>
      <header data-testid="sr-header" style={headerBox}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 17, margin: 0 }}>{title}</h2>
          <span style={muted}>{t("sr.items", { n: String(doc.itemCount) })}</span>
          <span style={{ flex: 1 }} />
          <button type="button" data-testid="sr-save-html" onClick={saveHtml} style={btn}>
            {t("sr.saveHtml")}
          </button>
        </div>
        <div style={meta}>
          {[h.sopClassName, h.completionFlag ? t(`sr.completion.${h.completionFlag}`) : null, h.verificationFlag ? t(`sr.verification.${h.verificationFlag}`) : null, when]
            .filter((x): x is string => !!x && x !== "")
            .join(" · ")}
        </div>
        {h.verifiers.map((v, i) => (
          <div key={i} style={meta}>
            {t("sr.verifiedBy")}: {[v.name, v.organization, formatDicomDateTime(v.dateTime)].filter((x) => !!x && x !== "").join(" · ")}
          </div>
        ))}
        {doc.truncated && (
          <div data-testid="sr-truncated" style={warn}>
            {t("sr.truncated", { reason: doc.truncatedReason ?? "" })}
          </div>
        )}
      </header>
      {doc.root.children.length === 0 ? <div style={muted}>{t("sr.empty")}</div> : doc.root.children.map((c, i) => <NodeView key={i} node={c} depth={0} />)}
    </article>
  );
}

function NodeView({ node, depth }: { node: SrNode; depth: number }) {
  const { t } = useI18n();
  if (node.valueType === "CONTAINER") {
    const name = codeLabel(node.concept);
    if (isMeasurementGroup(node)) {
      const { rows, others } = groupView(node);
      return (
        <details open data-testid="sr-group" style={section}>
          <summary style={summary}>{name}</summary>
          <div style={{ paddingLeft: 12 }}>
            {others.map((o, i) => <NodeView key={i} node={o} depth={depth + 1} />)}
            {rows.length > 0 && (
              <table data-testid="sr-group-table" style={table}>
                <thead>
                  <tr>
                    <th style={th}>{t("sr.group.measurement")}</th>
                    <th style={{ ...th, textAlign: "right" }}>{t("sr.group.value")}</th>
                    <th style={th}>{t("sr.group.unit")}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td style={td}>{r.name}</td>
                      <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{r.value}</td>
                      <td style={td}>{r.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </details>
      );
    }
    return (
      <details open={depth < 2} data-testid="sr-container" style={section}>
        <summary style={summary}>{name}</summary>
        <div style={{ paddingLeft: 12 }}>
          {node.children.map((c, i) => <NodeView key={i} node={c} depth={depth + 1} />)}
        </div>
      </details>
    );
  }
  const v = valueText(node);
  return (
    <div data-testid="sr-item" style={row}>
      <span style={name}>{codeLabel(node.concept)}</span>
      {node.valueType === "TEXT" ? <span style={{ whiteSpace: "pre-wrap" }}>{v}</span> : <span>{v}</span>}
    </div>
  );
}

const page: React.CSSProperties = { padding: "10px 14px", font: "13px/1.6 system-ui, sans-serif", color: "#1f2933", background: "#fff", overflow: "auto" };
const headerBox: React.CSSProperties = { borderBottom: "1px solid #d7dde3", paddingBottom: 8, marginBottom: 8 };
const meta: React.CSSProperties = { color: "#5b6773", fontSize: 12, marginTop: 2 };
const muted: React.CSSProperties = { color: "#5b6773", fontSize: 12 };
const warn: React.CSSProperties = { background: "#fff6d6", border: "1px solid #e0c35a", color: "#6b4e00", padding: "6px 8px", marginTop: 6, borderRadius: 3 };
const errorBox: React.CSSProperties = { background: "#fde8e8", border: "1px solid #e0a0a0", color: "#7f1d1d", padding: "8px 10px", margin: 8, borderRadius: 3 };
const btn: React.CSSProperties = { font: "12px system-ui, sans-serif", padding: "3px 10px", border: "1px solid #8a949e", borderRadius: 3, background: "#f6f8fa", cursor: "pointer" };
const section: React.CSSProperties = { margin: "6px 0" };
const summary: React.CSSProperties = { cursor: "pointer", fontWeight: 600, color: "#0b5cad" };
const row: React.CSSProperties = { display: "flex", gap: 8, margin: "2px 0", alignItems: "baseline" };
const name: React.CSSProperties = { color: "#5b6773", minWidth: 140, flex: "0 0 auto" };
const table: React.CSSProperties = { borderCollapse: "collapse", margin: "6px 0", fontSize: 12 };
const th: React.CSSProperties = { border: "1px solid #c9d1d9", background: "#f2f6fa", padding: "3px 8px", textAlign: "left" };
const td: React.CSSProperties = { border: "1px solid #c9d1d9", padding: "3px 8px" };
