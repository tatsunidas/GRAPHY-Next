/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * フィルタ画像（LoG）ダイアログ。選んだシリーズ全体に LoG を掛け、スケールごとに派生シリーズとして保存する
 * （`POST /api/series/filtered/jobs`）。元の格子のまま作るので、元と同じ位置・画素間隔で重ねて見られる。
 *
 * <p>スケールの書き方・換算は ROI 特徴量の画面と共通（`radiomics/scaleSpec.ts`）。派生シリーズは表示用に 16 bit へ
 * 丸められるので、ROI の数値は「Radiomics 特徴量（ROI）」の表を使う（画面に注記）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { NumberField } from "../hooks/NumberField";
import { useI18n } from "../i18n/i18n";
import {
  cancelFilteredSeriesJob,
  fetchSeries,
  fetchSeriesLayout,
  getFilteredSeriesJob,
  submitFilteredSeriesJob,
  type FilteredSeriesJobStatus,
  type Series,
  type Study,
} from "../api";
import { LOG_PADDINGS, SCALE_CONVERSIONS, type LogPadding, type ScaleConversion } from "../radiomics/roiFeatureSettings";
import {
  DEFAULT_FILTER_SCALES,
  SCALE_NOTATIONS,
  parseScaleSpec,
  sigmaPreview,
  type ScaleNotation,
} from "../radiomics/scaleSpec";

const POLL_INTERVAL_MS = 700;
const FINISHED = new Set(["DONE", "FAILED", "CANCELLED"]);

