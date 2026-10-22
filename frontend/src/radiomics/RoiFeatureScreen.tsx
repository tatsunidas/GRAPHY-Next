/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Radiomics 特徴量（ROI）（別ウィンドウ `#radiomics-features`）。
 *
 * <p>RadiomicsJ の一括抽出で、マスクの ROI 全体を 1 つとして特徴量表を出す（研究用）。
 * 数値の定義は RadiomicsJ に一本化していて、各行に IBSI の識別子と、取り違えやすい定義の注記を付ける。
 *
 * <p>同じ画素・設定・RadiomicsJ の版なら backend がキャッシュから返すので、表の上にそれと計算日時を出す。
 * RadiomicsJ には途中で止める口が無いので、取り消しは「結果を出さない」だけで計算は最後まで走る。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { NumberField } from "../hooks/NumberField";
import { useI18n, type TFn } from "../i18n/i18n";
import { HttpError } from "../http";
import {
  cancelRoiFeatureJob,
  fetchMaxSection,
  fetchSeries,
  fetchSeriesLayout,
  getRoiFeatureJob,
  readDicomSegSegments,
  submitRoiFeatureJob,
  type MaxSectionResult,
  type RoiFeatureJobStatus,
  type RoiFeatureResult,
  type RoiFeatureRow,
  type RoiMode,
  type Series,
} from "../api";
import { formatFeatureValue } from "./GlamFeatureTable";
import { formatAreaMm2, formatPositionMm, tiePositions } from "./maxSection";
import { requestRemoteReveal } from "../viewer/roiRevealBridge";
import { compareRows, roiFeature2dFiles, type CompareRow } from "./roiFeatureModes";
import {
  discretisationOf,
  parseSettingsProperties,
  roiFeatureDataCsv,
  roiFeatureDefinitionsCsv,
  roiFeatureFileBase,
} from "./roiFeatureCsv";
import {
  ROI_FEATURE_FAMILIES,
  LOG_PADDINGS,
  anyFamilyOn,
  defaultRoiFeatureForm,
  parseSigmaList,
  roiFeatureSettings,
  splitFilteredFamily,
  type LogPadding,
  type RoiFeatureForm,
} from "./roiFeatureSettings";

interface RoiFeatureContext {
  studyInstanceUid: string;
  seriesInstanceUid?: string;
}

export const ROI_FEATURE_CTX_KEY = "graphy-roifeat-ctx";

const POLL_INTERVAL_MS = 700;
const FINISHED = new Set(["DONE", "FAILED", "CANCELLED"]);

