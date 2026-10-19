/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import {
  cancelExportJob,
  exportZip,
  fetchSeries,
  fetchStudies,
  getExportJob,
  submitExportJob,
  type ExportJobStatus,
  type ExportSelection,
  type Series,
  type Study,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { desktop } from "../desktopBridge";
import { selectionHasCfm } from "./cfmNotice";
import { exportPercent, runExportJob } from "./exportJob";

/**
 * Export: MainScreen で選択中のスタディ<b>の患者</b>のスタディ/シリーズをツリー表示し、
 * 選択シリーズを DICOM 交換メディア（PS3.10）形式で書き出す。
 *
 * オプションは「2D Viewer (portable) を同梱」（DICOMDIR・README も付く）と「ZIP にまとめる」の 2 つだけ。
 * デスクトップは出力先フォルダを選んでジョブ（進捗・中止つき）で書き出す。Web 版は従来どおり ZIP のダウンロード。
 *
 * Export 対象の粒度は<b>シリーズ</b>。スタディのチェックは配下シリーズの一括選択トグル
 * （スタディが選択されていても、実際に Export されるのは選択中シリーズのみ）。
 *
 * 患者は MainScreen 選択スタディから一意に決まる（患者全件は表示しない）。未選択時は
 * MainScreen 側でポップアップして本ダイアログを開かない。
 */
export function ExportDialog({
  open,
  onClose,
  study,
}: {
  open: boolean;
  onClose: () => void;
  study: Study | null;
}) {
  const { t } = useI18n();

  // 対象患者のスタディ/シリーズツリー
  const [studies, setStudies] = useState<Study[] | null>(null);
  const [seriesByStudy, setSeriesByStudy] = useState<Map<string, Series[]>>(new Map());
  const [expandedStudies, setExpandedStudies] = useState<Set<string>>(new Set());
  const [checkedSeries, setCheckedSeries] = useState<Set<string>>(new Set());
  const seriesStudy = useRef<Map<string, string>>(new Map());

  // オプション
  const [includePortable, setIncludePortable] = useState(false);
  const [zip, setZip] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<ExportJobStatus | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const cancelRequested = useRef(false);
  const [doneMsg, setDoneMsg] = useState<string | null>(null);

  const patientId = study?.patientId ?? null;
  const patientName = study?.patientName ?? null;

  // 開いた時／対象患者が変わった時にツリーを初期化し、選択スタディの患者の全スタディを読み込む。
  useEffect(() => {
    if (!open || !patientId) return;
    setStudies(null);
    setSeriesByStudy(new Map());
    setExpandedStudies(new Set());
    setCheckedSeries(new Set());
    seriesStudy.current = new Map();
    setError(null);

    let cancelled = false;
    fetchStudies({ patientId })
      .then(async (sts) => {
        if (cancelled) return;
        setStudies(sts);
        // MainScreen で選択中のスタディは展開し、シリーズを先読みして<b>全選択状態</b>にする。
        if (study) {
          try {
            const series = await fetchSeries(study.studyInstanceUid);
            if (cancelled) return;
            for (const s of series) seriesStudy.current.set(s.seriesInstanceUid, study.studyInstanceUid);
            setSeriesByStudy((m) => new Map(m).set(study.studyInstanceUid, series));
            setExpandedStudies(new Set([study.studyInstanceUid]));
            // 選択スタディの全シリーズを初期チェック（その場で Export 実行できる状態にする）。
            setCheckedSeries(new Set(series.map((s) => s.seriesInstanceUid)));
          } catch {
            // 先読み失敗は無視（展開時に再取得される）
          }
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, patientId, study]);

  if (!open) return null;

  const loadSeries = async (studyUid: string): Promise<Series[]> => {
    const cached = seriesByStudy.get(studyUid);
    if (cached) return cached;
    const series = await fetchSeries(studyUid);
    for (const s of series) seriesStudy.current.set(s.seriesInstanceUid, studyUid);
    setSeriesByStudy((m) => new Map(m).set(studyUid, series));
    return series;
  };

  const toggleExpand = async (studyUid: string) => {
    const next = new Set(expandedStudies);
    if (next.has(studyUid)) {
      next.delete(studyUid);
    } else {
      next.add(studyUid);
      try {
        await loadSeries(studyUid);
      } catch (e) {
        setError(String(e));
      }
    }
    setExpandedStudies(next);
  };

  const toggleSeries = (seriesUid: string, studyUid: string) => {
    seriesStudy.current.set(seriesUid, studyUid);
    const cs = new Set(checkedSeries);
    if (cs.has(seriesUid)) cs.delete(seriesUid);
    else cs.add(seriesUid);
    setCheckedSeries(cs);
  };

  // スタディのチェック状態（配下シリーズから導出）
  const studyCheckState = (studyUid: string): "all" | "some" | "none" => {
    const series = seriesByStudy.get(studyUid);
    if (!series || series.length === 0) return "none";
    const n = series.filter((s) => checkedSeries.has(s.seriesInstanceUid)).length;
    return n === 0 ? "none" : n === series.length ? "all" : "some";
  };

  const toggleStudy = async (studyUid: string) => {
    let series = seriesByStudy.get(studyUid);
    if (!series) {
      try {
        series = await loadSeries(studyUid);
        setExpandedStudies((s) => new Set(s).add(studyUid));
      } catch (e) {
        setError(String(e));
        return;
      }
    }
    const cs = new Set(checkedSeries);
    const allChecked = series.every((s) => cs.has(s.seriesInstanceUid));
    for (const s of series) {
      seriesStudy.current.set(s.seriesInstanceUid, studyUid);
      if (allChecked) cs.delete(s.seriesInstanceUid);
      else cs.add(s.seriesInstanceUid);
    }
    setCheckedSeries(cs);
  };

  const buildSelections = (): ExportSelection[] => {
    const byStudy = new Map<string, string[]>();
    for (const seriesUid of checkedSeries) {
      const studyUid = seriesStudy.current.get(seriesUid);
      if (!studyUid) continue;
      if (!byStudy.has(studyUid)) byStudy.set(studyUid, []);
      byStudy.get(studyUid)!.push(seriesUid);
    }
    return [...byStudy].map(([studyUid, seriesUids]) => ({ studyUid, seriesUids }));
  };

  /** 完了・中止・失敗の通知（ダイアログ内表示 + OS 通知。権限が無ければ前者だけ）。 */
  const announce = (msg: string) => {
    setDoneMsg(msg);
    try {
      if (typeof Notification !== "undefined") {
        const fire = () => new Notification(t("export.notify.title"), { body: msg });
        if (Notification.permission === "granted") fire();
        else if (Notification.permission !== "denied") void Notification.requestPermission().then((p) => p === "granted" && fire());
      }
    } catch {
      // 通知が使えない環境ではダイアログ内の表示だけ
    }
  };

  const runJob = async (selections: ExportSelection[], pickDirectory: () => Promise<string | null>) => {
    const destination = await pickDirectory();
    if (!destination) return; // 出力先の選択を取り消した
    cancelRequested.current = false;
    setCancelling(false);
    setBusy(true);
    setError(null);
    setDoneMsg(null);
    try {
      const last = await runExportJob(
        {
          submit: () => submitExportJob({ selections, includePortableViewer: includePortable, zip, destination }),
          get: getExportJob,
          cancel: cancelExportJob,
        },
        setJob,
        () => cancelRequested.current,
      );
      if (last.state === "DONE") announce(t("export.done", { path: last.outputPath ?? "" }));
      else if (last.state === "CANCELLED") announce(t("export.cancelled"));
      else setError(t("export.failed", { error: last.error ?? "" }));
    } catch (e) {
      setError(t("common.fetchError", { error: String(e) }));
    } finally {
      setBusy(false);
      setJob(null);
      setCancelling(false);
    }
  };

  const requestCancel = () => {
    cancelRequested.current = true;
    setCancelling(true);
  };

  const run = async () => {
    const selections = buildSelections();
    // 本体が作る CFM は 32 ビット（規格外）。相手が受け付けないことがあるので、黙って出さない（fw/microscopy-cfm.md）
    if (selections.length > 0 && selectionHasCfm(seriesByStudy, checkedSeries) && !window.confirm(t("cfm.nonStandardConfirm"))) return;
    if (selections.length === 0) return;
    const pick = desktop()?.pickDirectory;
    if (pick) {
      await runJob(selections, pick);
      return;
    }
    // Web 版: 従来どおり ZIP をダウンロード（フォルダを選べない・進捗なし）
    setBusy(true);
    setError(null);
    setDoneMsg(null);
    try {
      const { blob, filename } = await exportZip({
        selections,
        includeDicomDir: includePortable,
        includePortableViewer: includePortable,
        includeReadme: includePortable,
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

  const selectedSeriesCount = checkedSeries.size;
  const isDesktop = !!desktop()?.pickDirectory;
  const safeClose = () => {
    if (!busy) onClose();
  };
  const pct = job ? exportPercent(job) : null;

  return (
    <div style={overlay} onClick={safeClose}>
      <div style={dialog} onClick={(e) => e.stopPropagation()}>
        <div style={header}>
          <span style={{ fontWeight: 700 }}>{t("export.title")}</span>
          <button style={closeBtn} onClick={safeClose} disabled={busy} aria-label={t("common.close")}>
            ✕
          </button>
        </div>

        {/* 対象患者ヘッダ */}
        <div style={patientBar}>
          <span style={{ fontWeight: 700 }}>{patientName || "—"}</span>
          <span style={{ color: "#8a98a6", fontSize: 12 }}> {patientId}</span>
        </div>

        {/* スタディ/シリーズツリー */}
        <div style={treePane}>
          {!studies && <div style={{ color: "#888" }}>{t("common.loading")}</div>}
          {studies?.length === 0 && <div style={{ color: "#888" }}>{t("study.empty")}</div>}
          {studies?.map((st) => {
            const expanded = expandedStudies.has(st.studyInstanceUid);
            const cstate = studyCheckState(st.studyInstanceUid);
            const series = seriesByStudy.get(st.studyInstanceUid);
            return (
              <div key={st.studyInstanceUid}>
                <div style={studyRow}>
                  <button
                    style={expander}
                    onClick={() => void toggleExpand(st.studyInstanceUid)}
                    aria-label="expand"
                  >
                    {expanded ? "▾" : "▸"}
                  </button>
                  <TriCheckbox state={cstate} onChange={() => void toggleStudy(st.studyInstanceUid)} />
                  <span style={{ cursor: "pointer" }} onClick={() => void toggleExpand(st.studyInstanceUid)}>
                    {st.studyDate || "—"} / {st.studyDescription || "—"}
                    <span style={{ color: "#8a98a6", fontSize: 11 }}>
                      {" "}
                      {st.modality || ""} ({st.numberOfInstances})
                    </span>
                  </span>
                </div>
                {expanded && (
                  <div style={{ paddingLeft: 40 }}>
                    {!series && <div style={{ color: "#888" }}>{t("common.loading")}</div>}
                    {series?.length === 0 && <div style={{ color: "#888" }}>{t("series.empty")}</div>}
                    {series?.map((ser) => (
                      <label key={ser.seriesInstanceUid} style={seriesRow}>
                        <input
                          type="checkbox"
                          checked={checkedSeries.has(ser.seriesInstanceUid)}
                          onChange={() => toggleSeries(ser.seriesInstanceUid, st.studyInstanceUid)}
                        />
                        <span>
                          #{ser.seriesNumber ?? "—"} {ser.modality || ""} {ser.seriesDescription || "—"}
                          <span style={{ color: "#8a98a6", fontSize: 11 }}> ({ser.numberOfInstances})</span>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* オプション + 実行 */}
        <div style={footer}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 16px", flex: 1 }}>
            <label style={opt}>
              <input
                type="checkbox"
                checked={includePortable}
                disabled={busy}
                onChange={(e) => setIncludePortable(e.target.checked)}
              />
              {t("export.opt.portable")}
              <span style={{ color: "#8a98a6", fontSize: 11 }}>{t("export.opt.portableHint")}</span>
            </label>
            {isDesktop && (
              <label style={opt}>
                <input type="checkbox" checked={zip} disabled={busy} onChange={(e) => setZip(e.target.checked)} data-testid="export-zip" />
                {t("export.opt.zip")}
              </label>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 12, color: "#556" }}>
              {t("export.selectedCount", { count: selectedSeriesCount })}
            </span>
            <button onClick={safeClose} disabled={busy} style={btn}>
              {t("common.close")}
            </button>
            <button
              onClick={run}
              data-testid="export-run"
              disabled={busy || selectedSeriesCount === 0}
              style={{
                ...btn,
                background: busy || selectedSeriesCount === 0 ? "#9fb6cf" : "#0b5cad",
                color: "#fff",
                cursor: busy || selectedSeriesCount === 0 ? "default" : "pointer",
              }}
            >
              {busy ? t("export.running") : t("export.run")}
            </button>
          </div>
        </div>
        {job && (
          <div style={progressRow} data-testid="export-progress">
            <span style={{ whiteSpace: "nowrap" }}>
              {cancelling
                ? t("export.cancelling")
                : t(job.total > 0 ? "export.progress" : "export.progressNoTotal", { processed: job.processed, total: job.total })}
            </span>
            <div style={track} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct ?? undefined}>
              <div style={{ height: "100%", background: "#0b5cad", width: pct === null ? "30%" : `${pct}%`, opacity: pct === null ? 0.6 : 1, transition: "width 0.2s" }} />
            </div>
            <button onClick={requestCancel} disabled={cancelling} style={btn} data-testid="export-cancel">
              {t("export.cancel")}
            </button>
          </div>
        )}
        {doneMsg && !busy && (
          <div style={{ color: "#2e5d27", padding: "0 16px 10px" }} data-testid="export-done">
            {doneMsg}
          </div>
        )}
        {error && <div style={{ color: "#b00020", padding: "0 16px 10px" }}>{error}</div>}
      </div>
    </div>
  );
}

/** indeterminate を扱える 3 状態チェックボックス。 */
function TriCheckbox({ state, onChange }: { state: "all" | "some" | "none"; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return <input ref={ref} type="checkbox" checked={state === "all"} onChange={onChange} />;
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
  width: 760,
  maxWidth: "96vw",
  height: 600,
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
const patientBar: React.CSSProperties = {
  padding: "8px 16px",
  borderBottom: "1px solid #eef1f4",
  background: "#f7f9fb",
};
const treePane: React.CSSProperties = { flex: 1, overflow: "auto", padding: "12px 16px", fontSize: 13 };
const studyRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, padding: "3px 0" };
const seriesRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "2px 0", cursor: "pointer" };
const expander: React.CSSProperties = {
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  width: 16,
  color: "#667",
  padding: 0,
};
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "10px 16px",
  borderTop: "1px solid #eee",
};
const progressRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, padding: "0 16px 10px", fontSize: 13 };
const track: React.CSSProperties = { flex: 1, height: 8, background: "#dbe4ee", borderRadius: 4, overflow: "hidden" };
const opt: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 13, cursor: "pointer" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const btn: React.CSSProperties = { padding: "6px 14px", border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 13 };