export function FilterImageDialog({
  study,
  series,
  onCreated,
  onClose,
}: {
  study: Study;
  series: Series;
  /** 作れたシリーズの UID（スケールの並び順）。呼び出し側で 1 本目を新しいタイルに開く。 */
  onCreated: (seriesInstanceUids: string[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [allSeries, setAllSeries] = useState<Series[]>([series]);
  const [targetSeriesUid, setTargetSeriesUid] = useState(series.seriesInstanceUid);
  const [channel, setChannel] = useState(0);
  const [timePoint, setTimePoint] = useState(0);
  const [nC, setNC] = useState(1);
  const [nT, setNT] = useState(1);
  const [notation, setNotation] = useState<ScaleNotation>("RADIUS_MM");
  const [scalesText, setScalesText] = useState(DEFAULT_FILTER_SCALES);
  const [conversion, setConversion] = useState<ScaleConversion>("SQRT_D");
  const [k, setK] = useState(1);
  const [dim3d, setDim3d] = useState(false);
  const [truncate, setTruncate] = useState(4);
  const [padding, setPadding] = useState<LogPadding>("MIRROR");

  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<FilteredSeriesJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lossyDone, setLossyDone] = useState(false);
  const jobIdRef = useRef<string | null>(null);

  const spec = useMemo(() => parseScaleSpec(scalesText), [scalesText]);
  const hasZero = !!spec.values && spec.values.includes(0);

  useEffect(() => {
    let cancelled = false;
    void fetchSeries(study.studyInstanceUid)
      .then((list) => {
        if (!cancelled && list.length) setAllSeries(list);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [study.studyInstanceUid]);

  // ターゲットが C/T 次元を持つ場合の選択欄
  useEffect(() => {
    let cancelled = false;
    setChannel(0);
    setTimePoint(0);
    void fetchSeriesLayout(study.studyInstanceUid, targetSeriesUid)
      .then((layout) => {
        if (cancelled) return;
        setNC(Math.max(1, layout.nC));
        setNT(Math.max(1, layout.nT));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [study.studyInstanceUid, targetSeriesUid]);

  // 投入したジョブの進み具合を追う（jobId で古い応答を捨てる）
  useEffect(() => {
    if (!job || FINISHED.has(job.state)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getFilteredSeriesJob(job.jobId)
        .then((next) => {
          if (cancelled || jobIdRef.current !== next.jobId) return;
          setJob(next);
          if (next.state === "DONE" && next.result) {
            onCreated(next.result.series.map((s) => s.seriesInstanceUid));
            if (next.result.lossyCompressed) {
              setBusy(false);
              setLossyDone(true);
            } else {
              onClose();
            }
          } else if (next.state === "FAILED") {
            setBusy(false);
            // 失敗・取り消しまでに作り終えたシリーズは保管庫に残る（知らせて開けるようにする）
            if (next.created.length > 0) onCreated(next.created.map((s) => s.seriesInstanceUid));
            setError(next.error ?? t("filterImg.err.failed"));
          } else if (next.state === "CANCELLED") {
            setBusy(false);
            if (next.created.length > 0) {
              onCreated(next.created.map((s) => s.seriesInstanceUid));
              onClose();
            }
          }
        })
        .catch((e) => {
          if (cancelled) return;
          setBusy(false);
          setError(t("common.fetchError", { error: String(e) }));
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const onRun = async () => {
    setError(null);
    if (!spec.values) return setError(t(`roiFeat.scale.err.${spec.error.key}`, { token: spec.error.token ?? "" }));
    if (hasZero) return setError(t("filterImg.err.zero"));
    if (conversion === "COEFFICIENT" && !(k > 0)) return setError(t("roiFeat.scale.err.number", { token: String(k) }));
    if (!(truncate >= 1 && truncate <= 10)) return setError(t("filterImg.err.truncate"));
    setBusy(true);
    try {
      const status = await submitFilteredSeriesJob({
        studyInstanceUid: study.studyInstanceUid,
        sourceSeriesUid: targetSeriesUid,
        channel,
        timePoint,
        scales: spec.values,
        scaleNotation: notation,
        scaleConversion: conversion,
        ...(conversion === "COEFFICIENT" ? { scaleCoefficient: k } : {}),
        dimension: dim3d ? "3D" : "2D",
        truncate,
        padding,
      });
      jobIdRef.current = status.jobId;
      setJob(status);
    } catch (e) {
      setBusy(false);
      setError(t("common.fetchError", { error: String(e) }));
    }
  };

  const onCancelJob = () => {
    const id = jobIdRef.current;
    if (!id) return;
    void cancelFilteredSeriesJob(id)
      .then(setJob)
      .catch(() => {});
  };

  const seriesLabel = (s: Series) =>
    `#${s.seriesNumber ?? "?"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`.trim();

  const d = dim3d ? 3 : 2;
  const line = (v: number) => {
    if (notation === "WIDTH_PX") return t("roiFeat.scale.listWidth", { w: v });
    const s = sigmaPreview(v, d, conversion, k);
    return s == null ? t("roiFeat.scale.listNone", { input: `r ${v} mm` }) : t("filterImg.listLine", { r: v, s });
  };

  return (
    <div style={overlay} onMouseDown={busy ? undefined : onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()} data-testid="filter-image-dialog">
        <div style={header}>{t("filterImg.title")}</div>

        <Field label={t("filterImg.field.target")}>
          <select value={targetSeriesUid} onChange={(e) => setTargetSeriesUid(e.target.value)} disabled={busy} style={input}>
            {allSeries.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
            ))}
          </select>
        </Field>
        {nC > 1 && (
          <Field label={t("texture.field.targetC")}>
            <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: nC }, (_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Field>
        )}
        {nT > 1 && (
          <Field label={t("texture.field.targetT")}>
            <select value={timePoint} onChange={(e) => setTimePoint(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: nT }, (_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </Field>
        )}

        <Field label={t("roiFeat.scale.notation")}>
          <select value={notation} onChange={(e) => setNotation(e.target.value as ScaleNotation)} disabled={busy}
            style={input} data-testid="filterimg-notation">
            {SCALE_NOTATIONS.map((n) => <option key={n} value={n}>{t(`roiFeat.scale.notation.${n}`)}</option>)}
          </select>
        </Field>
        <Field label={t("roiFeat.scale.values")}>
          <input value={scalesText} onChange={(e) => setScalesText(e.target.value)} disabled={busy} style={input}
            data-testid="filterimg-scales" />
        </Field>
        <div style={note}>{t("filterImg.valuesHint")}</div>
        <div style={note} data-testid="filterimg-list">
          {spec.values ? (
            <>
              <div style={{ fontWeight: 600 }}>{t("roiFeat.scale.listTitle", { n: spec.values.length })}</div>
              {spec.values.slice(0, 8).map((v) => <div key={v}>{line(v)}</div>)}
              {spec.values.length > 8 && <div>{t("roiFeat.scale.listMore", { n: spec.values.length - 8 })}</div>}
            </>
          ) : (
            <span style={errText}>{t(`roiFeat.scale.err.${spec.error.key}`, { token: spec.error.token ?? "" })}</span>
          )}
        </div>
        {notation === "WIDTH_PX" && <div style={note}>{t("roiFeat.scale.noteWidth")}</div>}

        <Field label={t("roiFeat.scale.conversion")}>
          <select value={conversion} onChange={(e) => setConversion(e.target.value as ScaleConversion)} disabled={busy} style={input}>
            {SCALE_CONVERSIONS.map((c) => <option key={c} value={c}>{t(`roiFeat.scale.conv.${c}`)}</option>)}
          </select>
        </Field>
        {conversion === "COEFFICIENT" && (
          <Field label={t("roiFeat.scale.k")}>
            <NumberField value={k} onChange={setK} min={0.1} max={10} step={0.1} disabled={busy} style={input} />
          </Field>
        )}
        <Field label={t("texture.field.dim")}>
          <select value={dim3d ? "3d" : "2d"} onChange={(e) => setDim3d(e.target.value === "3d")} disabled={busy}
            style={input} data-testid="filterimg-dim">
            <option value="2d">{t("filterImg.dim.2d")}</option>
            <option value="3d">{t("filterImg.dim.3d")}</option>
          </select>
        </Field>
        <Field label={t("roiFeat.filter.truncate")}>
          <NumberField value={truncate} onChange={setTruncate} min={1} max={10} step={0.5} disabled={busy} style={input} />
        </Field>
        <Field label={t("roiFeat.filter.padding")}>
          <select value={padding} onChange={(e) => setPadding(e.target.value as LogPadding)} disabled={busy} style={input}>
            {LOG_PADDINGS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>

        <div style={note}>{t("filterImg.note")}</div>
        {error && <div style={errText} data-testid="filterimg-error">{error}</div>}
        {lossyDone && <div style={warnText}>⚠ {t("radiomics.lossyWarning")}</div>}

        {busy && (
          <>
            <div style={progressTrack}>
              {job && job.scaleTotal > 0 ? (
                <div style={{ ...progressFill, width: `${Math.round((job.scaleDone / job.scaleTotal) * 100)}%` }} />
              ) : (
                <>
                  <div style={progressBar} />
                  <style>{"@keyframes filtbar{0%{left:-40%}100%{left:100%}}"}</style>
                </>
              )}
            </div>
            <div style={note} data-testid="filterimg-progress">
              {job && job.scaleTotal > 0
                ? t("filterImg.progress", {
                  done: Math.min(job.scaleDone + 1, job.scaleTotal), total: job.scaleTotal, r: job.scaleMm,
                  seconds: Math.round(job.elapsedMs / 1000),
                })
                : t("texture.progress.starting")}
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 12, justifyContent: "flex-end" }}>
          {busy ? (
            <button onClick={onCancelJob} style={btn}>{t("filterImg.cancelJob")}</button>
          ) : (
            <button onClick={onClose} style={btn}>{t("common.cancel")}</button>
          )}
          <button onClick={onRun} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}
            data-testid="filterimg-run">
            {busy ? t("filterImg.running") : t("filterImg.run")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={fieldRow}>
      <span style={fieldLabel}>{label}</span>
      <span style={fieldValue}>{children}</span>
    </div>
  );
}

const overlay: React.CSSProperties = {
  position: "fixed", inset: 0, zIndex: 70, background: "rgba(0,0,0,0.35)",
  display: "flex", alignItems: "center", justifyContent: "center",
};
const panel: React.CSSProperties = {
  width: 440, maxHeight: "90vh", overflowY: "auto",
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: 16, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#0b5cad", marginBottom: 10 };
const fieldRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0" };
const fieldLabel: React.CSSProperties = { color: "#5a6672", flex: "none", minWidth: 130 };
const fieldValue: React.CSSProperties = { flex: 1, textAlign: "right" };
const input: React.CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px" };
const errText: React.CSSProperties = { color: "#b00020", marginTop: 8 };
const warnText: React.CSSProperties = {
  color: "#8a5300", background: "#fff6e5", border: "1px solid #f0d9a8",
  borderRadius: 4, padding: "5px 7px", marginTop: 8, fontSize: 11, lineHeight: 1.5,
};
const note: React.CSSProperties = { color: "#6b7785", fontSize: 11, marginTop: 6, lineHeight: 1.5 };
const progressFill: React.CSSProperties = {
  position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 3,
  background: "#0b5cad", transition: "width 0.3s linear",
};
const progressTrack: React.CSSProperties = {
  position: "relative", height: 6, marginTop: 10, borderRadius: 3,
  background: "#e1e7ee", overflow: "hidden",
};
const progressBar: React.CSSProperties = {
  position: "absolute", top: 0, height: "100%", width: "40%", borderRadius: 3,
  background: "#0b5cad", animation: "filtbar 1.1s linear infinite",
};
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
