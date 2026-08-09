/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 自動位置合わせのパネル（設計: `fw/registration-design.md` §12）。
 *
 * <p>導線は Fusion コントロールバーの「⊹ 位置調整」の行にある `詳細…`。
 * 手動の 6 値は常に触れたままで、ここは**その上に乗る自動結果**を扱う（同 §12.1）。
 *
 * <p>R3 の範囲は剛体のみ。プロファイル・ROI・PET の扱い・非剛体は R4 以降。
 * ここで出していない設定は「まだ無い」であって「既定で動いている」ではない。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { Instance, Series, Study } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import { estimateRegVolume, loadRegVolume } from "../viewer/regVolumeLoader";
import { runRigidInWorker, toPayload } from "../viewer/regWorkerClient";
import type { MetricKind } from "../viewer/regMetrics";
import type { RegistrationMode } from "../viewer/regProtocol";
import type { RegistrationResult } from "../viewer/regResult";

/** 見積りがこれを超えたら確認を挟む（設計 §7-1「黙って進めて OOM で落とさない」）。 */
const CONFIRM_BYTES = 1_200_000_000; // 約 1.2 GB

export interface RegistrationPanelProps {
  /** ビューアのモード（standalone / web）。位置合わせの「変換」とは別物。 */
  viewerMode: ViewerMode;
  /** fixed = タイルの基準シリーズ（背景）。 */
  fixed: { study: Study; series: Series; instances: Instance[]; c: number; t: number };
  /** moving = Fusion で重ねているシリーズ（前景）。 */
  moving: { study: Study; series: Series; instances: Instance[]; c: number; t: number };
  /** 現在の自動位置合わせ結果（無ければ null）。 */
  result: RegistrationResult | null;
  onResult: (r: RegistrationResult | null) => void;
  onClose: () => void;
}

type Phase = "idle" | "loading" | "running";

