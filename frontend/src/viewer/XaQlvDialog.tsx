/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QLV（左室造影の定量解析）ダイアログ — `fw/angio-design.md` §9.2 / A5b。
 *
 * <h3>段の構成が QCA と違う</h3>
 * ED/ES フレームの決定が要り、中心線・エッジは無い。段をタスクごとの純データにしてある
 * 理由がここに出る（§21.2-3）。レール自体は QCA と共有（`TaskStepRail`）。
 *
 * <h3>🚨 未校正の扱いが QCA と違う</h3>
 * QCA は未校正だと数値が px になるが、**QLV は EF がスケール不変なので未校正でも正しい**。
 * 出せないのは容積 (mL) と Kennedy 補正だけ（§9.2.1）。同じ「飛ばした」でも
 * **失われるものが違う**ので、理由の文言を変えている。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getRenderingEngine } from "@cornerstonejs/core";
import { createQlvSr } from "../api";
import { publishAnalysisResult } from "../report/analysisResultStore";
import { qlvRecord } from "../report/xaAnalysisRecords";
import { useI18n } from "../i18n/i18n";
import { publishQlvSnapshot } from "./debugApi";
import { LvContourEditor } from "./LvContourEditor";
import { readModalitySlice } from "./pixelCalibration";
import {
  computeQlv,
  expandedBounds,
  opacifiedAreaCount,
  opacifiedAreaInRect,
  smoothContour,
  suggestEdEs,
  clampFrameIndex,
  type Point,
  type QlvResult,
} from "./qlv";
import { TaskStepRail } from "./TaskStepRail";
import { ENGINE_ID } from "./Viewer2D";
import { readVoiWindow } from "./viewportRead";
import { isXaCalibrated } from "./xaCalibration";
import { calibrationForImageId } from "./xaCalibrationProvider";
import { clearedBy, deriveQlvSteps, QLV_STEPS, type ManualInputKey } from "./xaTasks";
import { lockSliceNavigation } from "./sliceNavigationLock";
import { viewerOverlayProps } from "./viewerOverlay";

/** 輪郭として成立する最小点数（弁輪 2 点＋心尖側 2 点）。 */
const MIN_POINTS = 4;
/** これ以上の点が引かれていたら、フレーム変更で捨てる前に確認する。 */
const CONFIRM_DISCARD_MIN_POINTS = 3;
/** 造影面積の時系列を作るときの間引き（全フレーム読むと重い）。 */
const CURVE_MAX_FRAMES = 60;

interface Slice {
  values: Float32Array;
  width: number;
  height: number;
}

function shortUid(uid: string): string {
  return uid.length > 12 ? `…${uid.slice(-12)}` : uid;
}

/** 表示中ビューポートの実 VOI（輪郭パネルを同じ見え方にする）。 */
function readVoiWindowFor(imageId: string): { center: number; width: number } | null {
  try {
    const engine = getRenderingEngine(ENGINE_ID);
    if (!engine) return null;
    for (const vp of engine.getViewports()) {
      const current = (vp as { getCurrentImageId?: () => string | undefined }).getCurrentImageId?.();
      if (current !== imageId) continue;
      const w = readVoiWindow(vp as never);
      if (w && Number.isFinite(w.center) && Number.isFinite(w.width)) return w;
    }
  } catch {
    /* 読めなければ自動 */
  }
  return null;
}

export interface QlvSaveContext {
  studyUid: string;
  /** ED フレームの元インスタンス。 */
  sopInstanceUidAt: (frameIndex: number) => string | null;
}

