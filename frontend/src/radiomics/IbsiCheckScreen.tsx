/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * IBSI 照合（別ウィンドウ `#ibsi-check`）。
 *
 * <p>RadiomicsJ が IBSI 1 のデジタルファントムの参照値と一致するかを、この PC・この版で確かめて見せる。
 * 判定・規則・参照値の表は RadiomicsJ のもので、ここでは書き換えない。CT ファントム（構成 C・D）は
 * この PC では実行せず、RadiomicsJ のリリース時の記録を表示する。
 */
import { useEffect, useMemo, useState } from "react";
import { fetchIbsiCheck, fetchIbsiRecords } from "../api";
import { HttpError } from "../http";
import { useI18n } from "../i18n/i18n";
import { useDateFormat, formatDateTime } from "../i18n/dateFormat";
import {
  filterRows, ibsiFileBase, ibsiResultJson, passedOf, summarize,
  type IbsiCheckResult, type IbsiFilter, type IbsiReport, type IbsiRow, type IbsiVerdict,
} from "./ibsiCheck";

const FILTERS: readonly IbsiFilter[] = ["ALL", "FAIL", "PROBLEM", "NOT_JUDGED"];

function download(text: string, filename: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const num = (v: number | null): string => (v == null ? "—" : String(Number(v.toPrecision(6))));

function formatRanAt(iso: string): string {
  return formatDateTime(iso);
}

export function IbsiCheckScreen() {
  const { t } = useI18n();
  useDateFormat(); // 書式の設定が変わったら再描画する
  const [result, setResult] = useState<IbsiCheckResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [records, setRecords] = useState<IbsiReport[] | null>(null);
  const [recordsError, setRecordsError] = useState<string | null>(null);
  const [filter, setFilter] = useState<IbsiFilter>("ALL");
  const [query, setQuery] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    document.title = t("ibsi.title");
    fetchIbsiRecords().then(setRecords).catch((e) => setRecordsError(e instanceof HttpError ? e.message : String(e)));
  }, [t]);

  const run = (refresh: boolean) => {
    setBusy(true);
    setError(null);
    fetchIbsiCheck(refresh)
      .then(setResult)
      .catch((e) => setError(e instanceof HttpError ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // 集計は行から数え直す。RadiomicsJ の集計と食い違えば例外（画面に出す）
  const summary = useMemo(() => {
    if (!result) return null;
    try {
      return { s: summarize(result.report), err: null as string | null };
    } catch (e) {
      return { s: null, err: e instanceof Error ? e.message : String(e) };
    }
  }, [result]);

  const rows = useMemo(() => (result ? filterRows(result.report.rows, filter, query) : []), [result, filter, query]);

  const sentence = useMemo(() => {
    if (!result || !summary?.s) return "";
    const s = summary.s;
    return t("ibsi.method.sentence", {
      rj: result.radiomicsjVersion, checked: s.checked, tol: s.withinTolerance, digits: s.atReferenceDigits,
      fail: s.failed, gn: result.graphyVersion, date: formatRanAt(result.ranAt),
    });
  }, [result, summary, t]);

  const onCopy = () => {
    navigator.clipboard.writeText(sentence).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => undefined);
  };

  const verdictLabel = (v: IbsiVerdict) => t(`ibsi.verdict.${v}`);

  return (
    <div style={page} data-testid="ibsi-check">
      <div style={header}>{t("ibsi.title")}</div>
      <div style={note}>{t("ibsi.intro")}</div>

      <div style={panel}>
        <div style={summaryRow}>
          <button style={btnPrimary} disabled={busy} onClick={() => run(true)} data-testid="ibsi-run">
            {busy ? t("ibsi.running") : result ? t("ibsi.rerun") : t("ibsi.run")}
          </button>
          {!result && !busy && (
            <button style={btn} onClick={() => run(false)} data-testid="ibsi-show-last">{t("ibsi.showLast")}</button>
          )}
        </div>
        {error && <div style={errText} data-testid="ibsi-error">{error}</div>}
        {result && (
          <div style={{ ...note, marginTop: 8 }} data-testid="ibsi-versions">
            {t("ibsi.versions", {
              gn: result.graphyVersion, rj: result.radiomicsjVersion,
              sha: `${result.report.referenceSha256.slice(0, 8)}…`, date: formatRanAt(result.ranAt),
            })}
          </div>
        )}
        <div style={note}>{t("ibsi.rule")}</div>
      </div>

      {summary?.err && <div style={errText} data-testid="ibsi-count-error">{summary.err}</div>}

      {result && summary?.s && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontWeight: 600, color: "#0b5cad" }}>{t("ibsi.phantom.head")}</div>
          <div style={{ ...summaryRow, marginTop: 6 }} data-testid="ibsi-summary">
            <span style={summary.s.failed === 0 ? okPill : failPill} data-testid="ibsi-passed">
              {t("ibsi.summary.passed", { passed: passedOf(summary.s), checked: summary.s.checked })}
            </span>
            <span style={infoPill}>{t("ibsi.summary.tolerance", { n: summary.s.withinTolerance })}</span>
            <span style={infoPill}>{t("ibsi.summary.digits", { n: summary.s.atReferenceDigits })}</span>
            <span style={summary.s.failed === 0 ? infoPill : failPill} data-testid="ibsi-failed">
              {t("ibsi.summary.failed", { n: summary.s.failed })}
            </span>
            <span style={infoPill}>{t("ibsi.summary.notComputed", { n: summary.s.notComputed })}</span>
            <span style={infoPill}>{t("ibsi.summary.notSupported", { n: summary.s.notSupported })}</span>
            <span style={infoPill}>{t("ibsi.summary.noManual", { n: summary.s.noManualReference })}</span>
          </div>
          <div style={note}>
            {t("ibsi.summary.note")}
            {result.report.skippedDiagnostics > 0 ? ` ${t("ibsi.summary.diag", { diag: result.report.skippedDiagnostics })}` : ""}
          </div>

          <div style={{ ...summaryRow, marginTop: 10 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value as IbsiFilter)} style={{ ...input, width: 220 }}
              data-testid="ibsi-filter">
              {FILTERS.map((f) => <option key={f} value={f}>{t(`ibsi.filter.${f}`)}</option>)}
            </select>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("ibsi.search")}
              style={{ ...input, width: 220 }} data-testid="ibsi-search" />
            <span style={note} data-testid="ibsi-shown">{t("ibsi.shown", { n: rows.length, total: result.report.rows.length })}</span>
          </div>

          <table style={table} data-testid="ibsi-table">
            <thead>
              <tr>
                <th style={th}>{t("ibsi.col.family")}</th>
                <th style={th}>{t("ibsi.col.feature")}</th>
                <th style={th}>{t("ibsi.col.reference")}</th>
                <th style={th}>{t("ibsi.col.tolerance")}</th>
                <th style={th}>{t("ibsi.col.computed")}</th>
                <th style={th}>{t("ibsi.col.verdict")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r: IbsiRow, i) => (
                <tr key={`${r.column ?? r.imageBiomarker}-${i}`} data-verdict={r.verdict}>
                  <td style={td}>{r.family ?? "—"}</td>
                  <td style={td}>{r.imageBiomarker ?? r.radiomicsjName ?? "—"}</td>
                  <td style={td}>{num(r.reference)}</td>
                  <td style={td}>{num(r.tolerance)}</td>
                  <td style={td}>{num(r.computed)}</td>
                  <td style={{ ...td, whiteSpace: "nowrap", color: r.verdict === "FAIL" ? "#b00020" : undefined, fontWeight: r.verdict === "FAIL" ? 600 : 400 }}>
                    {verdictLabel(r.verdict)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ ...panel, maxWidth: 900 }}>
            <div style={{ fontWeight: 600 }}>{t("ibsi.method.head")}</div>
            <div style={{ marginTop: 4 }} data-testid="ibsi-sentence">{sentence}</div>
            <div style={{ ...summaryRow, marginTop: 8 }}>
              <button style={miniBtn} onClick={onCopy} data-testid="ibsi-copy">{copied ? t("ibsi.copied") : t("ibsi.copy")}</button>
              <button style={miniBtn} data-testid="ibsi-csv"
                onClick={() => download(result.csv, `${ibsiFileBase(result)}.csv`, "text/csv;charset=utf-8")}>CSV</button>
              <button style={miniBtn} data-testid="ibsi-json"
                onClick={() => download(ibsiResultJson(result), `${ibsiFileBase(result)}.json`, "application/json")}>JSON</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <div style={{ fontWeight: 600, color: "#0b5cad" }}>{t("ibsi.ct.head")}</div>
        <div style={note}>{t("ibsi.ct.note")}</div>
        {recordsError && <div style={errText}>{recordsError}</div>}
        {records?.length === 0 && <div style={note}>{t("ibsi.ct.none")}</div>}
        {records?.map((rep) => {
          let sum: ReturnType<typeof summarize> | null = null;
          let err: string | null = null;
          try { sum = summarize(rep); } catch (e) { err = e instanceof Error ? e.message : String(e); }
          return (
            <div key={rep.dataSet} style={{ marginTop: 8 }} data-testid={`ibsi-record-${rep.dataSet.replace(/\s+/g, "-")}`}>
              <div style={summaryRow}>
                <b>{rep.dataSet}</b>
                <span style={infoPill}>RadiomicsJ {rep.radiomicsjVersion}</span>
                {sum && <span style={sum.failed === 0 ? okPill : failPill}>
                  {t("ibsi.summary.passed", { passed: passedOf(sum), checked: sum.checked })}
                </span>}
                {sum && <span style={infoPill}>{t("ibsi.summary.failed", { n: sum.failed })}</span>}
                {sum && <span style={infoPill}>{t("ibsi.summary.notComputed", { n: sum.notComputed })}</span>}
              </div>
              {err && <div style={errText}>{err}</div>}
              {rep.rows.filter((r) => r.verdict === "FAIL").map((r) => (
                <div key={r.column ?? r.imageBiomarker} style={{ ...note, color: "#b00020" }}>
                  {t("ibsi.ct.failRow", {
                    name: r.imageBiomarker ?? r.radiomicsjName ?? "?", computed: num(r.computed),
                    reference: num(r.reference), tolerance: num(r.tolerance),
                  })}
                </div>
              ))}
            </div>
          );
        })}
      </div>

      <div style={{ ...note, marginTop: 16, maxWidth: 900 }}>{t("ibsi.license")}</div>
      <div style={{ ...note, maxWidth: 900 }}>{t("ibsi.disclaimer")}</div>
    </div>
  );
}

