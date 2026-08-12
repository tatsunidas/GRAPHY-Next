/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Texture（Radiomics 可視化マップ）ダイアログ。SUV 校正ダイアログと同型の設定モーダル。
 *
 * <p>ターゲットシリーズ（＋任意マスク）と特徴・カーネル・stride・2D/3D を指定して
 * {@code POST /api/series/texture} を呼び、計算された可視化マップ（派生シリーズ）を保存する。
 * Radiomics の各種パラメータは環境設定 Settings ▸ Texture（{@code texture.*} キー）から取得する。
 * バッチ処理は対象外（単一マップのみ）。設計 {@code fw/texture-radiomics-design.md}。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import {
  fetchSeries,
  fetchSeriesLayout,
  submitTextureJob,
  getTextureJob,
  cancelTextureJob,
  type Series,
  type Study,
  type TextureJobStatus,
} from "../api";
import { fetchSettings } from "../settings/settingsApi";
import {
  TEXTURE_FAMILIES,
  GLAM_FAMILY_KEY,
  GLAM_MATRICES,
  GLAM_MIN_FILTER_SIZE,
  glamFeatureString,
  glamStatisticsFor,
} from "./textureFeatures";

/** ジョブの進み具合を見に行く間隔。 */
const POLL_INTERVAL_MS = 700;