export function RegistrationPanel({
  viewerMode, fixed, moving, result, onResult, onClose,
}: RegistrationPanelProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [metricChoice, setMetricChoice] = useState<"auto" | MetricKind>("auto");
  // 既定は剛体のみ（R3 と同じ。安全側）。非剛体は変形のある症例で選ぶ。
  const [mode, setMode] = useState<RegistrationMode>("rigid");
  const abortRef = useRef<(() => void) | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => () => { abortRef.current?.(); }, []);

  const sameModality = (fixed.series.modality ?? "") === (moving.series.modality ?? "");

  const run = useCallback(async () => {
    setError(null);
    cancelledRef.current = false;
    setPhase("loading");
    setProgress(0);
    try {
      // ── 事前の見積り（設計 §7-1） ──
      setStatus(t("registration.status.estimating"));
      const [ef, em] = await Promise.all([
        estimateRegVolume(viewerMode, fixed.study.studyInstanceUid, fixed.series.seriesInstanceUid, fixed.instances, fixed.c, fixed.t),
        estimateRegVolume(viewerMode, moving.study.studyInstanceUid, moving.series.seriesInstanceUid, moving.instances, moving.c, moving.t),
      ]);
      if (!ef.spatial || !em.spatial) {
        setError(t("registration.error.notSpatial"));
        setPhase("idle");
        return;
      }
      // ピラミッド（1/8 + 1/64 …）の分を上乗せして見積もる。
      const total = Math.round((ef.bytes + em.bytes) * 1.15);
      if (total > CONFIRM_BYTES) {
        const mb = Math.round(total / 1024 / 1024);
        if (!window.confirm(t("registration.confirmMemory", { mb }))) {
          setPhase("idle");
          return;
        }
      }

      // ── 読み込み ──
      setStatus(t("registration.status.loadingFixed"));
      const f = await loadRegVolume(viewerMode, fixed.study.studyInstanceUid, fixed.series.seriesInstanceUid,
        fixed.instances, fixed.c, fixed.t, (n, all) => setProgress((n / all) * 0.4));
      if (cancelledRef.current) { setPhase("idle"); return; }
      setStatus(t("registration.status.loadingMoving"));
      const m = await loadRegVolume(viewerMode, moving.study.studyInstanceUid, moving.series.seriesInstanceUid,
        moving.instances, moving.c, moving.t, (n, all) => setProgress(0.4 + (n / all) * 0.2));
      if (cancelledRef.current) { setPhase("idle"); return; }
      if (!f || !m) {
        setError(t("registration.error.notSpatial"));
        setPhase("idle");
        return;
      }

      // ── 実行 ──
      setPhase("running");
      setStatus(t("registration.status.running"));
      const sameFor = Boolean(f.frameOfReferenceUid) && f.frameOfReferenceUid === m.frameOfReferenceUid;
      const handle = runRigidInWorker(
        {
          fixed: toPayload(f.volume, f.iop, f.sliceStep),
          moving: toPayload(m.volume, m.iop, m.sliceStep),
          mode,
          metric: metricChoice === "auto" ? undefined : metricChoice,
          sameModality,
          sameFrameOfReference: sameFor,
        },
        (p) => setProgress(0.6 + p.fraction * 0.4),
      );
      abortRef.current = handle.abort;
      const done = await handle.promise;
      abortRef.current = null;

      onResult({
        matrix: done.matrix,
        center: done.center,
        translationMm: done.translationMm,
        eulerDeg: done.eulerDeg,
        metric: done.metric,
        metricValue: done.metricValue,
        elapsedMs: done.elapsedMs,
        sameFrameOfReference: sameFor,
        initialization: done.initialization,
        dvf: done.dvf ?? null,
        mode,
      });
      setPhase("idle");
      setProgress(1);
      setStatus("");
    } catch (e) {
      abortRef.current = null;
      // 中止は「失敗」ではないので赤字にしない。
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg === "registration aborted" ? null : msg);
      setPhase("idle");
      setStatus("");
    }
  }, [mode, viewerMode, fixed, moving, metricChoice, sameModality, onResult, t]);

  const cancel = () => {
    cancelledRef.current = true;
    abortRef.current?.();
    abortRef.current = null;
    setPhase("idle");
    setStatus("");
  };

  const busy = phase !== "idle";
  const label = (s: Series) =>
    s.seriesDescription || `#${s.seriesNumber ?? "?"} ${s.modality ?? ""}`.trim();

  return (
    <div style={panel} role="dialog" aria-label={t("registration.title")}>
      <div style={header}>
        <span style={{ fontWeight: 600 }}>{t("registration.title")}</span>
        <button onClick={onClose} style={closeBtn} title={t("common.close")}>×</button>
      </div>

      <div style={row}>
        <span style={key}>{t("registration.fixed")}</span>
        <span style={val}>{fixed.series.modality} {label(fixed.series)}</span>
      </div>
      <div style={row}>
        <span style={key}>{t("registration.moving")}</span>
        <span style={val}>{moving.series.modality} {label(moving.series)}</span>
      </div>

      <div style={row}>
        <span style={key}>{t("registration.metric")}</span>
        <select
          value={metricChoice}
          disabled={busy}
          onChange={(e) => setMetricChoice(e.target.value as "auto" | MetricKind)}
          style={select}
        >
          <option value="auto">
            {t("registration.metricAuto", { metric: sameModality ? "NCC" : "MI" })}
          </option>
          <option value="mi">{t("registration.metricMi")}</option>
          <option value="nmi">{t("registration.metricNmi")}</option>
          <option value="ncc">{t("registration.metricNcc")}</option>
          <option value="lncc">{t("registration.metricLncc")}</option>
        </select>
      </div>

      <div style={row}>
        <span style={key}>{t("registration.mode")}</span>
        <select
          value={mode}
          disabled={busy}
          onChange={(e) => setMode(e.target.value as RegistrationMode)}
          style={select}
        >
          <option value="rigid">{t("registration.modeRigid")}</option>
          <option value="deformable">{t("registration.modeDeformable")}</option>
          <option value="rigid+deformable">{t("registration.modeBoth")}</option>
        </select>
      </div>
      <div style={{ ...hint, marginBottom: 6 }}>
        {mode === "rigid" ? t("registration.hintRigid")
          : mode === "deformable" ? t("registration.hintDeformable")
          : t("registration.hintBoth")}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
        <button onClick={run} disabled={busy} style={runBtn}>{t("registration.run")}</button>
        <button onClick={cancel} disabled={!busy} style={btn}>{t("registration.cancel")}</button>
        {result && !busy && (
          <button onClick={() => onResult(null)} style={btn}>{t("registration.clear")}</button>
        )}
      </div>

      {busy && (
        <div style={{ marginTop: 6 }}>
          <div style={barOuter}><div style={{ ...barInner, width: `${Math.round(progress * 100)}%` }} /></div>
          <div style={hint}>{status}</div>
        </div>
      )}

      {error && <div style={errorBox}>{error}</div>}

      {result && (
        <div style={resultBox}>
          <div style={row}>
            <span style={key}>{t("registration.resultTranslation")}</span>
            <span style={val}>
              {result.translationMm.map((v) => v.toFixed(2)).join(", ")} mm
            </span>
          </div>
          <div style={row}>
            <span style={key}>{t("registration.resultRotation")}</span>
            <span style={val}>{result.eulerDeg.map((v) => v.toFixed(2)).join(", ")} °</span>
          </div>
          <div style={row}>
            <span style={key}>{t("registration.resultMetric")}</span>
            <span style={val}>
              {result.metric.toUpperCase()} = {result.metricValue.toFixed(4)}
              {"  "}({(result.elapsedMs / 1000).toFixed(1)} s)
            </span>
          </div>
          <div style={hint}>
            {result.sameFrameOfReference
              ? t("registration.forSame")
              : t("registration.forDifferent")}
          </div>
          {result.dvf && (
            <>
              <div style={row}>
                <span style={key}>{t("registration.resultMaxDisp")}</span>
                <span style={val}>{result.dvf.maxDisplacementMm.toFixed(1)} mm</span>
              </div>
              <div style={row}>
                <span style={key}>{t("registration.resultJacobian")}</span>
                <span style={val}>
                  {result.dvf.jacobian.min.toFixed(2)}–{result.dvf.jacobian.max.toFixed(2)}
                  {"  "}({t("registration.resultNegative", {
                    pct: (result.dvf.jacobian.negativeFraction * 100).toFixed(2),
                  })})
                </span>
              </div>
              {result.dvf.jacobian.negativeFraction > 0 && (
                <div style={errorBox}>{t("registration.foldingWarning")}</div>
              )}
            </>
          )}
          <div style={hint}>{t("registration.manualOnTop")}</div>
        </div>
      )}
    </div>
  );
}

