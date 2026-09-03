/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * TIMI フレームカウント（A15）のダイアログ — `fw/angio-design.md` §24。
 *
 * <h3>作業の本体は「2 つのフレームを選ぶ」こと</h3>
 * QCA / QLV と違い、輪郭も径も要らない。だから**フレーム送りを止めない**——
 * QCA / QLV は「結果が出ている間はフレームを固定」するが、それをここでやると
 * **機能そのものが使えなくなる**。
 *
 * <h3>🔴 ROI は特定のフレームに属さない（計画からの変更・2026-09-03）</h3>
 * 当初の計画では「ROI を引いている間だけフレームを固定する」としていた。実装してみると
 * **その前提が成り立たない**——時間輝度カーブの ROI は**空間的な矩形**で、全フレームを
 * 同じ位置でサンプルするためにある。特定のフレームの上に引く輪郭（QLV）とは性質が違う。
 * したがって**錠は掛けない**。ただし「どのフレームを見ながら引いたか」は体動の影響を
 * 後から見るのに要るので、`roiFrame` として出自に残す。
 *
 * <h3>🚨 出さないものがある画面である</h3>
 * 撮影レートのタグが無ければ 30fps 換算値を出さない、血管が未選択なら結果を出さない、
 * 到達がランの最終フレームなら人が確認するまで出さない。**空欄の理由を必ず画面に書く**
 * （何も出ないのと「出せないと判断した」のは別物）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../i18n/i18n";
import { publishAnalysisResult } from "../report/analysisResultStore";
import { timiRecord } from "../report/xaAnalysisRecords";
import { publishTimiSnapshot } from "./debugApi";
import { readModalitySlice } from "./pixelCalibration";
import { TaskStepRail } from "./TaskStepRail";
import {
  arrivalCandidate,
  computeTimiFrameCount,
  meanInRect,
  TIMI_VESSELS,
  type TimiRect,
  type TimiResult,
  type TimiVessel,
} from "./timiFrameCount";
import { viewerOverlayProps } from "./viewerOverlay";
import { clearedBy, deriveTimiSteps, TIMI_STEPS } from "./xaTasks";
import { frameStartTimesMs, resolveXaFps, type XaCineSource } from "./xaCine";

/** ROI プレビューの最大表示サイズ [px]。 */
const PREVIEW_W = 320;
const PREVIEW_H = 320;
/** 時間輝度カーブを作るときの間引き（全フレーム読むと重い）。 */
const CURVE_MAX_FRAMES = 60;

interface Slice {
  values: Float32Array;
  width: number;
  height: number;
}

export interface TimiSaveContext {
  studyUid: string;
  sopInstanceUidAt: (index: number) => string | null;
}