const page: React.CSSProperties = { padding: 16, fontSize: 12, color: "#222", background: "#fff", minHeight: "100vh" };
const header: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "#0b5cad", marginBottom: 4 };
const panel: React.CSSProperties = { border: "1px solid #dfe5ec", borderRadius: 8, padding: 12, marginTop: 10, maxWidth: 900 };
const input: React.CSSProperties = {
  boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
const note: React.CSSProperties = { color: "#6b7785", fontSize: 11, marginTop: 4, lineHeight: 1.5 };
const errText: React.CSSProperties = { color: "#b00020", marginTop: 8, whiteSpace: "pre-wrap" };
const summaryRow: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
const infoPill: React.CSSProperties = {
  color: "#0b5cad", background: "#eef5fc", border: "1px solid #c3daf1", borderRadius: 999, padding: "2px 10px",
};
const okPill: React.CSSProperties = {
  color: "#2f6b2f", background: "#eef8ee", border: "1px solid #bfdfbf", borderRadius: 999, padding: "2px 10px",
};
const failPill: React.CSSProperties = {
  color: "#b00020", background: "#fdecee", border: "1px solid #f0b4bb", borderRadius: 999, padding: "2px 10px",
};
const table: React.CSSProperties = { width: "100%", maxWidth: 900, marginTop: 8, borderCollapse: "collapse", fontSize: 12 };
const th: React.CSSProperties = {
  textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #cdd5de", color: "#5a6672", fontWeight: 600,
};
const td: React.CSSProperties = { padding: "2px 6px", verticalAlign: "top" };
const btn: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const miniBtn: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 11, padding: "1px 8px",
};