// ── styles ───────────────────────────────────────────────────────────────────

const panel: React.CSSProperties = {
  position: "absolute",
  right: 8,
  bottom: 44,
  zIndex: 30,
  width: 340,
  padding: 10,
  background: "#fff",
  border: "1px solid #c9d2dc",
  borderRadius: 6,
  boxShadow: "0 6px 24px rgba(0,0,0,0.18)",
  fontSize: 12,
  color: "#25303b",
};
const header: React.CSSProperties = {
  display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8,
};
const closeBtn: React.CSSProperties = {
  border: "none", background: "transparent", cursor: "pointer", fontSize: 16, lineHeight: 1, color: "#5a6672",
};
const row: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center", marginBottom: 4 };
const key: React.CSSProperties = { flex: "none", width: 96, color: "#5a6672" };
const val: React.CSSProperties = { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
const select: React.CSSProperties = { flex: 1, fontSize: 12, padding: "2px 4px" };
const hint: React.CSSProperties = { fontSize: 10, color: "#8a94a2", marginTop: 2 };
const btn: React.CSSProperties = {
  fontSize: 12, padding: "3px 10px", border: "1px solid #c9d2dc", borderRadius: 4,
  background: "#f6f8fa", cursor: "pointer",
};
const runBtn: React.CSSProperties = { ...btn, background: "#2b6cb0", color: "#fff", borderColor: "#2b6cb0" };
const barOuter: React.CSSProperties = { height: 6, background: "#e6ebf0", borderRadius: 3, overflow: "hidden" };
const barInner: React.CSSProperties = { height: "100%", background: "#2b6cb0", transition: "width 120ms linear" };
const errorBox: React.CSSProperties = {
  marginTop: 6, padding: 6, background: "#fdecec", border: "1px solid #f3b7b7", borderRadius: 4, color: "#a33",
};
const resultBox: React.CSSProperties = {
  marginTop: 8, paddingTop: 8, borderTop: "1px solid #e6ebf0",
};
