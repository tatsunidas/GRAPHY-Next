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
  applyLabelFilter,
  assignCaseLabels,
  batchFileBase,
  buildBatchRequest,
  cleanLabel,
  duplicateLabels,
  initialRows,
  pairKey,
  runnable,
  selectedPairs,
  setIncluded,
  setSource,
  smallRoiThresholdUnset,
  summarize,
  type PairRow,
} from "./batchPairs";
import {
  SPEC_MAX_BYTES,
  applySpecToForm,
  batchSpecFileName,
  buildSpec,
  contentSha256,
  parseLabelInput,
  parseSpec,
  specContentFrom,
  specText,
  type BatchSpec,
  type SpecContent,
  type SpecKind,
} from "./batchSpec";
import { BatchSettingsPanel } from "./BatchSettingsPanel";
import { assignSubjectCodes, datasetFiles, type DatasetRow } from "./datasetCsv";
import { downloadText } from "./downloadText";
import { defaultRoiFeatureForm, rangeBounds, type RoiFeatureForm } from "./roiFeatureSettings";

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
  const [qc, setQc] = useState<SpecContent["qc"]>({ smallRoi: "FLAG", lossy: "FLAG", smallRoiVoxels: null });
  const [labelsText, setLabelsText] = useState("");
  /** 抽出の種類。`voiStats` は一次統計だけ（族・ビン・再標本化・範囲の欄は隠す）。 */
  const [kind, setKind] = useState<SpecKind>("radiomics");
  const [specSha, setSpecSha] = useState("");
  /** QC で止まったあとに「許容して続ける」で許容した組のキー。設定を変えたら空に戻す。 */
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  /** 出力の選択。被験者の対応表は既定で書く（別ファイル）。患者 ID を表に含めるのは選んだときだけ。BOM は既定で付けない。 */
  const [subjectsFile, setSubjectsFile] = useState(true);
  const [includePatientId, setIncludePatientId] = useState(false);
  const [bom, setBom] = useState(false);
  /** 送信中（押してから応答が来るまで）。この間に押し直すと同じ組が二重に投入される。 */
  const [starting, setStarting] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const labels = useMemo(() => parseLabelInput(labelsText), [labelsText]);
  /** 被験者のコード。アルバムのスタディの並び順だけで決める（選んだ組には依らない）。 */
  const subjects = useMemo(
    () => assignSubjectCodes(uids, (u) => studies.get(u)?.patientId,
      Array.from(new Set((rows ?? []).map((r) => r.pair.studyUid)))),
    [uids, studies, rows],
  );
  const labelsRef = useRef<string[]>([]);
  labelsRef.current = labels;
  /** 実行中のジョブの、組ごとの症例ラベルと、試行かどうか。結果の `index` で引く。`spec` は実行に使った定義。 */
  const runRef = useRef<{ jobId: string; labels: string[]; keys: string[]; trial: boolean; spec: BatchSpec } | null>(null);

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
        setRows(applyLabelFilter(initialRows(pairs), labelsRef.current));
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

  // セグメント名の絞り込み
  useEffect(() => {
    setRows((prev) => (prev ? applyLabelFilter(prev, labels) : prev));
  }, [labels]);

  // 定義の SHA-256（設定の中身だけ。接頭辞は含めない）
  useEffect(() => {
    let alive = true;
    void contentSha256(specContentFrom(form, qc, labels, kind)).then((h) => alive && setSpecSha(h));
    return () => {
      alive = false;
    };
  }, [form, qc, labels, kind]);

  // 設定を変えたら、許容した組は無効にする（別の設定の結果で出た旗を引き継がない）
  useEffect(() => {
    setAcknowledged([]);
  }, [form, qc, kind]);

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
  /** 範囲の欄が数でない・下限が上限より大きい間は、実行も定義の保存もしない（範囲なしの定義が黙って作られるのを防ぐ）。 */
  const rangeProblem = kind === "voiStats" ? null : rangeBounds(form).problem;
  const dup = rows ? duplicateLabels(assignCaseLabels(rows)) : [];

  const start = async (isTrial: boolean, ack: readonly string[] = acknowledged, from?: readonly PairRow[]) => {
    const base = from ?? rows;
    if (!base || starting) return;
    setStarting(true);
    try {
      await startInner(isTrial, ack, base);
    } finally {
      setStarting(false);
    }
  };

  const startInner = async (isTrial: boolean, ack: readonly string[], base: readonly PairRow[]) => {
    setError(null);
    setInfo(null);
    setWritten(null);
    setResults(null);
    setTrial(null);
    const labelled = assignCaseLabels(base);
    setRows(labelled);
    const dups = duplicateLabels(labelled);
    if (dups.length > 0) return setError(t("roiFeat.batch.err.duplicate", { labels: dups.join(", ") }));
    let chosen = selectedPairs(labelled);
    if (isTrial) chosen = chosen.slice(0, 1);
    if (chosen.length === 0) return setError(t("roiFeat.batch.err.nothing"));
    try {
      const spec = await buildSpec(specContentFrom(form, qc, labels, kind), prefix);
      const st = await submitBatch(buildBatchRequest(chosen.map((c) => c.pair), form, {
        qc: isTrial ? null : { smallRoi: qc.smallRoi, lossy: qc.lossy }, acknowledged: ack, smallRoiVoxels: qc.smallRoiVoxels, kind,
      }));
      runRef.current = {
        jobId: st.jobId, labels: chosen.map((c) => c.caseLabel), keys: chosen.map((c) => pairKey(c.pair)),
        trial: isTrial, spec,
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
    const byIndex = new Map(results.map((r) => [r.index, r.result]));
    const dsRows: DatasetRow[] = job.pairs.map((p) => ({
      caseLabel: run.labels[p.index] ?? "", status: p, result: byIndex.get(p.index) ?? null,
    }));
    const out = datasetFiles(dsRows, subjects, {
      albumName, specSha256: run.spec.sha256, includePatientId, base: batchFileBase(prefix),
      specText: specText({ ...run.spec, output: { prefix } }), subjectsFile, bom, kind: run.spec.kind,
    });
    if (!out.ok) {
      return setError(
        out.reason === "header mismatch" ? t("roiFeat.batch.err.header", { label: out.caseLabel })
          : out.reason === "missing result" ? t("roiFeat.batch.err.missing", { label: out.caseLabel })
          : t("roiFeat.batch.err.noResult"),
      );
    }
    setError(null);
    const files = out.files;
    for (const f of files) downloadText(f.text, f.name, f.mime);
    setWritten(files.length);
  };

  const saveSpec = async () => {
    const spec = await buildSpec(specContentFrom(form, qc, labels, kind), prefix);
    downloadText(specText(spec), batchSpecFileName(prefix), "application/json;charset=utf-8");
    setInfo(t("roiFeat.batch.spec.saved", { sha: spec.sha256.slice(0, 8) }));
  };

  const loadSpec = async (f: File) => {
    setError(null);
    setInfo(null);
    if (f.size > SPEC_MAX_BYTES) return setError(t("roiFeat.batch.spec.err.too_large"));
    const r = await parseSpec(await f.text());
    if (!r.ok) return setError(t(`roiFeat.batch.spec.err.${r.error}`, { detail: r.detail }));
    setForm((cur) => applySpecToForm(cur, r.spec));
    setKind(r.spec.kind);
    setQc(r.spec.qc);
    setLabelsText(r.spec.selection.segmentLabels.join(", "));
    setPrefix(r.spec.output.prefix);
    setInfo(t("roiFeat.batch.spec.loaded", { sha: r.spec.sha256.slice(0, 8) })
      + (r.ignoredFamilies > 0 ? ` ${t("roiFeat.batch.spec.ignored", { n: r.ignoredFamilies })}` : ""));
  };

  /** QC で止まった組（全件実行のとき）。 */
  const qcHold = (() => {
    const run = runRef.current;
    if (!job || !run || run.trial || job.state !== "STOPPED" || job.stopKind !== "QC" || job.stopIndex == null) return null;
    const key = run.keys[job.stopIndex];
    const res = results?.find((x) => x.index === job.stopIndex)?.result;
    return { key, label: run.labels[job.stopIndex] ?? "", flags: (job.stopReason ?? "").split(",").filter(Boolean), size: res?.roiSize };
  })();

  const continueAcknowledging = () => {
    if (!qcHold) return;
    const ack = Array.from(new Set([...acknowledged, qcHold.key]));
    setAcknowledged(ack);
    void start(false, ack);
  };

  const continueExcluding = () => {
    if (!rows || !qcHold) return;
    const idx = rows.findIndex((r) => pairKey(r.pair) === qcHold.key);
    if (idx < 0) return;
    void start(false, acknowledged, setIncluded(rows, idx, false));
  };

  const unsetThreshold = smallRoiThresholdUnset(trial ? [trial.result] : (results ?? []).map((r) => r.result));

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
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
            <button type="button" style={btn} data-testid="batch-spec-save" disabled={running || rangeProblem !== null} onClick={() => void saveSpec()}>
              {t("roiFeat.batch.spec.save")}
            </button>
            <button type="button" style={btn} data-testid="batch-spec-load" disabled={running} onClick={() => fileRef.current?.click()}>
              {t("roiFeat.batch.spec.load")}
            </button>
            <input ref={fileRef} data-testid="batch-spec-file" type="file" accept=".json,application/json" style={{ display: "none" }}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void loadSpec(f); e.target.value = ""; }} />
            <span style={note} data-testid="batch-spec-sha" title={specSha}>
              {t("roiFeat.batch.spec.sha")}: {specSha ? `${specSha.slice(0, 8)}…${specSha.slice(-4)}` : "…"}
            </span>
          </div>
          {info && <div style={{ ...note, color: "#2f6b2f" }} data-testid="batch-info">{info}</div>}

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
                            {ps && ps.qcFlags.length > 0 && (
                              <span style={flagStyle} data-testid={`batch-flags-${i}`}>
                                {" "}⚑ {ps.qcFlags.map((f) => t(`roiFeat.batch.qcflag.${f}`)).join("・")}
                              </span>
                            )}
                            {!ps && r.filteredOut && <span style={flagStyle}> — {t("roiFeat.batch.filteredOut")}</span>}
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
              <BatchSettingsPanel form={form} setForm={setForm} disabled={running} qc={qc} setQc={setQc}
                labelsText={labelsText} setLabelsText={setLabelsText} kind={kind} setKind={setKind} />
              <div style={note}>{t("roiFeat.batch.scope")}</div>

              <div style={section}>{t("roiFeat.batch.step3")}</div>
              <label>
                {t("roiFeat.batch.prefix")}{" "}
                <input data-testid="batch-prefix" value={prefix} placeholder="roi-features-batch" disabled={running}
                  style={{ ...input, width: 220 }} onChange={(e) => setPrefix(e.target.value)} />
              </label>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 3 }} data-testid="batch-output-options">
                <label>
                  <input type="checkbox" data-testid="batch-out-subjects" checked={subjectsFile} disabled={running}
                    onChange={(e) => setSubjectsFile(e.target.checked)} /> {t("roiFeat.batch.out.subjects")}
                </label>
                <div style={note}>{t("roiFeat.batch.out.subjectsHelp")}</div>
                <label>
                  <input type="checkbox" data-testid="batch-out-patientid" checked={includePatientId} disabled={running}
                    onChange={(e) => setIncludePatientId(e.target.checked)} /> {t("roiFeat.batch.out.patientId")}
                </label>
                {includePatientId && <div style={{ ...note, color: "#b00020" }} data-testid="batch-out-patientid-warn">{t("roiFeat.batch.out.patientIdWarn")}</div>}
                <label>
                  <input type="checkbox" data-testid="batch-out-bom" checked={bom} disabled={running}
                    onChange={(e) => setBom(e.target.checked)} /> {t("roiFeat.batch.out.bom")}
                </label>
              </div>
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
              {job.state === "STOPPED" && job.stopKind !== "QC" && (
                <div style={errStyle}>{t("roiFeat.batch.stopped", { reason: job.stopReason ?? "" })}</div>
              )}
              {qcHold && (
                <div style={qcBox} data-testid="batch-qc-hold">
                  <div>
                    {t("roiFeat.batch.qc.held", { label: qcHold.label, flags: qcHold.flags.map((f) => t(`roiFeat.batch.qcflag.${f}`)).join("・") })}
                    {qcHold.flags.includes("SMALL_ROI") && qcHold.size?.intensityVoxels != null && qcHold.size.smallRoiWarnVoxels != null
                      && ` ${t("roiFeat.batch.qc.heldSize", { n: qcHold.size.intensityVoxels, threshold: qcHold.size.smallRoiWarnVoxels })}`}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button type="button" style={btnPrimary} data-testid="batch-qc-continue" disabled={starting} onClick={continueAcknowledging}>
                      {t("roiFeat.batch.qc.continue")}
                    </button>
                    <button type="button" style={btn} data-testid="batch-qc-exclude" disabled={starting} onClick={continueExcluding}>
                      {t("roiFeat.batch.qc.exclude")}
                    </button>
                  </div>
                </div>
              )}
              {job.state === "CANCELLED" && <div style={note}>{t("roiFeat.batch.cancelledNote")}</div>}
            </div>
          )}
          {trial && (
            <div style={{ ...note, color: "#1a4a80" }} data-testid="batch-trial-result">
              {t("roiFeat.batch.trialResult", { n: trial.result.rows.length, ms: job?.pairs[0]?.elapsedMs ?? 0 })}
            </div>
          )}
          {unsetThreshold && (qc.smallRoi === "STOP" || results || trial) && (
            <div style={{ ...note, color: "#7a4b00" }} data-testid="batch-unset-threshold">{t("roiFeat.batch.qc.unset")}</div>
          )}
          {written != null && <div style={{ ...note, color: "#2f6b2f" }} data-testid="batch-written">{t("roiFeat.batch.written", { n: written })}</div>}
        </div>
        <div style={footer}>
          <button type="button" style={btn} data-testid="batch-trial" disabled={rangeProblem !== null || running || starting || !summary || summary.selected === 0}
            onClick={() => void start(true)}>{t("roiFeat.batch.trial")}</button>
          <button type="button" style={btnPrimary} data-testid="batch-run" disabled={rangeProblem !== null || running || starting || !summary || summary.selected === 0}
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
const flagStyle: React.CSSProperties = { color: "#7a4b00" };
const qcBox: React.CSSProperties = { marginTop: 8, padding: "8px 10px", background: "#fff4d6", border: "1px solid #f0c36d", borderRadius: 4 };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const track: React.CSSProperties = { height: 6, marginTop: 6, borderRadius: 3, background: "#e1e7ee", overflow: "hidden" };
const bar: React.CSSProperties = { height: "100%", background: "#0b5cad", transition: "width 0.3s" };