export function XaTimiDialog({
  imageIds,
  seriesUid,
  saveContext,
  cine,
  currentFrame,
  subtracted,
  onClose,
  onGoToFrame,
}: {
  /** フレーム列（表示中のスタックそのもの）。 */
  imageIds: readonly string[];
  seriesUid: string;
  saveContext: TimiSaveContext;
  /**
   * 撮影レートの材料。
   * 🔴 **fps ではなくこれを丸ごと受け取る。** fps だけだと「既定値に落ちたのか」が分からず、
   * 換算してよいかを判断できない（§24.2）。
   */
  cine: XaCineSource | null;
  /** ビューアが今見せているフレーム（0 origin）。 */
  currentFrame: number;
  /** 差分（DSA）表示中か。 */
  subtracted?: boolean;
  onClose: () => void;
  /** ビューアの表示フレームを合わせる。 */
  onGoToFrame?: (index: number) => void;
}) {
  const { t } = useI18n();

  const [vessel, setVessel] = useState<TimiVessel | null>(null);
  const [startFrame, setStartFrame] = useState<number | null>(null);
  const [endFrame, setEndFrame] = useState<number | null>(null);
  const [endSelection, setEndSelection] = useState<"manual" | "assisted" | null>(null);
  const [lastFrameConfirmed, setLastFrameConfirmed] = useState(false);
  const [roi, setRoi] = useState<TimiRect | null>(null);
  const [roiFrame, setRoiFrame] = useState<number | null>(null);
  const [curve, setCurve] = useState<{ frame: number; value: number }[]>([]);
  const [curveBusy, setCurveBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState(false);

  const frameCount = imageIds.length;

  const cineOrFallback = useMemo<XaCineSource>(
    () => cine ?? { numberOfFrames: frameCount },
    [cine, frameCount],
  );
  const { fps, source: fpsSource } = useMemo(() => resolveXaFps(cineOrFallback), [cineOrFallback]);

  const result: TimiResult | null = useMemo(() => {
    if (!vessel || startFrame == null || endFrame == null) return null;
    return computeTimiFrameCount({
      vessel,
      startFrame,
      endFrame,
      cine: cineOrFallback,
      subtracted,
    });
  }, [vessel, startFrame, endFrame, cineOrFallback, subtracted]);

  const endAtLastFrame = endFrame != null && endFrame === frameCount - 1;
  const endBeforeStart = startFrame != null && endFrame != null && endFrame <= startFrame;
  /** 🔴 結果を「見せてよい」か。段が invalid のうちは数字を出さない。 */
  const resultVisible =
    !!result && !endBeforeStart && (!endAtLastFrame || lastFrameConfirmed);

  const steps = useMemo(
    () =>
      deriveTimiSteps({
        hasVessel: !!vessel,
        fpsSource,
        hasStart: startFrame != null,
        hasEnd: endFrame != null,
        endSelection,
        endBeforeStart,
        endAtLastFrame,
        endAtLastFrameConfirmed: lastFrameConfirmed,
        hasResult: resultVisible,
        hasNormalised: !!result?.tfc30,
        canSave: false,
        saved: false,
      }),
    [
      vessel,
      fpsSource,
      startFrame,
      endFrame,
      endSelection,
      endBeforeStart,
      endAtLastFrame,
      lastFrameConfirmed,
      resultVisible,
      result,
    ],
  );

  /* ── 現在フレームの画素（ROI プレビュー用）────────────────────────── */
  const [preview, setPreview] = useState<Slice | null>(null);
  useEffect(() => {
    let alive = true;
    const id = imageIds[currentFrame];
    if (!id) return;
    void readModalitySlice(id)
      .then((s) => {
        if (!alive || !s) return;
        setPreview({ values: s.values, width: s.width, height: s.height });
      })
      .catch(() => {
        /* プレビューが出せなくても計測はできる（数値はフレーム番号と時刻だけで決まる）。 */
      });
    return () => {
      alive = false;
    };
  }, [imageIds, currentFrame]);

  /* ── 時間輝度カーブ（ROI があるときだけ）──────────────────────────── */
  //
  // 🚨 **ROI が無いときに全画面平均へ落ちない。** 落とすと横隔膜・脊椎・カテーテル・
  //    大動脈を数え、それらしい曲線が出てしまう（QLV で実際に踏んだ）。
  const buildCurve = useCallback(async () => {
    if (!roi) return;
    setCurveBusy(true);
    setError(null);
    try {
      const step = Math.max(1, Math.ceil(frameCount / CURVE_MAX_FRAMES));
      const out: { frame: number; value: number }[] = [];
      for (let f = 0; f < frameCount; f += step) {
        const id = imageIds[f];
        if (!id) continue;
        const s = await readModalitySlice(id);
        if (!s) continue;
        const v = meanInRect(s.values, s.width, s.height, roi);
        if (v != null) out.push({ frame: f, value: v });
      }
      setCurve(out);
    } catch (e) {
      setError(String(e));
    } finally {
      setCurveBusy(false);
    }
  }, [roi, frameCount, imageIds]);

  useEffect(() => {
    if (roi) void buildCurve();
    else setCurve([]);
  }, [roi, buildCurve]);

  /** 到達フレームの**候補**。押すまで確定しない。 */
  const candidate = useMemo(() => {
    if (curve.length < 4) return null;
    const idx = arrivalCandidate(
      curve.map((p) => p.value),
      { direction: subtracted ? "brighter" : "darker" },
    );
    return idx == null ? null : curve[idx].frame;
  }, [curve, subtracted]);

  /* ── 検証用の公開 ───────────────────────────────────────────────── */
  useEffect(() => {
    publishTimiSnapshot({
      imageId: imageIds[currentFrame] ?? null,
      seriesUid,
      vessel,
      startFrame,
      endFrame,
      endSelection,
      currentFrame,
      frameCount,
      fps,
      fpsSource,
      frameTimesMs: frameStartTimesMs(cineOrFallback),
      roi: roi ? { ...roi } : null,
      roiFrame,
      intensityCurve: curve.map((p) => ({ ...p })),
      candidateFrame: candidate,
      result: resultVisible && result ? { ...result, warnings: [...result.warnings] } : null,
      steps: steps.map((s) => ({ id: s.id, state: s.state, reasonKey: s.reasonKey ?? null })),
    });
  });
  useEffect(() => () => publishTimiSnapshot(null), []);

  const goTo = (f: number | null) => {
    if (f != null && onGoToFrame) onGoToFrame(f);
  };

  const publishToReport = () => {
    if (!resultVisible || !result) return;
    publishAnalysisResult(
      timiRecord(
        {
          result,
          seriesUid,
          studyUid: saveContext.studyUid,
          sopInstanceUid: saveContext.sopInstanceUidAt(result.startFrame),
          roiFrame,
        },
        t,
      ),
    );
    setPublished(true);
  };

  const fmt = (v: number | null | undefined, digits = 1): string =>
    v == null ? "—" : v.toFixed(digits);

  return (
    <div style={backdrop} onMouseDown={onClose}>
      {/* 🔴 目印は panel に付ける。backdrop に付けると画像の上のホイールまで
          「器の中」になり、フレーム送りが死ぬ（TIMI では致命的）。 */}
      <div
        style={panel}
        onMouseDown={(e) => e.stopPropagation()}
        data-testid="xa-timi-dialog"
        {...viewerOverlayProps}
      >
        <div style={title}>{t("timi.title")}</div>
        <div style={hint}>{t("timi.scope")}</div>

        <div style={bodyRow}>
          <TaskStepRail
            steps={steps}
            onGo={() => {
              /* この画面は 1 枚に収まるので、段を押しても飛び先が無い。 */
            }}
            onRedo={(id) => {
              // `clearedBy` の宛先をここで実際に捨てる（段の宣言と実装をずらさない）。
              for (const key of clearedBy(id, TIMI_STEPS)) {
                if (key === "vessel") setVessel(null);
                if (key === "startFrame") setStartFrame(null);
                if (key === "endFrame") {
                  setEndFrame(null);
                  setEndSelection(null);
                  setLastFrameConfirmed(false);
                }
              }
              setPublished(false);
            }}
          />

          <div style={{ flex: 1, minWidth: 0, overflowY: "auto" }}>
            {error && <div style={errorText}>{error}</div>}

            {/* ── 血管 ─────────────────────────────────────────── */}
            <div style={section}>
              <div style={sectionTitle}>{t("timi.step.vessel")}</div>
              <div style={row}>
                {TIMI_VESSELS.map((v) => (
                  <label key={v} style={label}>
                    <input
                      type="radio"
                      name="timi-vessel"
                      checked={vessel === v}
                      data-testid={`timi-vessel-${v}`}
                      onChange={() => {
                        // 🚨 血管が変われば入口部も指標点も別の場所。前の選択は別の物を指す。
                        setVessel(v);
                        setStartFrame(null);
                        setEndFrame(null);
                        setEndSelection(null);
                        setLastFrameConfirmed(false);
                        setPublished(false);
                      }}
                    />
                    {t(`timi.vessel.${v}`)}
                  </label>
                ))}
              </div>
              <div style={hint} data-testid="timi-landmark">
                {vessel ? t(`timi.landmark.${vessel}`) : t("timi.vessel.pick")}
              </div>
            </div>

            {/* ── 撮影レート ───────────────────────────────────── */}
            <div style={section}>
              <div style={sectionTitle}>{t("timi.step.rate")}</div>
              <div style={{ fontSize: 12 }} data-testid="timi-rate">
                {fpsSource === "default" ? (
                  <span style={{ color: "#a5642a" }}>{t("timi.warn.fpsUnknown")}</span>
                ) : (
                  <>
                    <b>{fps.toFixed(2)} fps</b>
                    <span style={{ color: "#66788a" }}> · {t(`cine.fpsSource.${fpsSource}`)}</span>
                  </>
                )}
              </div>
            </div>

            {/* ── フレームの指定 ───────────────────────────────── */}
            <div style={section}>
              <div style={sectionTitle}>
                {t("timi.step.start")} / {t("timi.step.end")}
              </div>
              <div style={row}>
                <button
                  type="button"
                  style={btn}
                  disabled={!vessel}
                  data-testid="timi-use-start"
                  onClick={() => {
                    setStartFrame(currentFrame);
                    setPublished(false);
                  }}
                >
                  {t("timi.useStart")}
                </button>
                <span style={{ fontSize: 12 }}>
                  {startFrame == null ? "—" : startFrame + 1}
                </span>
                {startFrame != null && (
                  <button type="button" style={linkBtn} onClick={() => goTo(startFrame)}>
                    ↦
                  </button>
                )}
              </div>
              <div style={row}>
                <button
                  type="button"
                  style={btn}
                  disabled={!vessel}
                  data-testid="timi-use-end"
                  onClick={() => {
                    setEndFrame(currentFrame);
                    setEndSelection("manual");
                    setLastFrameConfirmed(false);
                    setPublished(false);
                  }}
                >
                  {t("timi.useEnd")}
                </button>
                <span style={{ fontSize: 12 }}>{endFrame == null ? "—" : endFrame + 1}</span>
                {endFrame != null && (
                  <button type="button" style={linkBtn} onClick={() => goTo(endFrame)}>
                    ↦
                  </button>
                )}
              </div>
              {endBeforeStart && (
                <div style={warn} data-testid="timi-end-before-start">
                  {t("timi.step.reason.endBeforeStart")}
                </div>
              )}
              {endAtLastFrame && !endBeforeStart && (
                <div style={confirmBox}>
                  <div>{t("timi.warn.endAtLastFrame")}</div>
                  <label style={label}>
                    <input
                      type="checkbox"
                      checked={lastFrameConfirmed}
                      data-testid="timi-confirm-last-frame"
                      onChange={(e) => setLastFrameConfirmed(e.target.checked)}
                    />
                    {t("timi.confirmLastFrame")}
                  </label>
                </div>
              )}
            </div>

            {/* ── ROI と候補（補助）────────────────────────────── */}
            <div style={section}>
              <div style={sectionTitle}>{t("timi.roi.draw")}</div>
              {preview ? (
                <RoiPicker
                  slice={preview}
                  roi={roi}
                  onChange={(r) => {
                    setRoi(r);
                    setRoiFrame(currentFrame);
                  }}
                />
              ) : (
                <div style={hint}>…</div>
              )}
              <div style={row}>
                <button
                  type="button"
                  style={btn}
                  disabled={!roi}
                  data-testid="timi-roi-clear"
                  onClick={() => {
                    setRoi(null);
                    setRoiFrame(null);
                  }}
                >
                  {t("timi.roi.clear")}
                </button>
                {curveBusy && <span style={hint}>…</span>}
              </div>
              {!roi && (
                <div style={hint} data-testid="timi-roi-none">
                  {t("timi.roi.none")}
                </div>
              )}
              {roi && candidate != null && (
                <div style={row}>
                  <button
                    type="button"
                    style={primaryBtn}
                    data-testid="timi-use-candidate"
                    onClick={() => {
                      setEndFrame(candidate);
                      setEndSelection("assisted");
                      setLastFrameConfirmed(false);
                      goTo(candidate);
                    }}
                  >
                    {t("timi.candidate.use", { frame: String(candidate + 1) })}
                  </button>
                </div>
              )}
              {roi && !curveBusy && candidate == null && (
                <div style={hint} data-testid="timi-candidate-none">
                  {t("timi.candidate.none")}
                </div>
              )}
            </div>

            {/* ── 結果 ─────────────────────────────────────────── */}
            <div style={section}>
              <div style={sectionTitle}>{t("timi.step.result")}</div>
              {!resultVisible || !result ? (
                <div style={hint} data-testid="timi-no-result">
                  {!vessel
                    ? t("timi.vessel.pick")
                    : endBeforeStart
                      ? t("timi.step.reason.endBeforeStart")
                      : endAtLastFrame && !lastFrameConfirmed
                        ? t("timi.step.reason.endAtLastFrame")
                        : "—"}
                </div>
              ) : (
                <>
                  <table style={table} data-testid="timi-result">
                    <tbody>
                      <tr>
                        <td style={th}>{t("timi.result.frames")}</td>
                        <td style={td}>{result.frames}</td>
                        <td style={unitCell}>frames</td>
                      </tr>
                      <tr>
                        <td style={th}>{t("timi.result.tfc30")}</td>
                        <td style={td} data-testid="timi-tfc30">
                          {fmt(result.tfc30)}
                        </td>
                        <td style={unitCell}>{result.tfc30 == null ? "" : "frames@30fps"}</td>
                      </tr>
                      {result.vessel === "lad" && (
                        <tr>
                          <td style={th}>{t("timi.result.ctfc")}</td>
                          <td style={td} data-testid="timi-ctfc">
                            {fmt(result.ctfc)}
                          </td>
                          <td style={unitCell}>{result.ctfc == null ? "" : "frames@30fps"}</td>
                        </tr>
                      )}
                      <tr>
                        <td style={th}>{t("timi.result.elapsed")}</td>
                        <td style={td}>{fmt(result.elapsedMs, 0)}</td>
                        <td style={unitCell}>{result.elapsedMs == null ? "" : "ms"}</td>
                      </tr>
                      <tr>
                        <td style={th}>{t("timi.result.rate")}</td>
                        <td style={td}>{result.fps.toFixed(2)}</td>
                        <td style={unitCell}>
                          fps · {t(`cine.fpsSource.${result.fpsSource}`)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div style={hint}>
                    {t("timi.result.frameNumbers", {
                      start: String(result.startFrame + 1),
                      end: String(result.endFrame + 1),
                    })}
                  </div>
                  <div style={hint}>{t("timi.result.convention")}</div>
                  {result.warnings.map((w) => (
                    <div key={w} style={warn} data-testid={`timi-warn-${w}`}>
                      {t(`timi.warn.${w}`)}
                    </div>
                  ))}
                  <div style={warn} data-testid="timi-not-flow-grade">
                    {t("timi.notFlowGrade")}
                  </div>
                  <div style={hint}>{t("timi.reference")}</div>
                  <div style={row}>
                    <button
                      type="button"
                      style={primaryBtn}
                      data-testid="timi-publish"
                      onClick={publishToReport}
                    >
                      {t("xa.analysis.publish")}
                    </button>
                    {published && <span style={hint}>✓</span>}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button type="button" style={btn} onClick={onClose} data-testid="timi-close">
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* ROI の矩形をドラッグで引く                                          */
/* ------------------------------------------------------------------ */

/**
 * 現在フレームを描いて、矩形をドラッグで引かせる。
 *
 * <p>🔑 **ビューアの上ではなくダイアログの中で引く。** そのためフレーム送りを止める必要が無い
 * （止めると TIMI の作業そのものができなくなる）。矩形は**画像座標**なので、
 * どのフレームを見ながら引いたかに依らず全フレームへ同じ位置で当たる。
 */
function RoiPicker({
  slice,
  roi,
  onChange,
}: {
  slice: Slice;
  roi: TimiRect | null;
  onChange: (r: TimiRect) => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const view = useMemo(() => {
    const scale = Math.min(PREVIEW_W / slice.width, PREVIEW_H / slice.height);
    return { scale, dw: Math.round(slice.width * scale), dh: Math.round(slice.height * scale) };
  }, [slice.width, slice.height]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // 画素値の範囲で正規化して描く（VOI を持ってこない＝見えればよい）。
    let min = Infinity;
    let max = -Infinity;
    for (const v of slice.values) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const span = max - min || 1;
    const img = ctx.createImageData(slice.width, slice.height);
    for (let i = 0; i < slice.values.length; i++) {
      const g = Math.round(((slice.values[i] - min) / span) * 255);
      img.data[i * 4] = g;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g;
      img.data[i * 4 + 3] = 255;
    }
    const off = document.createElement("canvas");
    off.width = slice.width;
    off.height = slice.height;
    off.getContext("2d")?.putImageData(img, 0, 0);
    canvas.width = view.dw;
    canvas.height = view.dh;
    ctx.clearRect(0, 0, view.dw, view.dh);
    ctx.drawImage(off, 0, 0, view.dw, view.dh);

    const box = drag ?? roi;
    if (box) {
      ctx.strokeStyle = "#e07a5f";
      ctx.lineWidth = 2;
      const x = Math.min(box.x0, box.x1) * view.scale;
      const y = Math.min(box.y0, box.y1) * view.scale;
      const w = Math.abs(box.x1 - box.x0) * view.scale;
      const h = Math.abs(box.y1 - box.y0) * view.scale;
      ctx.strokeRect(x, y, w, h);
    }
  }, [slice, view, roi, drag]);

  const toImage = (ev: React.MouseEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * slice.width,
      y: ((ev.clientY - rect.top) / rect.height) * slice.height,
    };
  };

  return (
    <div>
      <canvas
        ref={canvasRef}
        data-testid="timi-roi-canvas"
        style={{ border: "1px solid #c3ced9", cursor: "crosshair", display: "block" }}
        onMouseDown={(e) => {
          const p = toImage(e);
          if (p) setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
        }}
        onMouseMove={(e) => {
          if (!drag) return;
          const p = toImage(e);
          if (p) setDrag({ ...drag, x1: p.x, y1: p.y });
        }}
        onMouseUp={() => {
          if (!drag) return;
          // 点をつついただけの矩形は ROI にしない（面積 0 の平均は意味が無い）。
          if (Math.abs(drag.x1 - drag.x0) >= 3 && Math.abs(drag.y1 - drag.y0) >= 3) onChange(drag);
          setDrag(null);
        }}
      />
      <div style={hint}>{t("timi.roi.drawing")}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const panel: React.CSSProperties = {
  background: "#f4f6f8",
  color: "#22303c",
  borderRadius: 6,
  padding: 16,
  minWidth: 620,
  maxHeight: "88vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
const bodyRow: React.CSSProperties = { display: "flex", gap: 10, minHeight: 0, flex: 1 };
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 6 };
const section: React.CSSProperties = {
  border: "1px solid #d5dde4",
  borderRadius: 4,
  padding: 10,
  marginBottom: 10,
};
const sectionTitle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 6,
  color: "#44586a",
};
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  marginTop: 6,
  flexWrap: "wrap",
};
const label: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };
const btn: React.CSSProperties = {
  padding: "3px 10px",
  background: "#e6ecf1",
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#c3ced9",
  borderRadius: 4,
  cursor: "pointer",
};
const linkBtn: React.CSSProperties = {
  ...btn,
  padding: "1px 6px",
  background: "transparent",
  borderColor: "transparent",
};
const primaryBtn: React.CSSProperties = {
  ...btn,
  background: "#2f6f9f",
  color: "#fff",
  borderColor: "#2a6088",
};
const confirmBox: React.CSSProperties = {
  border: "1px solid #d9c48a",
  background: "#fdf6e3",
  borderRadius: 4,
  padding: 8,
  marginTop: 6,
  fontSize: 12,
};
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#b3452f", marginBottom: 8 };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", marginBottom: 4 };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a" };
const td: React.CSSProperties = {
  textAlign: "right",
  padding: "2px 8px 2px 0",
  fontVariantNumeric: "tabular-nums",
};
/** 🔴 単位は数字から離さない（数字だけを読んで別の量と混同されるのを防ぐ）。 */
const unitCell: React.CSSProperties = { fontSize: 11, color: "#66788a", padding: "2px 0" };
