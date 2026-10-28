/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { albumFilters } from "../albums/albumView";
import { fetchSeries, fetchStudies, type Series, type Study } from "../api";
import { HttpError } from "../http";
import { formatDicomDate } from "../i18n/dateFormat";
import { useI18n } from "../i18n/i18n";
import {
  BATCH_FINISHED,
  cancelBatch,
  getBatch,
  getBatchResults,
  planBatch,
  submitBatch,
  type BatchPairResult,
  type BatchStatus,
} from "./batchApi";
import {
  assignCaseLabels,
  batchFiles,
  buildBatchRequest,
  cleanLabel,
  duplicateLabels,
  initialRows,
  pairKey,
  runnable,
  selectedPairs,
  setIncluded,
  setSource,
  summarize,
  type PairRow,
} from "./batchPairs";
import { BatchSettingsPanel } from "./BatchSettingsPanel";
import { downloadText } from "./downloadText";
import { defaultRoiFeatureForm, type RoiFeatureForm } from "./roiFeatureSettings";

const POLL_INTERVAL_MS = 1000;
const SERIES_CONCURRENCY = 4;

const seriesLabel = (s: Series | undefined, uid: string): string =>
  s ? `#${s.seriesNumber ?? "?"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`.trim() : uid;

/** 同時に動かす数を絞って順に実行する。1 件の失敗が他を止めない。 */
async function limited<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const x = items[next++];
      try {
        await fn(x);
      } catch {
        /* 説明が引けなくても、UID の表示で続ける */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/**
 * アルバムの SEG から、(元画像, セグメント) の組を作って確認し、ROI 特徴量を一括で抽出する。
 * 計算は backend の一括抽出（`/api/radiomics/batch`）が 1 組ずつ直列に行う。ここは確認・設定・進み・書き出し。
 */
export function RoiFeatureBatchDialog({
  albumId,
  albumName,
  uids,
  onClose,
}: {
  albumId: number;
  albumName: string;
  uids: readonly string[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [rows, setRows] = useState<PairRow[] | null>(null);
  const [studies, setStudies] = useState<Map<string, Study>>(new Map());
  const [series, setSeries] = useState<Map<string, Series[]>>(new Map());
  const [form, setForm] = useState<RoiFeatureForm>(defaultRoiFeatureForm);
  const [prefix, setPrefix] = useState("");
  const [job, setJob] = useState<BatchStatus | null>(null);
  const [results, setResults] = useState<BatchPairResult[] | null>(null);
  const [trial, setTrial] = useState<BatchPairResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [written, setWritten] = useState<number | null>(null);
  /** 実行中のジョブの、組ごとの症例ラベルと、試行かどうか。結果の `index` で引く。 */
  const runRef = useRef<{ jobId: string; labels: string[]; keys: string[]; trial: boolean } | null>(null);

  const errText = (e: unknown): string =>
    e instanceof HttpError && e.status === 403
      ? t("roiFeat.err.forbidden", { error: e.message })
      : e instanceof Error ? e.message : String(e);

  // 開いたら組を調べる
  useEffect(() => {
    let alive = true;
    planBatch({ albumId, studyUids: null })
      .then((pairs) => {
        if (!alive) return;
        setRows(initialRows(pairs));
        const studyUids = Array.from(new Set(pairs.map((p) => p.studyUid)));
        void fetchStudies(albumFilters(studyUids))
          .then((list) => alive && setStudies(new Map(list.map((s) => [s.studyInstanceUid, s]))))
          .catch(() => undefined);
        void limited(studyUids, SERIES_CONCURRENCY, async (u) => {
          const s = await fetchSeries(u);
          if (alive) setSeries((prev) => new Map(prev).set(u, s));
        });
      })
      .catch((e) => alive && setError(errText(e)));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [albumId]);

  // ジョブの問い合わせ。古いジョブの応答は jobId で捨てる。
  useEffect(() => {
    if (!job || BATCH_FINISHED.has(job.state)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getBatch(job.jobId)
        .then(async (next) => {
          if (cancelled || runRef.current?.jobId !== next.jobId) return;
          if (BATCH_FINISHED.has(next.state)) {
            // 結果を先に取る。`setJob` で effect が作り直されると `cancelled` が立つので、その後では結果を捨ててしまう。
            const r = await getBatchResults(next.jobId);
            if (runRef.current?.jobId !== next.jobId) return;
            if (runRef.current.trial) setTrial(r[0] ?? null);
            else setResults(r);
          }
          setJob(next);
        })
        .catch((e) => !cancelled && setError(errText(e)));
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const summary = useMemo(() => (rows ? summarize(rows) : null), [rows]);
  const running = !!job && !BATCH_FINISHED.has(job.state);
  const dup = rows ? duplicateLabels(assignCaseLabels(rows)) : [];

  const start = async (isTrial: boolean) => {
    if (!rows) return;
    setError(null);
    setWritten(null);
    setResults(null);
    setTrial(null);
    const labelled = assignCaseLabels(rows);
    setRows(labelled);
    const dups = duplicateLabels(labelled);
    if (dups.length > 0) return setError(t("roiFeat.batch.err.duplicate", { labels: dups.join(", ") }));
    let chosen = selectedPairs(labelled);
    if (isTrial) chosen = chosen.slice(0, 1);
    if (chosen.length === 0) return setError(t("roiFeat.batch.err.nothing"));
    try {
      const st = await submitBatch(buildBatchRequest(chosen.map((c) => c.pair), form));
      runRef.current = {
        jobId: st.jobId, labels: chosen.map((c) => c.caseLabel), keys: chosen.map((c) => pairKey(c.pair)), trial: isTrial,
      };
      setJob(st);
    } catch (e) {
      setError(errText(e));
    }
  };

  const cancel = () => {
    if (job) void cancelBatch(job.jobId).then((st) => runRef.current?.jobId === st.jobId && setJob(st)).catch((e) => setError(errText(e)));
  };

  const write = () => {
    const run = runRef.current;
    if (!job || !results || !run) return;
    const items = results.map((r) => ({ caseLabel: run.labels[r.index] ?? "", result: r.result }));
    const all = job.pairs.map((p) => ({ caseLabel: run.labels[p.index] ?? "", status: p }));
    const out = batchFiles(prefix, items, all);
    if (!out.ok) {
      return setError(
        out.reason === "header mismatch"
          ? t("roiFeat.batch.err.header", { label: out.caseLabel })
          : t("roiFeat.batch.err.noResult"),
      );
    }
    setError(null);
    for (const f of [out.files.features, out.files.definitions, out.files.settings, out.files.pairs]) {
      downloadText(f.text, f.name, f.name.endsWith(".properties") ? "text/plain;charset=utf-8" : "text/csv;charset=utf-8");
    }
    setWritten(4);
  };

  const close = () => {
    if (running && job) void cancelBatch(job.jobId).catch(() => undefined);
    onClose();
  };

  const studyText = (uid: string): string => {
    const s = studies.get(uid);
    if (!s) return uid;
    return [s.patientName ?? "", s.studyDate ? formatDicomDate(s.studyDate) : "", s.studyDescription ?? ""]
      .filter(Boolean).join(" · ");
  };
  const seriesText = (studyUid: string, uid: string) =>
    seriesLabel(series.get(studyUid)?.find((s) => s.seriesInstanceUid === uid), uid);
  const stateText = (r: PairRow): string =>
    r.pair.status === "AUTO"
      ? t("roiFeat.batch.state.auto")
      : r.pair.status === "NEEDS_CONFIRMATION"
        ? `${t("roiFeat.batch.state.needs")}${r.pair.reason ? `: ${r.pair.reason}` : ""}`
        : `${t("roiFeat.batch.state.excluded")}${r.pair.reason ? `: ${r.pair.reason}` : ""}`;
  /** 全件実行のジョブの中での、この行の組の状態（試行や対象外の行は null）。 */
  const pairStateOf = (r: PairRow) => {
    const run = runRef.current;
    if (!job || !run || run.trial) return undefined;
    const i = run.keys.indexOf(pairKey(r.pair));
    return i < 0 ? undefined : job.pairs[i];
  };

  return (
    <div style={overlay} data-testid="batch-dialog">
      <div style={dialog}>
        <div style={header}>
          <span style={{ fontWeight: 600 }}>
            {t("roiFeat.batch.title", { name: albumName, count: uids.length })}
          </span>
          <button type="button" style={closeBtn} onClick={close} data-testid="batch-close">×</button>
        </div>
        <div style={body}>
          <div style={note}>{t("roiFeat.researchOnly")}</div>
          <div style={note}>{t("roiFeat.batch.privacy")}</div>

          {!rows && !error && <div data-testid="batch-planning">{t("roiFeat.batch.planning")}</div>}
          {error && <div style={errStyle} data-testid="batch-error">{error}</div>}

          {rows && summary && (
            <>
              <div style={section}>{t("roiFeat.batch.step1")}</div>
              {rows.length === 0 ? (
                <div data-testid="batch-empty">{t("roiFeat.batch.empty")}</div>
              ) : (
                <table style={table}>
                  <thead>
                    <tr>
                      <th style={th} />
                      <th style={th}>{t("roiFeat.batch.col.study")}</th>
                      <th style={th}>{t("roiFeat.batch.col.source")}</th>
                      <th style={th}>{t("roiFeat.batch.col.mask")}</th>
                      <th style={th}>{t("roiFeat.batch.col.state")}</th>
                      <th style={th}>{t("roiFeat.batch.col.label")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const ps = pairStateOf(r);
                      return (
                        <tr key={pairKey(r.pair) + i} data-testid={`batch-row-${i}`} style={{ borderTop: "1px solid #eef2f6" }}>
                          <td style={td}>
                            <input type="checkbox" data-testid={`batch-include-${i}`} checked={r.included}
                              disabled={running || !runnable(r)}
                              onChange={(e) => setRows(setIncluded(rows, i, e.target.checked))} />
                          </td>
                          <td style={td}>{studyText(r.pair.studyUid)}</td>
                          <td style={td}>
                            {r.pair.status === "AUTO" && r.source ? seriesText(r.pair.studyUid, r.source)
                              : r.pair.status === "NEEDS_CONFIRMATION" ? (
                                <select data-testid={`batch-source-${i}`} value={r.source ?? ""} disabled={running}
                                  onChange={(e) => setRows(setSource(rows, i, e.target.value || null))}>
                                  <option value="">{t("roiFeat.batch.choose")}</option>
                                  {r.pair.sourceCandidates.map((c) => (
                                    <option key={c} value={c}>{seriesText(r.pair.studyUid, c)}</option>
                                  ))}
                                </select>
                              ) : "—"}
                          </td>
                          <td style={td}>
                            {seriesText(r.pair.studyUid, r.pair.maskSeriesUid)}
                            {r.pair.segmentNumber != null && ` · ${r.pair.segmentNumber}${r.pair.segmentLabel ? `: ${r.pair.segmentLabel}` : ""}`}
                          </td>
                          <td style={td} data-testid={`batch-state-${i}`}>
                            {ps ? `${t(`roiFeat.batch.pairState.${ps.state}`)}${ps.fromCache ? t("roiFeat.batch.cache") : ""}${ps.error ? `: ${ps.error}` : ""}` : stateText(r)}
                          </td>
                          <td style={td}>
                            {r.included && runnable(r) && (
                              <input value={r.caseLabel} placeholder="C001" disabled={running} style={{ ...input, width: 80 }}
                                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, caseLabel: cleanLabel(e.target.value) } : x)))} />
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <div style={{ marginTop: 6 }} data-testid="batch-summary">
                {t("roiFeat.batch.summary", {
                  auto: summary.auto, needs: summary.needsConfirmation, excluded: summary.excluded, selected: summary.selected,
                })}
                {summary.needsUnchosen > 0 && <span style={{ color: "#7a4b00" }}> — {t("roiFeat.batch.needsHelp")}</span>}
              </div>

              <div style={section}>{t("roiFeat.batch.step2")}</div>
              <BatchSettingsPanel form={form} setForm={setForm} disabled={running} />
              <div style={note}>{t("roiFeat.batch.scope")}</div>

              <div style={section}>{t("roiFeat.batch.step3")}</div>
              <label>
                {t("roiFeat.batch.prefix")}{" "}
                <input data-testid="batch-prefix" value={prefix} placeholder="roi-features-batch" disabled={running}
                  style={{ ...input, width: 220 }} onChange={(e) => setPrefix(e.target.value)} />
              </label>
              {dup.length > 0 && <div style={errStyle}>{t("roiFeat.batch.err.duplicate", { labels: dup.join(", ") })}</div>}
            </>
          )}

          {job && (
            <div style={{ marginTop: 10 }} data-testid="batch-progress">
              <div>
                {t(`roiFeat.batch.jobState.${job.state}`)} — {t("roiFeat.batch.progress", {
                  done: job.done, total: job.total, failed: job.failed, skipped: job.skipped, notRun: job.notRun,
                })}
              </div>
              <div style={track}><div style={{ ...bar, width: `${job.total ? Math.round(((job.done + job.failed + job.skipped) / job.total) * 100) : 0}%` }} /></div>
              {job.state === "STOPPED" && <div style={errStyle}>{t("roiFeat.batch.stopped", { reason: job.stopReason ?? "" })}</div>}
              {job.state === "CANCELLED" && <div style={note}>{t("roiFeat.batch.cancelledNote")}</div>}
            </div>
          )}
          {trial && (
            <div style={{ ...note, color: "#1a4a80" }} data-testid="batch-trial-result">
              {t("roiFeat.batch.trialResult", { n: trial.result.rows.length, ms: job?.pairs[0]?.elapsedMs ?? 0 })}
            </div>
          )}
          {written != null && <div style={{ ...note, color: "#2f6b2f" }} data-testid="batch-written">{t("roiFeat.batch.written", { n: written })}</div>}
        </div>
        <div style={footer}>
          <button type="button" style={btn} data-testid="batch-trial" disabled={running || !summary || summary.selected === 0}
            onClick={() => void start(true)}>{t("roiFeat.batch.trial")}</button>
          <button type="button" style={btnPrimary} data-testid="batch-run" disabled={running || !summary || summary.selected === 0}
            onClick={() => void start(false)}>{t("roiFeat.batch.run")}</button>
          {running && <button type="button" style={btn} data-testid="batch-cancel" onClick={cancel}>{t("roiFeat.batch.cancel")}</button>}
          <button type="button" style={btn} data-testid="batch-write"
            disabled={running || !results || results.length === 0} onClick={write}>{t("roiFeat.batch.write")}</button>
        </div>
      </div>
    </div>
  );
}

const overlay: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 };
const dialog: React.CSSProperties = { width: 1040, maxWidth: "96vw", maxHeight: "92vh", background: "#fff", borderRadius: 10, boxShadow: "0 12px 40px rgba(0,0,0,0.3)", display: "flex", flexDirection: "column", overflow: "hidden", fontFamily: "system-ui, sans-serif", color: "#1a1a1a", fontSize: 12 };
const header: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid #eee", fontSize: 14 };
const body: React.CSSProperties = { padding: "10px 16px", overflow: "auto", flex: 1 };
const footer: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "flex-end", padding: "10px 16px", borderTop: "1px solid #eee" };
const closeBtn: React.CSSProperties = { border: "none", background: "transparent", fontSize: 16, cursor: "pointer", color: "#666" };
const section: React.CSSProperties = { fontWeight: 600, color: "#0b5cad", marginTop: 12, marginBottom: 4 };
const note: React.CSSProperties = { color: "#6b7785", fontSize: 11, marginTop: 4, lineHeight: 1.5 };
const errStyle: React.CSSProperties = { color: "#b00020", marginTop: 8, whiteSpace: "pre-wrap" };
const table: React.CSSProperties = { width: "100%", borderCollapse: "collapse", fontSize: 12 };
const th: React.CSSProperties = { textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #cdd5de", color: "#5a6672", fontWeight: 600 };
const td: React.CSSProperties = { padding: "3px 6px", verticalAlign: "top" };
const input: React.CSSProperties = { boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px" };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const track: React.CSSProperties = { height: 6, marginTop: 6, borderRadius: 3, background: "#e1e7ee", overflow: "hidden" };
const bar: React.CSSProperties = { height: "100%", background: "#0b5cad", transition: "width 0.3s" };