export function XaQlvDialog({
  imageIds,
  seriesUid,
  saveContext,
  frameTimeMs,
  onClose,
  onGoToFrame,
}: {
  /** フレーム列（表示中のスタックそのもの）。 */
  imageIds: readonly string[];
  seriesUid: string;
  saveContext: QlvSaveContext;
  /** フレーム間隔 [ms]。ED→ES の間隔が生理的に妥当かの検査に使う。 */
  frameTimeMs?: number | null;
  onClose: () => void;
  /** ビューアの表示フレームを合わせる（人が動きを見て選び直せるように）。 */
  onGoToFrame?: (index: number) => void;
}) {
  const { t } = useI18n();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [areaCurve, setAreaCurve] = useState<number[] | null>(null);
  const [frameWarnings, setFrameWarnings] = useState<string[]>([]);
  const [edFrame, setEdFrame] = useState<number | null>(null);
  const [esFrame, setEsFrame] = useState<number | null>(null);
  const [framesManual, setFramesManual] = useState(false);
  const [edPoints, setEdPoints] = useState<Point[]>([]);
  const [esPoints, setEsPoints] = useState<Point[]>([]);
  // buildCurve は非同期で、閉じ込めた値が古くなる。現在のフレームは ref で見る。
  const edFrameRef = useRef<number | null>(null);
  const esFrameRef = useRef<number | null>(null);
  edFrameRef.current = edFrame;
  esFrameRef.current = esFrame;
  const [editing, setEditing] = useState<"ed" | "es">("ed");
  /** フレーム変更の確認待ち（輪郭を破棄してよいか）。 */
  const [pendingFrame, setPendingFrame] = useState<{ which: "ed" | "es"; frame: number } | null>(null);

  /**
   * 🔴 **輪郭を引き始めたらフレームを固定する**（実機で言われた・2026-09-01。QCA / QVA と同じ扱い）。
   *
   * <p>ED / ES の輪郭は**それぞれのフレームの上**に引く。裏でホイールが効くと、引いている輪郭と
   * 画面の画像が別の心位相になり、**エラーは何も出ないまま容積と EF が別物になる**。
   * QCA 側は 2026-08-28 に錠を入れたが、**LV は入れ忘れていた**（`lockSliceNavigation` の
   * 呼び出しが 1 か所しか無かった）。
   *
   * <p>⚠️ **フレームを選び直す道は塞がない。** ED / ES の指定は `setFrame` →
   * `onGoToFrame` で親を直接動かすので錠を通らない（錠はホイール・キー・シネだけを止める）。
   * 選び直したときに輪郭を捨てるのも従来どおり。
   */
  const frameLocked = busy || edPoints.length > 0 || esPoints.length > 0;
  useEffect(() => {
    if (!frameLocked) return;
    return lockSliceNavigation();
  }, [frameLocked]);

  /** フレーム番号 → 画素。読んだものは使い回す。 */
  const sliceCache = useRef<Map<number, Slice>>(new Map());
  const [edSlice, setEdSlice] = useState<Slice | null>(null);
  const [esSlice, setEsSlice] = useState<Slice | null>(null);

  const calib = useMemo(() => calibrationForImageId(imageIds[0] ?? ""), [imageIds]);
  const calibrated = calib ? isXaCalibrated(calib) : false;
  const pixel = {
    mmPerPxRow: calibrated ? calib?.mmPerPxRow ?? null : null,
    mmPerPxCol: calibrated ? calib?.mmPerPxCol ?? null : null,
  };

  const loadSlice = async (frame: number): Promise<Slice | null> => {
    const hit = sliceCache.current.get(frame);
    if (hit) return hit;
    const id = imageIds[frame];
    if (!id) return null;
    const s = await readModalitySlice(id);
    if (!s) return null;
    const slice: Slice = { values: s.values, width: s.width, height: s.height };
    sliceCache.current.set(frame, slice);
    return slice;
  };

  /**
   * 造影面積の時系列を作って ED/ES を提案する。
   *
   * <p>⚠️ **提案であって決定ではない。** 造影剤注入で心室期外収縮は普通に起き、その直後の
   * 心拍は EF を過大評価する。ECG が無い本経路では検出できないので、人が必ず選び直せる
   * （§9.2.2）。提案に警告が付いている間は、段が `done` にならない。
   */
  /**
   * 候補フレームの周り ±{@code span} を全解像度で読み直し、極値のフレームへ寄せる。
   * 読めなかったフレームは飛ばす（1 枚読めないだけで提案を捨てない）。
   */
  const refineExtremum = async (
    center: number,
    span: number,
    roi: { x0: number; y0: number; x1: number; y1: number } | null,
    kind: "max" | "min",
  ): Promise<number> => {
    if (span <= 1) return center;
    let bestF = center;
    let bestV: number | null = null;
    for (let f = Math.max(0, center - span); f <= Math.min(imageIds.length - 1, center + span); f++) {
      const s = await loadSlice(f);
      if (!s) continue;
      const v = roi
        ? opacifiedAreaInRect(s.values, s.width, s.height, roi)
        : opacifiedAreaCount(s.values);
      if (bestV === null || (kind === "max" ? v > bestV : v < bestV)) {
        bestV = v;
        bestF = f;
      }
    }
    return bestF;
  };

  const buildCurve = async (roiPoints?: readonly Point[]) => {
    setBusy(true);
    setError(null);
    try {
      const n = imageIds.length;
      const step = Math.max(1, Math.ceil(n / CURVE_MAX_FRAMES));
      // 🚨 関心領域が無いと**画面全体の暗い画素**を数えることになり、心室ではなく
      //    横隔膜・脊椎・カテーテル・大動脈を見てしまう（実データで踏んだ。§9.2.2）。
      const roi = roiPoints && roiPoints.length >= 3 ? expandedBounds(roiPoints, 0.25) : null;
      const curve: number[] = [];
      const sampled: number[] = [];
      for (let i = 0; i < n; i += step) {
        const s = await loadSlice(i);
        if (!s) continue;
        curve.push(
          roi
            ? opacifiedAreaInRect(s.values, s.width, s.height, roi)
            : opacifiedAreaCount(s.values),
        );
        sampled.push(i);
      }
      if (curve.length < 3) {
        setError(t("qlv.error.curve"));
        return;
      }
      // 間引いているので、1 要素あたりの時間はフレーム間隔 × 間引き幅。
      const sug = suggestEdEs(curve, {
        frameIntervalMs: frameTimeMs ? frameTimeMs * step : null,
      });
      setAreaCurve(curve);
      if (!sug) {
        setError(t("qlv.error.curve"));
        return;
      }
      setFrameWarnings(sug.warnings);
      // 🔴 **間引いたカーブは真の山・谷を跨ぐ**（step=3・40ms なら 1 点 120ms。収縮期 300ms は
      //    たった 2.5 点）。提案の周りだけ**全解像度で読み直して**極値に合わせる。
      //    読み足すのは ±step の十数枚だけなので、全フレーム読むのとは費用が違う。
      const nextEd = await refineExtremum(sampled[sug.ed], step, roi, "max");
      const nextEs = await refineExtremum(sampled[sug.es], step, roi, "min");
      // 🚨 **フレームが変わったら、そのフレームに引いた輪郭は捨てる。**
      //    提案し直しは `setFrame` を通らないので、ここで同じ規則を適用しないと
      //    「別の心位相のフレームに、前のフレームの輪郭が残ったまま」結果が出る。
      //    変わっていない側は残す（関係ない操作が巻き戻ったように見えないため）。
      if (nextEd !== edFrameRef.current) setEdPoints([]);
      if (nextEs !== esFrameRef.current) setEsPoints([]);
      setEdFrame(nextEd);
      setEsFrame(nextEs);
      setFramesManual(false);
    } finally {
      setBusy(false);
    }
  };

  // 開いたら自動で提案する（人の操作を 1 つ減らす。選び直しは常にできる）。
  //
  // 🚨 **依存を `imageIds`（配列の参照）にしてはいけない。** 親の再レンダで配列の identity が
  //    変わるたびに再提案が走り、**人が選び直した ED/ES を黙って上書きする**。
  //    しかもフレームを合わせるために `onGoToFrame` を呼ぶと親が再レンダするので、
  //    「フレームを指定した瞬間に自動値へ戻る」という形で出る（実機検証で踏んだ）。
  //    中身が変わったときだけ走るよう、内容から作ったキーで 1 回だけにする。
  const curveKey = `${imageIds[0] ?? ""}#${imageIds.length}`;
  const suggestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (suggestedFor.current === curveKey) return;
    suggestedFor.current = curveKey;
    void buildCurve();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [curveKey]);

  // ED/ES が決まったらその画素を読む。
  useEffect(() => {
    if (edFrame == null) return;
    void loadSlice(edFrame).then((s) => setEdSlice(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edFrame]);
  useEffect(() => {
    if (esFrame == null) return;
    void loadSlice(esFrame).then((s) => setEsSlice(s));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [esFrame]);

  const result: QlvResult | null = useMemo(() => {
    if (edFrame == null || esFrame == null) return null;
    if (edPoints.length < MIN_POINTS || esPoints.length < MIN_POINTS) return null;
    return computeQlv({
      edFrame,
      esFrame,
      // クリック点そのものではなく**平滑化した輪郭**で測る（点間を直線で結ぶと面積を過小評価する）。
      edContour: smoothContour(edPoints),
      esContour: smoothContour(esPoints),
      pixel,
    });
  }, [edFrame, esFrame, edPoints, esPoints, pixel.mmPerPxRow, pixel.mmPerPxCol]);

  // 実機検証が数値で突き合わせられるように公開する（DEV のみ）。
  useEffect(() => {
    publishQlvSnapshot({
      edFrame: edFrame ?? -1,
      esFrame: esFrame ?? -1,
      framesManual,
      frameWarnings,
      areaCurve: areaCurve ?? [],
      edPoints: edPoints.length,
      esPoints: esPoints.length,
      result: result
        ? {
            ejectionFraction: result.ejectionFraction,
            edvMl: result.edvMl,
            esvMl: result.esvMl,
            edVolumePx3: result.ed.volumePx3,
            esVolumePx3: result.es.volumePx3,
            edAreaPx2: result.ed.areaPx2,
            esAreaPx2: result.es.areaPx2,
            edLongAxisPx: result.ed.longAxisPx,
            kennedyEf: result.kennedy?.ejectionFraction ?? null,
            unit: result.unit,
            warnings: result.warnings,
            wallMotion: result.wallMotion?.normalized ?? null,
            wallMotionMethod: result.wallMotion?.method ?? null,
          }
        : null,
    });
  }, [result, edFrame, esFrame, framesManual, frameWarnings, areaCurve, edPoints.length, esPoints.length]);

  // レポートへ差し込めるように登録する（A14）。**ED/ES の決め方も一緒に持ち込む**
  // （自動提案のままか人が選んだかで結果の意味が変わる。§9.2.2）。
  useEffect(() => {
    if (!result || edFrame == null || esFrame == null) return;
    const sop = saveContext.sopInstanceUidAt(edFrame);
    if (!sop) return;
    publishAnalysisResult(
      qlvRecord(
        {
          studyUid: saveContext.studyUid,
          seriesUid,
          sopInstanceUid: sop,
          edFrame,
          esFrame,
          framesManual,
          calibration: calib?.provenance ?? null,
          ejectionFraction: result.ejectionFraction,
          edvMl: result.edvMl,
          esvMl: result.esvMl,
          kennedyEjectionFraction: result.kennedy?.ejectionFraction ?? null,
        },
        t,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, edFrame, esFrame, framesManual]);

  const steps = useMemo(
    () =>
      deriveQlvSteps({
        hasFrames: edFrame != null && esFrame != null,
        framesManual,
        frameWarnings,
        calibrated,
        calibrationSource: calib?.source ?? null,
        edPoints: edPoints.length,
        esPoints: esPoints.length,
        minPoints: MIN_POINTS,
        hasResult: !!result,
        canSave: !!(edFrame != null && saveContext.sopInstanceUidAt(edFrame)),
        saved: !!saved,
      }),
    [edFrame, esFrame, framesManual, frameWarnings, calibrated, calib, edPoints.length, esPoints.length, result, saved, saveContext],
  );

  const bodyRef = useRef<HTMLDivElement | null>(null);
  const goToStep = (id: string) => {
    if (id === "edContour") setEditing("ed");
    if (id === "esContour") setEditing("es");
    bodyRef.current?.querySelector(`[data-step~="${id}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  /** その段からやり直す。捨てる範囲は `clearedBy()` が決める（個別に判断しない）。 */
  const redoFrom = (id: string) => {
    const keys: ManualInputKey[] = clearedBy(id, QLV_STEPS);
    if (keys.includes("edContour")) setEdPoints([]);
    if (keys.includes("esContour")) setEsPoints([]);
    if (keys.includes("frames")) {
      setFramesManual(false);
      void buildCurve();
    }
    goToStep(id);
  };

  /** フレームを実際に動かす。**輪郭の破棄はここで起きる。** */
  const applyFrame = (which: "ed" | "es", v: number) => {
    // 🚨 フレームを選び直したら、**そのフレームの上に引いた輪郭は別の心位相を指す**ので捨てる。
    if (which === "ed") {
      setEdFrame(v);
      setEdPoints([]);
    } else {
      setEsFrame(v);
      setEsPoints([]);
    }
    setFramesManual(true);
    setPendingFrame(null);
    onGoToFrame?.(v);
  };

  const setFrame = (which: "ed" | "es", value: unknown) => {
    // 🚨 **丸めるだけでは NaN が素通しする**（`Math.max(0, Math.min(n-1, Math.round(NaN)))` は NaN）。
    //    入っていたら面積カーブが x1="NaN" で落ち、`onGoToFrame(NaN)` でビューアの表示フレームまで
    //    NaN になる。空文字も「0 フレーム目」ではなく**変更なし**として扱う（消して打ち直すだけで
    //    先頭へ飛び、その位相の輪郭が破棄されるため）。判定は `clampFrameIndex` に集約した。
    const v = clampFrameIndex(value, imageIds.length);
    if (v == null) return;
    const current = which === "ed" ? edFrame : esFrame;
    if (v === current) return;
    // 🔴 **引きかけの輪郭がある間は、黙って捨てない**（利用者の要望・2026-09-02）。
    //    ±1 フレームの微調整でも全部消えるので、消える前に止められるようにする。
    //    点が少ないうち（引き始め）は聞かない——確認のほうが邪魔になる。
    //    ⚠️ ネイティブの confirm は使わない（レンダラのフォーカスを失う既知の不具合）。
    const pts = which === "ed" ? edPoints : esPoints;
    if (pts.length >= CONFIRM_DISCARD_MIN_POINTS) {
      setPendingFrame({ which, frame: v });
      return;
    }
    applyFrame(which, v);
  };

  const save = () => {
    if (!result || edFrame == null) return;
    const sop = saveContext.sopInstanceUidAt(edFrame);
    if (!sop) return;
    setSaving(true);
    setError(null);
    createQlvSr({
      studyInstanceUid: saveContext.studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sop,
      edFrameNumber: edFrame + 1,
      esFrameNumber: esFrame! + 1,
      unit: result.unit === "mL" ? "mL" : null,
      calibration: calib?.provenance ?? null,
      // 手で選び直したか・自動提案のままかは**結果の意味が変わる**ので必ず残す（§8.6 と同じ）。
      frameSelection: framesManual ? "manual" : "automatic (area curve)",
      ejectionFraction: result.ejectionFraction,
      edvMl: result.edvMl,
      esvMl: result.esvMl,
      kennedyEdvMl: result.kennedy?.edvMl ?? null,
      kennedyEsvMl: result.kennedy?.esvMl ?? null,
      kennedyEjectionFraction: result.kennedy?.ejectionFraction ?? null,
      method: "Area-Length (single plane)",
    })
      .then((r) => setSaved(t("qlv.saved", { uid: shortUid(r.sopInstanceUid) })))
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  const activeSlice = editing === "ed" ? edSlice : esSlice;
  const activeFrame = editing === "ed" ? edFrame : esFrame;
  const activePoints = editing === "ed" ? edPoints : esPoints;
  const voi = activeFrame != null ? readVoiWindowFor(imageIds[activeFrame] ?? "") : null;

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()} {...viewerOverlayProps}>
        <div style={title} data-testid="qlv-dialog">{t("qlv.title")}</div>

        <div style={body}>
          <div style={content} ref={bodyRef}>
            {/* ED / ES フレーム */}
            <div style={section} data-step="frames">
              <div style={sectionTitle}>{t("qlv.frames")}</div>
              {busy && <div style={hint}>{t("common.loading")}</div>}
              {areaCurve && (
                <AreaCurve
                  curve={areaCurve}
                  total={imageIds.length}
                  ed={edFrame}
                  es={esFrame}
                  onPick={(which, frame) => setFrame(which, frame)}
                />
              )}
              {areaCurve && <div style={hint}>{t("qlv.frames.hint")}</div>}
              {/* 🔴 引いた輪郭を黙って捨てない。捨てるのは人が押したときだけ。 */}
              {pendingFrame && (
                <div style={confirmBox} data-testid="qlv-frame-confirm">
                  <div>
                    {t("qlv.frames.confirm", {
                      which: pendingFrame.which.toUpperCase(),
                      from: String((pendingFrame.which === "ed" ? edFrame : esFrame) ?? "—"),
                      to: String(pendingFrame.frame),
                      points: String((pendingFrame.which === "ed" ? edPoints : esPoints).length),
                    })}
                  </div>
                  <div style={{ ...row, marginTop: 6 }}>
                    <button
                      style={primaryBtn}
                      data-testid="qlv-frame-confirm-ok"
                      onClick={() => applyFrame(pendingFrame.which, pendingFrame.frame)}
                    >
                      {t("qlv.frames.confirm.ok")}
                    </button>
                    <button style={btn} data-testid="qlv-frame-confirm-cancel" onClick={() => setPendingFrame(null)}>
                      {t("common.cancel")}
                    </button>
                  </div>
                </div>
              )}
              <div style={row}>
                <label style={label}>
                  {t("qlv.ed")}
                  <input
                    style={input}
                    data-testid="qlv-ed-frame"
                    value={edFrame ?? ""}
                    inputMode="numeric"
                    onChange={(e) => setFrame("ed", e.target.value)}
                  />
                </label>
                <label style={label}>
                  {t("qlv.es")}
                  <input
                    style={input}
                    data-testid="qlv-es-frame"
                    value={esFrame ?? ""}
                    inputMode="numeric"
                    onChange={(e) => setFrame("es", e.target.value)}
                  />
                </label>
                <button style={btn} data-testid="qlv-resuggest" onClick={() => void buildCurve()} disabled={busy}>
                  {t("qlv.resuggest")}
                </button>
                {/* 🚨 これが本命。関心領域なしの曲線は心室を見ていない（§9.2.2）。 */}
                <button
                  style={edPoints.length >= 3 ? primaryBtn : btn}
                  data-testid="qlv-resuggest-roi"
                  onClick={() => void buildCurve(edPoints)}
                  disabled={busy || edPoints.length < 3}
                  title={t("qlv.resuggestRoiTitle")}
                >
                  {t("qlv.resuggestRoi")}
                </button>
              </div>
              <div style={hint}>{t("qlv.framesHint")}</div>
              {frameWarnings.map((w) => (
                <div key={w} style={warn} data-testid={`qlv-frame-warn-${w}`}>
                  {t(`qlv.step.reason.${w}`)}
                </div>
              ))}
            </div>

            {/* 輪郭 */}
            <div style={section} data-step="edContour esContour">
              <div style={sectionTitle}>{t("qlv.contour")}</div>
              {/* 🔴 止まっている理由を出す。動かないのに理由が無いと「壊れている」と読まれる。 */}
              {frameLocked && (
                <div
                  style={{ fontSize: 11, color: "#8a6d3b", marginBottom: 4 }}
                  data-testid="qlv-frame-locked"
                >
                  {t("qlv.frameLocked")}
                </div>
              )}
              <div style={row}>
                {(["ed", "es"] as const).map((k) => (
                  <button
                    key={k}
                    style={editing === k ? primaryBtn : btn}
                    data-testid={`qlv-edit-${k}`}
                    onClick={() => setEditing(k)}
                  >
                    {t(`qlv.edit.${k}`)}（{k === "ed" ? edPoints.length : esPoints.length}）
                  </button>
                ))}
                <button
                  style={btn}
                  data-testid="qlv-clear-contour"
                  onClick={() => (editing === "ed" ? setEdPoints([]) : setEsPoints([]))}
                >
                  {t("qlv.clearContour")}
                </button>
              </div>
              {activeSlice ? (
                <LvContourEditor
                  pixels={activeSlice.values}
                  width={activeSlice.width}
                  height={activeSlice.height}
                  voi={voi}
                  points={activePoints}
                  publishView
                  testId="lv-contour-canvas"
                  ghost={editing === "es" && edPoints.length >= 2 ? edPoints : null}
                  onChange={(next) => (editing === "ed" ? setEdPoints(next) : setEsPoints(next))}
                />
              ) : (
                <div style={hint}>{t("common.loading")}</div>
              )}
            </div>

            {/* 結果 */}
            <div style={section} data-step="result">
              <div style={sectionTitle}>{t("qlv.result")}</div>
              {result ? <QlvReport result={result} /> : <div style={hint}>{t("qlv.needContours")}</div>}
            </div>

            {/* 保存 */}
            <div style={section} data-step="save">
              <div style={sectionTitle}>{t("xa.analysis.save")}</div>
              <div style={row}>
                <button style={btn} data-testid="qlv-save-sr" disabled={saving || !result} onClick={save}>
                  {t("xa.analysis.saveSr")}
                </button>
                {saved && <span style={hint}>{saved}</span>}
              </div>
            </div>

            {error && <div style={errorText}>{error}</div>}
          </div>
          <TaskStepRail steps={steps} onGo={goToStep} onRedo={redoFrom} />
        </div>

        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button style={btn} data-testid="qlv-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 造影面積の時系列（ED/ES の根拠を人が見て確かめられるように出す）。 */
/**
 * 造影面積の時系列と、ED / ES の位置を示す縦線。
 *
 * <h3>縦線はドラッグして動かせる（利用者の要望・2026-09-02）</h3>
 * フレーム番号を数値で打つより、**面積カーブの谷と山を見ながら掴んで動かす**ほうが早い
 * ——ED は面積が最大、ES は最小の位相なので、選ぶ根拠がこのグラフの上にある。
 *
 * <p>🔴 **確定はドラッグを離したときに 1 回だけ**（QCA の参照径の帯と同じ約束・§9.1.0d）。
 * 動かしている間に毎回 {@code onPick} を呼ぶと、**フレームを変えるたびに親が再レンダし、
 * その位相の輪郭が破棄される**——掴んで動かしただけで輪郭が消え、しかも重い。
 * 掴んでいる間は**この図の中の縦線だけ**を先に動かす。
 */
function AreaCurve({
  curve,
  total,
  ed,
  es,
  onPick,
}: {
  curve: readonly number[];
  total: number;
  ed: number | null;
  es: number | null;
  /** ドラッグを離したときに 1 回だけ呼ばれる。 */
  onPick?: (which: "ed" | "es", frame: number) => void;
}) {
  const w = 440;
  const h = 70;
  /** 掴める距離 [px]。細い線そのものを狙わせない。 */
  const GRAB_PX = 14;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ which: "ed" | "es"; frame: number } | null>(null);

  const max = Math.max(...curve);
  const min = Math.min(...curve);
  const span = max > min ? max - min : 1;
  const px = (i: number) => (i / Math.max(1, curve.length - 1)) * w;
  const py = (v: number) => h - ((v - min) / span) * (h - 6) - 3;
  const usable = Number.isFinite(total) && total > 1;
  const frameToX = (frame: number) => (frame / (total - 1)) * w;
  /** 画面座標 → フレーム番号。SVG は CSS で伸縮しうるので**実寸で割る**。 */
  const frameAt = (clientX: number): number | null => {
    const el = svgRef.current;
    if (!el || !usable) return null;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0)) return null;
    return clampFrameIndex(((clientX - r.left) / r.width) * (total - 1), total);
  };

  // 掴んでいる間は、その線だけ手元の値で描く（親はまだ動かさない）。
  const edAt = drag?.which === "ed" ? drag.frame : ed;
  const esAt = drag?.which === "es" ? drag.frame : es;

  const mark = (frame: number | null, color: string, key: string) => {
    // 二重の守り。上流（`clampFrameIndex`）で弾いているが、**描く側でも NaN を描かない**
    //    ——SVG は NaN を渡されると属性エラーを出して、その線だけでなく読み手の信頼を損ねる。
    if (frame == null || !Number.isFinite(frame) || !usable) return null;
    const x = frameToX(frame);
    return (
      <g key={key} data-testid={`qlv-mark-${key}`} data-frame={frame}>
        {/* 掴みしろ。見えないが太い（線そのものは 1.5px で狙えない）。 */}
        <line x1={x} y1={0} x2={x} y2={h} stroke="transparent" strokeWidth={GRAB_PX} />
        <line x1={x} y1={0} x2={x} y2={h} stroke={color} strokeWidth={1.5} />
        <rect x={x - 3} y={0} width={6} height={5} fill={color} />
      </g>
    );
  };

  const pick = (clientX: number): "ed" | "es" | null => {
    const f = frameAt(clientX);
    if (f == null) return null;
    const x = frameToX(f);
    const dEd = ed != null && Number.isFinite(ed) ? Math.abs(frameToX(ed) - x) : Infinity;
    const dEs = es != null && Number.isFinite(es) ? Math.abs(frameToX(es) - x) : Infinity;
    const near = Math.min(dEd, dEs);
    // 🔴 **どちらの線からも遠いときは何もしない。** 近いほうへ勝手に飛ばすと、
    //    グラフを何気なく押しただけで ED/ES が変わり、その位相の輪郭が消える。
    if (near > GRAB_PX) return null;
    return dEd <= dEs ? "ed" : "es";
  };

  return (
    <svg
      ref={svgRef}
      width={w}
      height={h}
      data-testid="qlv-area-curve"
      style={{
        display: "block",
        background: "#eef2f6",
        cursor: onPick && usable ? "ew-resize" : "default",
        touchAction: "none",
      }}
      onPointerDown={(e) => {
        if (!onPick) return;
        const which = pick(e.clientX);
        const f = frameAt(e.clientX);
        if (which == null || f == null) return;
        setDrag({ which, frame: f });
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const f = frameAt(e.clientX);
        if (f == null) return;
        setDrag({ ...drag, frame: f });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        e.currentTarget.releasePointerCapture(e.pointerId);
        const { which, frame } = drag;
        setDrag(null);
        // 掴んだだけで動かしていないなら、輪郭を捨てる理由が無い。
        const current = which === "ed" ? ed : es;
        if (frame !== current) onPick?.(which, frame);
      }}
    >
      <polyline
        points={curve.map((v, i) => `${px(i)},${py(v)}`).join(" ")}
        fill="none"
        stroke="#6d8ba8"
        strokeWidth={1.4}
      />
      {mark(edAt, "#3f8f6f", "ed")}
      {mark(esAt, "#e07a5f", "es")}
    </svg>
  );
}

function QlvReport({ result }: { result: QlvResult }) {
  const { t } = useI18n();
  const wm = result.wallMotion;
  return (
    <div>
      <table style={table}>
        <tbody>
          <tr>
            <td style={th}>{t("qlv.ef")}</td>
            <td style={td} data-testid="qlv-ef">
              {result.ejectionFraction.toFixed(1)} %
            </td>
          </tr>
          <tr>
            <td style={th}>{t("qlv.edv")}</td>
            <td style={td} data-testid="qlv-edv">
              {result.edvMl != null ? `${result.edvMl.toFixed(1)} mL` : t("qlv.noVolume")}
            </td>
          </tr>
          <tr>
            <td style={th}>{t("qlv.esv")}</td>
            <td style={td} data-testid="qlv-esv">
              {result.esvMl != null ? `${result.esvMl.toFixed(1)} mL` : t("qlv.noVolume")}
            </td>
          </tr>
          {result.kennedy && (
            <tr>
              <td style={th}>{t("qlv.kennedy")}</td>
              <td style={td} data-testid="qlv-kennedy">
                EF {result.kennedy.ejectionFraction.toFixed(1)} % / EDV {result.kennedy.edvMl.toFixed(1)} mL
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {wm && <WallMotionChart values={wm.normalized} />}
      {wm && <div style={hint}>{t("qlv.wallMotionMethod")}</div>}
      <div style={hint}>{t("qlv.areaLengthCaveat")}</div>
      <div style={hint}>{t("xa.analysis.researchOnly")}</div>
      {result.warnings.map((w) => (
        <div key={w} style={warn} data-testid={`qlv-warn-${w}`}>
          {t(`qlv.warn.${w}`)}
        </div>
      ))}
    </div>
  );
}

/** 弦ごとの短縮（無次元）。正常値データベースは持たない（§9.2）。 */
function WallMotionChart({ values }: { values: readonly number[] }) {
  const w = 440;
  const h = 72;
  const max = Math.max(0.02, ...values.map(Math.abs));
  const zero = h / 2;
  return (
    <svg width={w} height={h} data-testid="qlv-wall-motion" style={{ display: "block", background: "#eef2f6" }}>
      <line x1={0} y1={zero} x2={w} y2={zero} stroke="#c3ced9" />
      <polyline
        points={values
          .map((v, i) => `${(i / Math.max(1, values.length - 1)) * w},${zero - (v / max) * (zero - 4)}`)
          .join(" ")}
        fill="none"
        stroke="#7fd1b9"
        strokeWidth={1.4}
      />
    </svg>
  );
}

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
  minWidth: 560,
  maxHeight: "88vh",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
const body: React.CSSProperties = { display: "flex", gap: 10, minHeight: 0, flex: 1 };
const content: React.CSSProperties = { flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 2 };
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 10 };
const section: React.CSSProperties = { border: "1px solid #d5dde4", borderRadius: 4, padding: 10, marginBottom: 10 };
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#44586a" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" };
const label: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };
const input: React.CSSProperties = { width: 60, padding: "2px 4px", border: "1px solid #c3ced9", borderRadius: 3 };
const btn: React.CSSProperties = {
  padding: "3px 10px",
  background: "#e6ecf1",
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "#c3ced9",
  borderRadius: 4,
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#2f6f9f", color: "#fff", borderColor: "#2a6088" };
/** 破棄の確認。**警告と同じ色**にして、押す前に気付かせる。 */
const confirmBox: React.CSSProperties = {
  border: "1px solid #d9c48a",
  background: "#f7f0e2",
  color: "#8a6d3b",
  borderRadius: 4,
  padding: "8px 10px",
  marginTop: 6,
  fontSize: 12,
};
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#b3452f", marginBottom: 8 };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", marginBottom: 8 };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a" };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 16px 2px 0", fontVariantNumeric: "tabular-nums" };