export function TextureDialog({
  study,
  series,
  onCreated,
  onClose,
}: {
  study: Study;
  series: Series;
  /** 生成成功時、新シリーズ UID を通知（呼び出し側でタイル表示）。 */
  onCreated: (seriesInstanceUid: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [familyKey, setFamilyKey] = useState(TEXTURE_FAMILIES[0].key);
  const family = useMemo(() => TEXTURE_FAMILIES.find((f) => f.key === familyKey)!, [familyKey]);
  const [feature, setFeature] = useState(TEXTURE_FAMILIES[0].features[0]);
  const [targetSeriesUid, setTargetSeriesUid] = useState(series.seriesInstanceUid);
  const [maskSeriesUid, setMaskSeriesUid] = useState<string>("");
  const [maskChannel, setMaskChannel] = useState(0);
  const [maskNC, setMaskNC] = useState(1);
  const [kernel, setKernel] = useState(7);
  const [stride, setStride] = useState(1);
  const [force2D, setForce2D] = useState(false); // 既定は 3D base
  const [channel, setChannel] = useState(0);
  const [timePoint, setTimePoint] = useState(0);
  const [nC, setNC] = useState(1);
  const [nT, setNT] = useState(1);

  // GLAM は 19 行列 × 8 統計。1 本のドロップダウンでは選べないので、行列と統計を別々に選ばせる。
  const [glamMatrixName, setGlamMatrixName] = useState(GLAM_MATRICES[0].name);
  const [glamStatistic, setGlamStatistic] = useState("Mean");

  const [allSeries, setAllSeries] = useState<Series[]>([series]);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<TextureJobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const jobIdRef = useRef<string | null>(null);

  const isGlam = familyKey === GLAM_FAMILY_KEY;
  const glamMatrix = useMemo(
    () => GLAM_MATRICES.find((m) => m.name === glamMatrixName),
    [glamMatrixName],
  );
  const glamStatOptions = useMemo(() => glamStatisticsFor(glamMatrix), [glamMatrix]);
  const minKernel = isGlam ? GLAM_MIN_FILTER_SIZE : 3;
  /**
   * 境界補正が入っていると、この 2 行列は 1 に張り付いて情報が消える。
   * 設定は真偽値なので "false"、backend の Property 表記に合わせた "0" のどちらでも来うる。
   */
  const boundaryCorrectionRaw = settings.BOOL_GLAM_boundaryCorrection;
  const boundaryCorrectionOn = boundaryCorrectionRaw !== "0" && boundaryCorrectionRaw !== "false";
  const glamBoundaryWarning =
    isGlam && glamMatrix?.needsBoundaryCorrectionOff === true && boundaryCorrectionOn;

  // ターゲット候補＝同一 study の全シリーズ。マスク候補はターゲットを除いたもの。
  const maskCandidates = useMemo(
    () => allSeries.filter((s) => s.seriesInstanceUid !== targetSeriesUid),
    [allSeries, targetSeriesUid],
  );

  // study のシリーズ一覧＋保存済み Radiomics 設定を取得。
  useEffect(() => {
    let cancelled = false;
    void fetchSeries(study.studyInstanceUid)
      .then((list) => {
        if (!cancelled && list.length) setAllSeries(list);
      })
      .catch(() => {});
    void fetchSettings()
      .then((raw) => {
        if (cancelled) return;
        // "texture.<KEY>" → "<KEY>" に変換して backend へ渡す。
        const s: Record<string, string> = {};
        for (const [k, v] of Object.entries(raw)) {
          if (k.startsWith("texture.")) s[k.slice("texture.".length)] = v;
        }
        setSettings(s);
        if (s.D3Basis !== undefined) setForce2D(s.D3Basis !== "true");
      })
      .catch(() => {});
  }, [study.studyInstanceUid]);

  // ターゲット変更でマルチ次元スタック（C/T）の有無を取得し、C/T を初期化。マスクがターゲットと一致したら解除。
  useEffect(() => {
    let cancelled = false;
    setChannel(0);
    setTimePoint(0);
    if (maskSeriesUid === targetSeriesUid) setMaskSeriesUid("");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [study.studyInstanceUid, targetSeriesUid]);

  // マスク変更でマスクの C 次元数（SEG マルチセグメント）を取得。未選択は 1。
  useEffect(() => {
    let cancelled = false;
    setMaskChannel(0);
    if (!maskSeriesUid) {
      setMaskNC(1);
      return;
    }
    void fetchSeriesLayout(study.studyInstanceUid, maskSeriesUid)
      .then((layout) => {
        if (!cancelled) setMaskNC(Math.max(1, layout.nC));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [study.studyInstanceUid, maskSeriesUid]);

  // ファミリー変更で特徴を先頭にリセット。GLAM は行列×統計なので features は空。
  useEffect(() => {
    setFeature(family.features[0] ?? "");
  }, [family]);

  // GLAM は 3D 専用（球殻上の動径分布として定義されている）。カーネルも下限が上がる。
  useEffect(() => {
    if (!isGlam) return;
    setForce2D(false);
    setKernel((k) => (k < GLAM_MIN_FILTER_SIZE ? GLAM_MIN_FILTER_SIZE + 2 : k));
  }, [isGlam]);

  // 自己ペアだけの行列に切り替えたら、対角/非対角の統計は選べなくなる。
  useEffect(() => {
    if (!glamStatOptions.includes(glamStatistic)) setGlamStatistic(glamStatOptions[0]);
  }, [glamStatOptions, glamStatistic]);

  // 投入したジョブの進み具合を追う。ダイアログを閉じても取り違えないよう jobId で照合する。
  useEffect(() => {
    if (!job || job.state === "DONE" || job.state === "FAILED" || job.state === "CANCELLED") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void getTextureJob(job.jobId)
        .then((next) => {
          if (cancelled || jobIdRef.current !== next.jobId) return;
          setJob(next);
          if (next.state === "DONE" && next.result) {
            onCreated(next.result.seriesInstanceUid);
            onClose();
          } else if (next.state === "FAILED") {
            setBusy(false);
            setError(next.error ?? t("texture.err.failed"));
          } else if (next.state === "CANCELLED") {
            setBusy(false);
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

  const featureString = isGlam
    ? glamFeatureString(glamMatrixName, glamStatistic)
    : `${family.key}_${feature}`;

  const onRun = async () => {
    setError(null);
    if (!(kernel >= minKernel && kernel <= 99)) {
      return setError(isGlam ? t("texture.err.kernelGlam", { min: minKernel }) : t("texture.err.kernel"));
    }
    if (!(stride >= 1 && stride <= 32)) return setError(t("texture.err.stride"));
    // GLAM を全面マスクで回すと窓数が桁違いになる（backend も拒否する）。先に UI で止める。
    if (isGlam && !maskSeriesUid) return setError(t("texture.err.glamNeedsMask"));
    setBusy(true);
    try {
      const status = await submitTextureJob({
        studyInstanceUid: study.studyInstanceUid,
        sourceSeriesUid: targetSeriesUid,
        maskSeriesUid: maskSeriesUid || null,
        maskChannel,
        feature: featureString,
        filterSize: kernel,
        stride,
        force2D: isGlam ? false : force2D,
        channel,
        timePoint,
        settings,
        margin: null,
        seriesDescription: null,
        seriesNumber: null,
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
    void cancelTextureJob(id)
      .then(setJob)
      .catch(() => {});
  };

  const seriesLabel = (s: Series) =>
    `#${s.seriesNumber ?? "?"} ${s.modality ?? ""} ${s.seriesDescription ?? ""}`.trim();

  return (
    <div style={overlay} onMouseDown={busy ? undefined : onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>{t("texture.title")}</div>

        <Field label={t("texture.field.target")}>
          <select value={targetSeriesUid} onChange={(e) => setTargetSeriesUid(e.target.value)} disabled={busy} style={input}>
            {allSeries.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
            ))}
          </select>
        </Field>

        {/* ターゲットが C/T 次元を持つ場合のみ、Target 直下に選択欄を表示。 */}
        {nC > 1 && (
          <Field label={t("texture.field.targetC")}>
            <select value={channel} onChange={(e) => setChannel(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: nC }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
        )}
        {nT > 1 && (
          <Field label={t("texture.field.targetT")}>
            <select value={timePoint} onChange={(e) => setTimePoint(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: nT }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label={t("texture.field.mask")}>
          <select value={maskSeriesUid} onChange={(e) => setMaskSeriesUid(e.target.value)} disabled={busy} style={input}>
            <option value="">{t("texture.mask.none")}</option>
            {maskCandidates.map((s) => (
              <option key={s.seriesInstanceUid} value={s.seriesInstanceUid}>{seriesLabel(s)}</option>
            ))}
          </select>
        </Field>

        {/* マスクがマルチチャンネル（DICOM SEG マルチセグメント等）のときのみ選択可能に。 */}
        {maskSeriesUid !== "" && maskNC > 1 && (
          <Field label={t("texture.field.maskChannel")}>
            <select value={maskChannel} onChange={(e) => setMaskChannel(Number(e.target.value))} disabled={busy} style={input}>
              {Array.from({ length: maskNC }, (_, i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label={t("texture.field.family")}>
          <select value={familyKey} onChange={(e) => setFamilyKey(e.target.value)} disabled={busy} style={input}>
            {TEXTURE_FAMILIES.map((f) => (
              <option key={f.key} value={f.key}>{f.label}</option>
            ))}
          </select>
        </Field>
        {/* GLAM は行列（記述子）と統計（その要約）の 2 段。GLCM でいう共起行列と統計の関係。 */}
        {isGlam ? (
          <>
            <Field label={t("texture.field.glamMatrix")}>
              <select value={glamMatrixName} onChange={(e) => setGlamMatrixName(e.target.value)} disabled={busy} style={input}>
                {GLAM_MATRICES.map((m) => (
                  <option key={m.name} value={m.name}>{t(m.labelKey)}</option>
                ))}
              </select>
            </Field>
            <Field label={t("texture.field.glamStatistic")}>
              <select value={glamStatistic} onChange={(e) => setGlamStatistic(e.target.value)} disabled={busy} style={input}>
                {glamStatOptions.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </Field>
          </>
        ) : (
          <Field label={t("texture.field.feature")}>
            <select value={feature} onChange={(e) => setFeature(e.target.value)} disabled={busy} style={input}>
              {family.features.map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
          </Field>
        )}

        <Field label={t("texture.field.kernel")}>
          <input type="number" min={minKernel} max={99} step={2} value={kernel}
            onChange={(e) => setKernel(Number(e.target.value))} disabled={busy} style={input} />
        </Field>
        <Field label={t("texture.field.stride")}>
          <input type="number" min={1} max={32} value={stride}
            onChange={(e) => setStride(Number(e.target.value))} disabled={busy} style={input} />
        </Field>
        <Field label={t("texture.field.dim")}>
          <select value={isGlam ? "3d" : force2D ? "2d" : "3d"}
            onChange={(e) => setForce2D(e.target.value === "2d")} disabled={busy || isGlam} style={input}>
            <option value="2d">{t("texture.dim.2d")}</option>
            <option value="3d">{t("texture.dim.3d")}</option>
          </select>
        </Field>

        {isGlam && <div style={note}>{t("texture.glam.note")}</div>}
        {glamBoundaryWarning && <div style={warnText}>{t("texture.glam.boundaryWarn")}</div>}

        <div style={{ color: "#6b7785", fontSize: 11, marginTop: 6 }}>{t("texture.paramsNote")}</div>
        {error && <div style={errText}>{error}</div>}

        {/* 計算中の進み具合。backend がスライス単位で報告する。 */}
        {busy && (
          <>
            <div style={progressTrack}>
              {job && job.slicesTotal > 0 ? (
                <div style={{ ...progressFill, width: `${Math.round((job.slicesDone / job.slicesTotal) * 100)}%` }} />
              ) : (
                <>
                  <div style={progressBar} />
                  <style>{"@keyframes texbar{0%{left:-40%}100%{left:100%}}"}</style>
                </>
              )}
            </div>
            <div style={note}>
              {job && job.slicesTotal > 0
                ? t("texture.progress.slices", {
                    done: job.slicesDone,
                    total: job.slicesTotal,
                    seconds: Math.round(job.elapsedMs / 1000),
                  })
                : t("texture.progress.starting")}
            </div>
          </>
        )}

        <div style={{ display: "flex", gap: 6, marginTop: 12, justifyContent: "flex-end" }}>
          {busy ? (
            <button onClick={onCancelJob} style={btn}>{t("texture.cancelJob")}</button>
          ) : (
            <button onClick={onClose} style={btn}>{t("common.cancel")}</button>
          )}
          <button onClick={onRun} disabled={busy} style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}>
            {busy ? t("texture.running") : t("texture.run")}
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
  width: 420, maxHeight: "90vh", overflowY: "auto",
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 12px 40px rgba(0,0,0,0.25)", padding: 16, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontSize: 14, fontWeight: 600, color: "#0b5cad", marginBottom: 10 };
const fieldRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "4px 0" };
const fieldLabel: React.CSSProperties = { color: "#5a6672", flex: "none", minWidth: 150 };
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
  background: "#0b5cad", animation: "texbar 1.1s linear infinite",
};
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "5px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