/** 計算日時の表示（分まで）。backend の Instant は ISO 文字列か秒の数値で届く。 */
function formatComputedAt(v: string | number): string {
  const d = typeof v === "number" ? new Date(v * 1000) : new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function download(text: string, filename: string, type = "text/csv;charset=utf-8") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function RoiFeatureScreen() {
  const { t } = useI18n();

  const ctx = useMemo<RoiFeatureContext | null>(() => {
    try {
      const raw = localStorage.getItem(ROI_FEATURE_CTX_KEY);
      return raw ? (JSON.parse(raw) as RoiFeatureContext) : null;
    } catch {
      return null;
    }
  }, []);
  const studyUid = ctx?.studyInstanceUid ?? "";

  const [allSeries, setAllSeries] = useState<Series[]>([]);
  const [sourceSeriesUid, setSourceSeriesUid] = useState(ctx?.seriesInstanceUid ?? "");
  const [nC, setNC] = useState(1);
  const [nT, setNT] = useState(1);
  const [channel, setChannel] = useState(0);
  const [timePoint, setTimePoint] = useState(0);
  const [maskSeriesUid, setMaskSeriesUid] = useState("");
  const [maskChannel, setMaskChannel] = useState(0);
  const [maskNC, setMaskNC] = useState(1);
  const [maskSegmentNames, setMaskSegmentNames] = useState<string[]>([]);
  const [form, setForm] = useState<RoiFeatureForm>(defaultRoiFeatureForm);
  /** 計算の単位（3D は常に計算する）。既定は 3D だけ＝従来と同じ。 */
  const [sectionOn, setSectionOn] = useState(false);
  const [slicesOn, setSlicesOn] = useState(false);
  /** 症例を突き合わせるための任意の文字列（CSV の CaseLabel 列とファイル名）。患者情報は入れない。 */
  const [caseLabel, setCaseLabel] = useState("");

  const [job, setJob] = useState<RoiFeatureJobStatus | null>(null);
  const jobIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RoiFeatureResult | null>(null);
  /** 結果を出したときの対象（CSV のファイル名に使う。欄を選び直しても取り違えない）。 */
  const [resultFor, setResultFor] = useState<{ seriesNumber?: number | string | null; maskChannel: number } | null>(null);
  const [query, setQuery] = useState("");

  /** 選んだ ROI の最大断面。ROI を選び直すたびに求める（特徴量の計算とは独立）。 */
  const [maxSection, setMaxSection] = useState<{ result?: MaxSectionResult; error?: string } | null>(null);

  const [revealMsg, setRevealMsg] = useState<string | null>(null);
  useEffect(() => setRevealMsg(null), [maxSection]);

  const showInViewer = async (r: MaxSectionResult) => {
    const toast = t("roiFeat.maxSection.toast", {
      pos: formatPositionMm(r.best.positionMm), area: formatAreaMm2(r.best.areaMm2),
    });
    const outcome = await requestRemoteReveal({
      sopInstanceUid: r.best.sopInstanceUid,
      frame: r.best.frame >= 0 ? r.best.frame : null,
      seriesUid: sourceSeriesUid,
    }, toast);
    setRevealMsg(outcome === "ok" ? toast : outcome === "locked" ? t("roiFeat.maxSection.locked") : t("roiFeat.maxSection.noViewer"));
  };

  const busy = job != null && !FINISHED.has(job.state);

  useEffect(() => {
    if (!studyUid) return;
    void fetchSeries(studyUid)
      .then((list) => {
        setAllSeries(list);
        if (!sourceSeriesUid && list.length) setSourceSeriesUid(list[0].seriesInstanceUid);
      })
      .catch((e: unknown) => setError(t("common.fetchError", { error: String(e) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyUid]);

  // ターゲットの C/T 次元。2 以上のときだけ選択欄を出す。
  useEffect(() => {
    let cancelled = false;
    setChannel(0);
    setTimePoint(0);
    if (maskSeriesUid && maskSeriesUid === sourceSeriesUid) setMaskSeriesUid("");
    if (!studyUid || !sourceSeriesUid) return;
    void fetchSeriesLayout(studyUid, sourceSeriesUid)
      .then((layout) => {
        if (cancelled) return;
        setNC(Math.max(1, layout.nC));
        setNT(Math.max(1, layout.nT));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studyUid, sourceSeriesUid]);

  // マスクのセグメント（SEG のマルチセグメントは 1 セグメント = 1 チャンネル）と、その名前。
  useEffect(() => {
    let cancelled = false;
    setMaskChannel(0);
    setMaskSegmentNames([]);
    if (!studyUid || !maskSeriesUid) {
      setMaskNC(1);
      return;
    }
    void fetchSeriesLayout(studyUid, maskSeriesUid)
      .then((layout) => {
        if (cancelled) return;
        const nc = Math.max(1, layout.nC);
        setMaskNC(nc);
        if (nc <= 1) return;
        return readDicomSegSegments(studyUid, maskSeriesUid)
          .then((seg) => {
            if (cancelled || seg.segments.length !== nc) return;
            setMaskSegmentNames(seg.segments.map((s) => s.label || s.description || ""));
          })
          .catch(() => {});
      })
      .catch(() => {
        if (!cancelled) setMaskNC(1);
      });
    return () => {
      cancelled = true;
    };
  }, [studyUid, maskSeriesUid]);

  useEffect(() => {
    let cancelled = false;
    setMaxSection(null);
    if (!studyUid || !sourceSeriesUid || !maskSeriesUid) return;
    void fetchMaxSection({
      studyInstanceUid: studyUid, sourceSeriesUid, maskSeriesUid, maskChannel, channel, timePoint, label: 1,
    })
      .then((result) => { if (!cancelled) setMaxSection({ result }); })
      .catch((e) => {
        if (!cancelled) setMaxSection({ error: e instanceof HttpError ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [studyUid, sourceSeriesUid, maskSeriesUid, maskChannel, channel, timePoint]);

  // ジョブの問い合わせ。取り消し後や投げ直し後の古い応答は jobId で捨てる。
  useEffect(() => {
    if (!job || FINISHED.has(job.state)) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getRoiFeatureJob(job.jobId)
        .then((next) => {
          if (cancelled || jobIdRef.current !== next.jobId) return;
          setJob(next);
          if (next.state === "DONE" && next.result) setResult(next.result);
          else if (next.state === "FAILED") setError(next.error ?? t("roiFeat.err.failed"));
        })
        .catch((e) => {
          if (cancelled) return;
          setJob(null);
          setError(t("common.fetchError", { error: String(e) }));
        });
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  const maskCandidates = useMemo(
    () => allSeries.filter((s) => s.seriesInstanceUid !== sourceSeriesUid),
    [allSeries, sourceSeriesUid],
  );

  const run = async (recompute: boolean) => {
    setError(null);
    if (!maskSeriesUid) return setError(t("roiFeat.err.needMask"));
    if (!anyFamilyOn(form)) return setError(t("roiFeat.err.noFamily"));
    if (form.logOn && !parseSigmaList(form.logSigmaMm)) return setError(t("roiFeat.err.sigma"));
    try {
      const status = await submitRoiFeatureJob({
        studyInstanceUid: studyUid,
        sourceSeriesUid,
        maskSeriesUid,
        maskChannel,
        channel,
        timePoint,
        settings: roiFeatureSettings(form),
        recompute,
        roiModes: [
          "WHOLE_3D",
          ...(sectionOn ? ["MAX_SECTION_2D" as RoiMode] : []),
          ...(slicesOn ? ["SLICES_2D" as RoiMode] : []),
        ],
      });
      jobIdRef.current = status.jobId;
      setResult(null);
      setResultFor({
        seriesNumber: allSeries.find((s) => s.seriesInstanceUid === sourceSeriesUid)?.seriesNumber,
        maskChannel,
      });
      setJob(status);
    } catch (e) {
      // web モード・公開デモは backend が 403 で理由を返す。
      setError(e instanceof HttpError && e.status === 403
        ? t("roiFeat.err.forbidden", { error: e.message })
        : t("common.fetchError", { error: String(e) }));
    }
  };

  const onCancel = () => {
    const id = jobIdRef.current;
    if (!id) return;
    void cancelRoiFeatureJob(id)
      .then(setJob)
      .catch(() => {});
  };

  const fileBase = () => roiFeatureFileBase(resultFor?.seriesNumber, resultFor?.maskChannel ?? 0, caseLabel);

  const onCsv = () => {
    if (!result) return;
    const base = fileBase();
    download(roiFeatureDataCsv(result, caseLabel.trim()), `${base}.csv`);
    download(roiFeatureDefinitionsCsv(result), `${base}_definitions.csv`);
    for (const f of roiFeature2dFiles(result, caseLabel.trim())) download(f.text, `${base}${f.suffix}`, f.mime);
  };

  /** 設定ファイルは backend が正規化した本文を一字も変えずに保存する（CSV のハッシュと一致させる）。 */
  const onSettingsFile = () => {
    if (!result) return;
    download(result.settingsProperties, `${fileBase()}_radiomicsj.properties`, "text/plain;charset=utf-8");
  };

  /** 表の上の要約。画面の欄ではなく、計算に実際に使った設定から作る。 */
  const settingsSummary = useMemo(() => {
    if (!result) return "";
    const p = parseSettingsProperties(result.settingsProperties);
    const disc = p.BOOL_USE_FixedBinNumber === "1"
      ? t("roiFeat.disc.bins", { n: p.INT_binCount ?? "?" })
      : t("roiFeat.disc.width", { w: p.DOUBLE_binWidth ?? "?" });
    const rs = p.DOUBLEARRAY_resamplingFactorXYZ
      ? t("roiFeat.summary.resampled", { mm: p.DOUBLEARRAY_resamplingFactorXYZ.split(",").map(Number).join(" × ") })
      : t("roiFeat.summary.noResampling");
    const on = ROI_FEATURE_FAMILIES.filter((f) => p[f.setting] === "1").length;
    const sig = p.DOUBLEARRAY_logSigmaMm;
    const filter = sig
      ? t("roiFeat.summary.log", {
        sigma: sig.split(",").join(", "), truncate: p.DOUBLE_logTruncate ?? "?", padding: p.STRING_logPadding ?? "?",
      })
      : "";
    return t("roiFeat.summary.settings", { disc, resampling: rs, filter, on, total: ROI_FEATURE_FAMILIES.length });
  }, [result, t]);

  const setFamily = (key: string, on: boolean) =>
    setForm((f) => ({ ...f, families: { ...f.families, [key]: on } }));

  const seriesLabel = (s: Series) =>
    `#${s.seriesNumber ?? "?"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`.trim();

  const familyLabel = (family: string): string => {
    const f = splitFilteredFamily(family);
    if (f) return t("roiFeat.family.log", { sigma: f.sigma, family: familyLabel(f.base) });
    const k = `roiFeat.family.${family}`;
    const v = t(k);
    return v === k ? family : v;
  };

  /** 族ごとにまとめた表（検索語で絞る）。並びは RadiomicsJ の結果表のまま。 */
  const groups = useMemo(() => {
    if (!result) return [];
    const q = query.trim().toLowerCase();
    const out: { family: string; rows: RoiFeatureRow[] }[] = [];
    for (const r of result.rows) {
      if (q && !r.column.toLowerCase().includes(q)) continue;
      const last = out[out.length - 1];
      if (last && last.family === r.family) last.rows.push(r);
      else out.push({ family: r.family, rows: [r] });
    }
    return out;
  }, [result, query]);

  const discretisationLabel = (family: string) => {
    if (!result) return "";
    const d = result.discretisation;
    const raw = discretisationOf(family, d);
    if (!raw) return "";
    if (raw.startsWith("fixedBinNumber")) return t("roiFeat.disc.bins", { n: d.nBins });
    if (raw.startsWith("binWidth")) return t("roiFeat.disc.width", { w: d.binWidth });
    return t("roiFeat.disc.ivh", { mode: d.ivhMode, bins: d.ivhBinCount, width: d.ivhBinWidth });
  };

  return (
    <div style={page}>
      <div style={header}>{t("roiFeat.title")}</div>
      <div style={note}>{t("roiFeat.researchOnly")}</div>

      {!studyUid && <div style={errText}>{t("roiFeat.err.noContext")}</div>}

      <div style={panel}>
        <Field label={t("roiFeat.field.target")}>
          <select value={sourceSeriesUid} onChange={(e) => setSourceSeriesUid(e.target.value)}
            disabled={busy} style={input} data-testid="roifeat-target">
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
        <Field label={t("roiFeat.field.mask")}>
          <select value={maskSeriesUid} onChange={(e) => setMaskSeriesUid(e.target.value)}
            disabled={busy} style={input} data-testid="roifeat-mask">
            <option value="">{t("roiFeat.mask.none")}</option>
            {maskCandidates.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
            ))}
          </select>
        </Field>
        {maskSeriesUid !== "" && maskNC > 1 && (
          <Field label={t("texture.field.maskChannel")}>
            <select value={maskChannel} onChange={(e) => setMaskChannel(Number(e.target.value))}
              disabled={busy} style={input}>
              {Array.from({ length: maskNC }, (_, i) => (
                <option key={i} value={i}>{maskSegmentNames[i] ? `${i}: ${maskSegmentNames[i]}` : String(i)}</option>
              ))}
            </select>
          </Field>
        )}
        <div style={note}>{t("roiFeat.mask.help")}</div>
        {maskSeriesUid !== "" && maxSection && (
          <div style={maxSection.error ? errText : { ...note, color: "#1f2d3d", fontSize: 12 }} data-testid="roifeat-maxsection">
            {maxSection.result ? (
              <>
                {t("roiFeat.maxSection.line", {
                  pos: formatPositionMm(maxSection.result.best.positionMm),
                  total: maxSection.result.totalSlices,
                  area: formatAreaMm2(maxSection.result.best.areaMm2),
                  pixels: maxSection.result.best.pixels,
                })}
                {maxSection.result.ties.length > 1 && (
                  <div style={note} data-testid="roifeat-maxsection-ties">
                    {t("roiFeat.maxSection.ties", {
                      n: maxSection.result.ties.length, positions: tiePositions(maxSection.result),
                    })}
                  </div>
                )}
                <div style={note}>{t("roiFeat.maxSection.basis")}</div>
                <button onClick={() => void showInViewer(maxSection.result!)} style={miniBtn} data-testid="roifeat-maxsection-show">
                  {t("roiFeat.maxSection.show")}
                </button>
                {revealMsg && <span style={{ ...note, marginLeft: 8 }} data-testid="roifeat-maxsection-reveal">{revealMsg}</span>}
              </>
            ) : maxSection.error}
          </div>
        )}
        <Field label={t("roiFeat.field.caseLabel")}>
          <input value={caseLabel} onChange={(e) => setCaseLabel(e.target.value)} placeholder="case-012"
            style={input} data-testid="roifeat-caselabel" />
        </Field>
        <div style={note}>{t("roiFeat.caseLabel.help")}</div>

        <Field label={t("roiFeat.field.modes")}>
          <span style={{ display: "inline-flex", gap: 10, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <label title={t("roiFeat.mode.alwaysOn")}>
              <input type="checkbox" checked disabled data-testid="roifeat-mode-whole" /> {t("roiFeat.mode.whole")}
            </label>
            <label>
              <input type="checkbox" checked={sectionOn} disabled={busy} data-testid="roifeat-mode-section"
                onChange={(e) => setSectionOn(e.target.checked)} /> {t("roiFeat.mode.section")}
            </label>
            <label>
              <input type="checkbox" checked={slicesOn} disabled={busy} data-testid="roifeat-mode-slices"
                onChange={(e) => setSlicesOn(e.target.checked)} /> {t("roiFeat.mode.slices")}
            </label>
          </span>
        </Field>
        {(sectionOn || slicesOn) && <div style={note}>{t("roiFeat.mode.note2d")}</div>}

        <Field label={t("roiFeat.field.discretisation")}>
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
            <label>
              <input type="radio" checked={form.fixedBinNumber} disabled={busy}
                onChange={() => setForm((f) => ({ ...f, fixedBinNumber: true }))} /> {t("roiFeat.disc.binCount")}
            </label>
            <span data-testid="roifeat-bincount">
              <NumberField value={form.binCount} onChange={(v) => setForm((f) => ({ ...f, binCount: v }))}
                min={2} max={1024} disabled={busy || !form.fixedBinNumber} style={{ ...input, width: 64 }} />
            </span>
            <label>
              <input type="radio" checked={!form.fixedBinNumber} disabled={busy}
                onChange={() => setForm((f) => ({ ...f, fixedBinNumber: false }))} /> {t("roiFeat.disc.binWidth")}
            </label>
            <NumberField value={form.binWidth} onChange={(v) => setForm((f) => ({ ...f, binWidth: v }))}
              min={0.001} max={100000} step={0.5} disabled={busy || form.fixedBinNumber} style={{ ...input, width: 64 }} />
          </span>
        </Field>
        <Field label={t("roiFeat.field.resampling")}>
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "flex-end" }}>
            <select value={form.resampleMm == null ? "none" : "iso"} disabled={busy} style={{ ...input, width: 110 }}
              onChange={(e) => setForm((f) => ({ ...f, resampleMm: e.target.value === "none" ? null : 1 }))}>
              <option value="none">{t("roiFeat.resampling.none")}</option>
              <option value="iso">{t("roiFeat.resampling.iso")}</option>
            </select>
            {form.resampleMm != null && (
              <>
                <NumberField value={form.resampleMm} onChange={(v) => setForm((f) => ({ ...f, resampleMm: v }))}
                  min={0.05} max={20} step={0.1} disabled={busy} style={{ ...input, width: 64 }} />
                <span>mm</span>
              </>
            )}
          </span>
        </Field>
        <Field label={t("roiFeat.field.filter")}>
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center", justifyContent: "flex-end", flexWrap: "wrap" }}>
            <label>
              <input type="radio" checked={!form.logOn} disabled={busy} data-testid="roifeat-filter-none"
                onChange={() => setForm((f) => ({ ...f, logOn: false }))} /> {t("roiFeat.filter.none")}
            </label>
            <label>
              <input type="radio" checked={form.logOn} disabled={busy} data-testid="roifeat-filter-log"
                onChange={() => setForm((f) => ({ ...f, logOn: true }))} /> {t("roiFeat.filter.log")}
            </label>
          </span>
        </Field>
        {form.logOn && (
          <>
            <Field label={t("roiFeat.filter.sigma")}>
              <input value={form.logSigmaMm} disabled={busy} style={{ ...input, width: 120 }} data-testid="roifeat-log-sigma"
                onChange={(e) => setForm((f) => ({ ...f, logSigmaMm: e.target.value }))} />
            </Field>
            <Field label={t("roiFeat.filter.truncate")}>
              <NumberField value={form.logTruncate} onChange={(v) => setForm((f) => ({ ...f, logTruncate: v }))}
                min={1} max={10} step={0.5} disabled={busy} style={{ ...input, width: 64 }} />
            </Field>
            <Field label={t("roiFeat.filter.padding")}>
              <select value={form.logPadding} disabled={busy} style={{ ...input, width: 120 }} data-testid="roifeat-log-padding"
                onChange={(e) => setForm((f) => ({ ...f, logPadding: e.target.value as LogPadding }))}>
                {LOG_PADDINGS.map((pd) => <option key={pd} value={pd}>{pd}</option>)}
              </select>
            </Field>
            <div style={note}>{t("roiFeat.filter.note")}</div>
          </>
        )}
        <div style={{ ...fieldLabel, marginTop: 6 }}>{t("roiFeat.field.families")}</div>
        <div style={familyGrid}>
          {ROI_FEATURE_FAMILIES.map((f) => (
            <label key={f.key}>
              <input type="checkbox" checked={!!form.families[f.key]} disabled={busy}
                onChange={(e) => setFamily(f.key, e.target.checked)} /> {familyLabel(f.key)}
            </label>
          ))}
        </div>
        {form.families.GLAM && <div style={note}>{t("roiFeat.glamNote")}</div>}

        <div style={{ display: "flex", gap: 6, marginTop: 10, justifyContent: "flex-end" }}>
          <button onClick={() => void run(false)} disabled={busy || !studyUid}
            style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }} data-testid="roifeat-run">
            {t("roiFeat.run")}
          </button>
        </div>

        {busy && job && (
          <>
            <div style={progressTrack}>
              <div style={progressBar} />
              <style>{"@keyframes roifeatbar{0%{left:-40%}100%{left:100%}}"}</style>
            </div>
            <div style={{ ...note, display: "flex", gap: 8, alignItems: "center" }} data-testid="roifeat-progress">
              <span>{t(job.state === "EXTRACTING" ? "roiFeat.state.extracting" : "roiFeat.state.loading", {
                seconds: Math.round(job.elapsedMs / 1000),
              })}</span>
              {(job.sliceTotal ?? 0) > 0 && (
                <span data-testid="roifeat-slice-progress">
                  {t("roiFeat.sliceProgress", { done: job.sliceDone ?? 0, total: job.sliceTotal ?? 0 })}
                </span>
              )}
              <button onClick={onCancel} style={miniBtn}>{t("roiFeat.cancel")}</button>
              <span>{t((job.sliceTotal ?? 0) > 0 ? "roiFeat.cancelNote2d" : "roiFeat.cancelNote")}</span>
            </div>
          </>
        )}
        {job?.state === "CANCELLED" && <div style={note}>{t("roiFeat.cancelled")}</div>}
        {error && <div style={errText} data-testid="roifeat-error">{error}</div>}
      </div>

      {result && (
        <div style={{ marginTop: 16 }}>
          <div style={summaryRow} data-testid="roifeat-summary">
            <span style={result.fromCache ? cachePill : infoPill}>
              {result.fromCache
                ? t("roiFeat.fromCache", { at: formatComputedAt(result.computedAt) })
                : t("roiFeat.computed", { at: formatComputedAt(result.computedAt) })}
              {result.radiomicsjVersion ? ` · RadiomicsJ ${result.radiomicsjVersion}` : ""}
            </span>
            <button onClick={() => void run(true)} disabled={busy} style={btn} data-testid="roifeat-recompute">
              {t("roiFeat.recompute")}
            </button>
            <span style={{ flex: 1 }} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("roiFeat.search")}
              style={{ ...input, width: 200 }} />
            <button onClick={onCsv} style={btn} data-testid="roifeat-csv">{t("roiFeat.csv")}</button>
          </div>
          <div style={{ ...summaryRow, marginTop: 6 }} data-testid="roifeat-provenance">
            <span style={note}>
              {t("roiFeat.summary.versions", {
                next: result.provenance.graphyNextVersion,
                rj: result.provenance.radiomicsjVersion ?? "?",
                sha: `${result.provenance.settingsSha256.slice(0, 4)}…${result.provenance.settingsSha256.slice(-2)}`,
              })}
            </span>
            <button onClick={onSettingsFile} style={miniBtn} data-testid="roifeat-settings-file"
              title={result.provenance.settingsSha256}>
              {t("roiFeat.settingsFile")}
            </button>
          </div>
          <div style={note} data-testid="roifeat-settings-summary">{settingsSummary}</div>
          {result.lossyCompressed && (
            <div style={warnBand} data-testid="roifeat-lossy-warning">⚠ {t("radiomics.lossyWarning")}</div>
          )}
          {result.roiSize.smallRoi && (
            <div style={warnBand} data-testid="roifeat-smallroi-warning">
              ⚠ {t("roiFeat.smallRoiWarning", {
                n: count(result.roiSize.intensityVoxels),
                threshold: count(result.roiSize.smallRoiWarnVoxels),
              })}
            </div>
          )}
          <div style={note} data-testid="roifeat-roisize">
            {t("roiFeat.roiSize", {
              initial: count(result.roiSize.initialVoxels),
              intensity: count(result.roiSize.intensityVoxels),
              morph: count(result.roiSize.morphVoxels),
              volume: result.roiSize.volumeMm3 == null ? "?" : result.roiSize.volumeMm3.toFixed(1),
            })}
          </div>
          <div style={note}>{t("roiFeat.count", { n: result.rows.length })}</div>
          {(result.section || result.slices) && <Modes2dPanel result={result} t={t} />}

          {(result.section || result.slices) ? (
            <CompareTable result={result} query={query} familyLabel={familyLabel} t={t} />
          ) : (
          <table style={table} data-testid="roifeat-table">
            <thead>
              <tr>
                <th style={th}>{t("roiFeat.col.feature")}</th>
                <th style={th}>{t("roiFeat.col.ibsi")}</th>
                <th style={{ ...th, textAlign: "right" }}>{t("roiFeat.col.value")}</th>
                <th style={th}>{t("roiFeat.col.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <FamilyRows key={g.family} label={familyLabel(g.family)} raw={g.family}
                  discretisation={discretisationLabel(g.family)} rows={g.rows} t={t} />
              ))}
            </tbody>
          </table>
          )}
        </div>
      )}
    </div>
  );
}

/** 2D の単位の要約: 最大断面の位置・面積、スライス別の枚数・失敗・小さい ROI、スライス別の表（折りたたみ）。 */
function Modes2dPanel({ result, t }: { result: RoiFeatureResult; t: TFn }) {
  const sec = result.section;
  const sl = result.slices;
  return (
    <div data-testid="roifeat-modes2d">
      {sec && (
        <div style={note} data-testid="roifeat-section-summary">
          {t("roiFeat.section.summary", {
            pos: formatPositionMm(sec.positionMm), area: formatAreaMm2(sec.areaMm2), pixels: sec.pixels,
          })}
        </div>
      )}
      {sl && (
        <>
          <div style={note} data-testid="roifeat-slices-summary">
            {t("roiFeat.slices.summary", { used: sl.rows.length, total: sl.foregroundSlices, failed: sl.failures.length })}
          </div>
          {sl.failures.length > 0 && (
            <div style={warnBand} data-testid="roifeat-slices-failures">
              ⚠ {t("roiFeat.slices.failures", {
                n: sl.failures.length,
                list: sl.failures.map((f) => `${formatPositionMm(f.positionMm)} mm`).join(", "),
              })}
              <div>{sl.failures.map((f) => f.reason).filter((v, i, a) => a.indexOf(v) === i).join(" / ")}</div>
            </div>
          )}
          {sl.smallRoiWarnPixels != null && sl.smallRoiPositionsMm.length > 0 && (
            <div style={warnBand} data-testid="roifeat-slices-small">
              ⚠ {t("roiFeat.slices.small", {
                n: sl.smallRoiPositionsMm.length,
                threshold: sl.smallRoiWarnPixels,
                list: sl.smallRoiPositionsMm.map((p) => `${formatPositionMm(p)} mm`).join(", "),
              })}
            </div>
          )}
          <details style={{ marginTop: 6 }} data-testid="roifeat-slices-details">
            <summary style={{ cursor: "pointer", color: "#0b5cad" }}>{t("roiFeat.slices.open")}</summary>
            <table style={table} data-testid="roifeat-slices-table">
              <thead>
                <tr>
                  <th style={th}>{t("roiFeat.slices.col.pos")}</th>
                  <th style={{ ...th, textAlign: "right" }}>{t("roiFeat.slices.col.pixels")}</th>
                  <th style={{ ...th, textAlign: "right" }}>{t("roiFeat.slices.col.area")}</th>
                  <th style={{ ...th, textAlign: "right" }}>{MEAN_COLUMN}</th>
                </tr>
              </thead>
              <tbody>
                {sl.rows.map((r) => (
                  <tr key={r.positionMm} style={{ borderTop: "1px solid #eef2f6" }}>
                    <td style={td}>{formatPositionMm(r.positionMm)}</td>
                    <td style={{ ...td, textAlign: "right" }}>{r.pixels}</td>
                    <td style={{ ...td, textAlign: "right" }}>{formatAreaMm2(r.areaMm2)}</td>
                    <td style={{ ...td, textAlign: "right" }}>
                      {fmtCell(r.rows.find((x) => x.column === MEAN_COLUMN)?.value)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </div>
  );
}

const MEAN_COLUMN = "IntensityBasedStatistical_Mean";

/** undefined＝その単位では計算しない（—）、null＝NaN。 */
const fmtCell = (v: number | null | undefined): string =>
  v === undefined ? "—" : v === null ? "NaN" : formatFeatureValue(v);

/** 3 単位を並べた表（行＝特徴、列＝単位）。2D で計算しない特徴は「—」。 */
function CompareTable({ result, query, familyLabel, t }: {
  result: RoiFeatureResult;
  query: string;
  familyLabel: (family: string) => string;
  t: TFn;
}) {
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return compareRows(result).filter((r) => !q || r.column.toLowerCase().includes(q));
  }, [result, query]);
  const groups: { family: string; rows: CompareRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.family === r.family) last.rows.push(r);
    else groups.push({ family: r.family, rows: [r] });
  }
  const showSection = !!result.section;
  const showSlices = !!result.slices;
  const cols = 4 + (showSection ? 1 : 0) + (showSlices ? 2 : 0);
  return (
    <table style={table} data-testid="roifeat-table">
      <thead>
        <tr>
          <th style={th}>{t("roiFeat.col.feature")}</th>
          <th style={th}>{t("roiFeat.col.ibsi")}</th>
          <th style={{ ...th, textAlign: "right" }}>{t("roiFeat.col.whole")}</th>
          {showSection && <th style={{ ...th, textAlign: "right" }}>{t("roiFeat.col.section")}</th>}
          {showSlices && <th style={{ ...th, textAlign: "right" }}>{t("roiFeat.col.sliceMean")}</th>}
          {showSlices && <th style={{ ...th, textAlign: "right" }}>{t("roiFeat.col.sliceWeighted")}</th>}
          <th style={th}>{t("roiFeat.col.notes")}</th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => (
          <Fragment key={g.family}>
            <tr><td colSpan={cols} style={familyHead}>{familyLabel(g.family)}</td></tr>
            {g.rows.map((r) => (
              <tr key={r.column} style={{ borderTop: "1px solid #eef2f6" }} data-testid={`roifeat-cmp-${r.column}`}>
                <td style={td} title={r.column}>{r.feature}</td>
                <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
                  {r.ibsi ?? (r.family === "Diagnostics" || splitFilteredFamily(r.family) ? "" : t("roiFeat.nonIbsi"))}
                </td>
                <td style={valCell} data-col="whole">{fmtCell(r.whole)}</td>
                {showSection && <td style={valCell} data-col="section">{fmtCell(r.section)}</td>}
                {showSlices && <td style={valCell} data-col="sliceMean">{fmtCell(r.sliceMean)}</td>}
                {showSlices && <td style={valCell} data-col="sliceWeighted">{fmtCell(r.sliceWeighted)}</td>}
                <td style={td}>{r.notes.map((n) => t(`roiFeat.note.${n}`)).join("・")}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

const valCell: React.CSSProperties = {
  padding: "2px 6px", verticalAlign: "top", textAlign: "right", fontVariantNumeric: "tabular-nums",
};

function FamilyRows({ label, raw, discretisation, rows, t }: {
  label: string;
  raw: string;
  discretisation: string;
  rows: RoiFeatureRow[];
  t: TFn;
}) {
  return (
    <>
      <tr>
        <td colSpan={4} style={familyHead}>
          {label}
          {label !== raw && <span style={rawName}>{raw}</span>}
          {discretisation && <span style={discPill}>{discretisation}</span>}
        </td>
      </tr>
      {rows.map((r) => (
        <tr key={r.column} style={{ borderTop: "1px solid #eef2f6" }}>
          <td style={td} title={r.column}>{r.feature}</td>
          {/* Diagnostics は特徴量ではなく付帯情報（寸法・ボクセル数）なので、IBSI の欄は空にする。 */}
          <td style={{ ...td, fontFamily: "ui-monospace, monospace" }}>
            {r.ibsi ?? (r.family === "Diagnostics" || splitFilteredFamily(r.family) ? "" : t("roiFeat.nonIbsi"))}
          </td>
          <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}
            title={r.value == null ? "NaN" : String(r.value)}>
            {r.value == null ? "NaN" : formatFeatureValue(r.value)}
          </td>
          <td style={td}>{r.notes.map((n) => t(`roiFeat.note.${n}`)).join("・")}</td>
        </tr>
      ))}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "3px 0" }}>
      <span style={{ ...fieldLabel, flex: "none", minWidth: 150 }}>{label}</span>
      <span style={{ flex: 1, textAlign: "right" }}>{children}</span>
    </div>
  );
}

const page: React.CSSProperties = { padding: 16, fontSize: 12, color: "#222", background: "#fff", minHeight: "100vh" };
const header: React.CSSProperties = { fontSize: 15, fontWeight: 600, color: "#0b5cad", marginBottom: 4 };
const panel: React.CSSProperties = {
  border: "1px solid #dfe5ec", borderRadius: 8, padding: 12, marginTop: 10, maxWidth: 640,
};
const fieldLabel: React.CSSProperties = { color: "#5a6672" };
const familyGrid: React.CSSProperties = {
  display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "2px 10px", marginTop: 4,
};
const input: React.CSSProperties = {
  width: "100%", boxSizing: "border-box", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px",
};
const note: React.CSSProperties = { color: "#6b7785", fontSize: 11, marginTop: 4, lineHeight: 1.5 };
const warnBand: React.CSSProperties = {
  marginTop: 6, padding: "6px 10px", fontSize: 12, color: "#7a4b00", background: "#fff4d6",
  border: "1px solid #f0c36d", borderRadius: 4,
};
const count = (n: number | null): string => (n == null ? "?" : n.toLocaleString("en-US"));
const errText: React.CSSProperties = { color: "#b00020", marginTop: 8, whiteSpace: "pre-wrap" };
const summaryRow: React.CSSProperties = { display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" };
const infoPill: React.CSSProperties = {
  color: "#0b5cad", background: "#eef5fc", border: "1px solid #c3daf1", borderRadius: 999, padding: "2px 10px",
};
const cachePill: React.CSSProperties = {
  color: "#2f6b2f", background: "#eef8ee", border: "1px solid #bfdfbf", borderRadius: 999, padding: "2px 10px",
};
const discPill: React.CSSProperties = {
  marginLeft: 10, fontWeight: 400, color: "#5a6672", background: "#f3f5f8", border: "1px solid #dfe5ec",
  borderRadius: 999, padding: "0 8px", fontSize: 11,
};
const rawName: React.CSSProperties = { marginLeft: 8, fontWeight: 400, color: "#8a96a3", fontSize: 11 };
const table: React.CSSProperties = { width: "100%", maxWidth: 900, marginTop: 8, borderCollapse: "collapse", fontSize: 12 };
const th: React.CSSProperties = {
  textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #cdd5de", color: "#5a6672", fontWeight: 600,
};
const td: React.CSSProperties = { padding: "2px 6px", verticalAlign: "top" };
const familyHead: React.CSSProperties = {
  padding: "8px 6px 3px", fontWeight: 600, color: "#0b5cad", borderTop: "1px solid #dfe5ec",
};
const progressTrack: React.CSSProperties = {
  position: "relative", height: 6, marginTop: 10, borderRadius: 3, background: "#e1e7ee", overflow: "hidden",
};
const progressBar: React.CSSProperties = {
  position: "absolute", top: 0, height: "100%", width: "40%", borderRadius: 3,
  background: "#0b5cad", animation: "roifeatbar 1.1s linear infinite",
};
const btn: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const miniBtn: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 4, background: "#fff", cursor: "pointer", fontSize: 11, padding: "1px 8px",
};
