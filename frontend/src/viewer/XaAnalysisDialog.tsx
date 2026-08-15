/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * XA の校正（C2/C3）と QCA を実行するダイアログ（`fw/angio-design.md` §7.3 / §8）。
 *
 * <h3>入力は「既存の Length 計測」</h3>
 * 専用のピッキングツールを新設せず、**ユーザが引いた Length 計測の 2 点**を入力にする。
 * - 校正: カテーテル外径（Fr）や既知ルーラーの上に引いた線 → その実寸 mm を入れて mm/px を確定
 * - QCA: 解析したい血管区間の始点・終点として使う
 * 既存の操作（計測を引く）をそのまま流用でき、道具を増やさない。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getRenderingEngine } from "@cornerstonejs/core";
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import {
  createQcaSr,
  createXaPresentationState,
  type AngioPresentationRequest,
} from "../api";
import { useI18n } from "../i18n/i18n";
import { publishQcaSnapshot } from "./debugApi";
import { readModalitySlice } from "./pixelCalibration";
import { QcaEditor, type QcaEditMode } from "./QcaEditor";
import { runQca, type QcaManualEdits, type QcaReferenceMode, type QcaResult } from "./qca";
import { TaskStepRail } from "./TaskStepRail";
import { ENGINE_ID } from "./Viewer2D";
import { readVoiWindow } from "./viewportRead";
import { isXaCalibrated } from "./xaCalibration";
import { describeView, registerQcaRun } from "./xaRecon3dStore";
import { readXaViewGeometry } from "./xaViewGeometryProvider";
import {
  calibrationForImageId,
  clearXaCalibrationCache,
  loaderSpacingFor,
  setXaUserCalibration,
} from "./xaCalibrationProvider";
import { clearedBy, deriveQcaSteps, type ManualInputKey } from "./xaTasks";

/** [x,y] の並びを GSPS 用のフラットな配列にする。 */
function flatten(points: readonly (readonly [number, number])[]): number[] {
  const out: number[] = [];
  for (const p of points) {
    out.push(p[0], p[1]);
  }
  return out;
}

/**
 * 全注釈の統計を無効化する。
 *
 * <p>🚨 空間校正を変えても、計測ラベルは **`cachedStats` に残った古い値のまま**になる
 * （Cornerstone は `invalidated` が立つまで再計算しない）。実機で「スケールバーは mm に
 * なったのに計測は px のまま」という形で出た。校正の確定/解除の直後に必ず呼ぶこと。
 */
function invalidateAnnotations(): void {
  try {
    const all = (csAnnotation.state.getAllAnnotations() as any[]) ?? [];
    for (const a of all) {
      if (a) a.invalidated = true;
    }
  } catch {
    /* 注釈が無ければ何もしない */
  }
}

function shortUid(uid: string): string {
  return uid.length > 12 ? `…${uid.slice(-12)}` : uid;
}

/**
 * 手修正の内容を人が読める 1 行にする。**保存物（SR）にそのまま入れる**。
 *
 * <p>手で直した値を自動値と同じ顔で保存すると、読む側が再現性・監査可能性を判断できない
 * （`fw/angio-design.md` §8.6）。全自動なら null を返し、SR 側が "None" と書く。
 */
function describeManual(result: QcaResult): string | null {
  const p = result.provenance;
  if (!p.edited) return null;
  const parts: string[] = [];
  if (p.waypoints > 0) parts.push(`waypoints=${p.waypoints}`);
  if (p.editedEdges.length > 0) parts.push(`edges=${p.editedEdges.length}`);
  if (p.trimmed) parts.push("trimmed");
  if (p.reference !== "auto") parts.push(`reference=${p.reference}`);
  return parts.join("; ");
}

/**
 * 表示中ビューポートの実 VOI を読む。
 *
 * <p>メタデータ（voiLutModule）ではなく**実際に表示されている値**を保存する。
 * ユーザが W/L を触った後にメタデータの値を保存すると、開き直したときに違う見え方になる。
 * 対象が見つからなければ null（GSPS の VOI モジュールを省く）。
 */
function readVoiFor(imageId: string): { windowCenter: number; windowWidth: number } | null {
  try {
    const engine = getRenderingEngine(ENGINE_ID);
    if (!engine) return null;
    for (const vp of engine.getViewports()) {
      const current = (vp as { getCurrentImageId?: () => string | undefined }).getCurrentImageId?.();
      if (current !== imageId) continue;
      const w = readVoiWindow(vp as never);
      if (w && Number.isFinite(w.center) && Number.isFinite(w.width)) {
        return { windowCenter: w.center, windowWidth: w.width };
      }
    }
  } catch {
    /* 読めなければ VOI は保存しない */
  }
  return null;
}

/** 手修正パネル用の窓（ビューポートと同じ見え方にする）。 */
function readVoiWindowFor(imageId: string): { center: number; width: number } | null {
  const v = readVoiFor(imageId);
  return v ? { center: v.windowCenter, width: v.windowWidth } : null;
}

interface LengthPick {
  uid: string;
  /** 画像座標 [px]。 */
  p0: [number, number];
  p1: [number, number];
  lengthPx: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * world 座標 → 画像ピクセル座標。
 *
 * <p>XA は IPP/IOP を持たないため、Cornerstone の StackViewport は既定平面
 * （原点 0・行/列方向が x/y 軸）を使う。よって world = (x·列spacing, y·行spacing)。
 *
 * <p>🚨 ここで使う spacing は **ローダが画像に付けた値**（DICOM の `PixelSpacing`、無ければ 1）で
 * あって、**我々が校正で決めた mm/px ではない**。校正値で割ると、校正した瞬間に座標が
 * 桁違いになり解析が黙って失敗する（実機で「校正後に古い結果が残る」形で発覚）。
 */
function worldToImagePx(
  w: readonly number[],
  mmPerPxRow: number | null,
  mmPerPxCol: number | null,
): [number, number] {
  const col = mmPerPxCol && mmPerPxCol > 0 ? mmPerPxCol : 1;
  const row = mmPerPxRow && mmPerPxRow > 0 ? mmPerPxRow : 1;
  return [w[0] / col, w[1] / row];
}

/** この imageId に紐づく Length 計測を集める。 */
function collectLengthPicks(
  imageId: string,
  mmPerPxRow: number | null,
  mmPerPxCol: number | null,
): LengthPick[] {
  let all: any[] = [];
  try {
    all = (csAnnotation.state.getAllAnnotations() as any[]) ?? [];
  } catch {
    return [];
  }
  const out: LengthPick[] = [];
  for (const a of all) {
    if (a?.metadata?.toolName !== "Length") continue;
    if (a?.metadata?.referencedImageId && a.metadata.referencedImageId !== imageId) continue;
    const pts = a?.data?.handles?.points;
    if (!Array.isArray(pts) || pts.length < 2) continue;
    const p0 = worldToImagePx(pts[0], mmPerPxRow, mmPerPxCol);
    const p1 = worldToImagePx(pts[1], mmPerPxRow, mmPerPxCol);
    out.push({
      uid: String(a.annotationUID ?? out.length),
      p0,
      p1,
      lengthPx: Math.hypot(p1[0] - p0[0], p1[1] - p0[1]),
    });
  }
  return out;
}

/** 保存（GSPS / SR）に必要な、表示中フレームの素性。SeriesViewer から渡す。 */
export interface XaSaveContext {
  studyUid: string;
  /** 表示中フレームの元インスタンス（＝ラン）。 */
  sopInstanceUid: string | null;
  /** 表示中フレーム（**0 origin**。DICOM へ書くときに +1 する）。 */
  frameIndex: number;
  /** DSA 中ならその設定（マスクフレームは 0 origin）。 */
  dsa?: { maskFrames: number[]; dx: number; dy: number } | null;
}

export function XaAnalysisDialog({
  imageId,
  seriesUid,
  isSubtracted,
  saveContext,
  onClose,
  onCalibrated,
}: {
  /** 解析対象の imageId（表示中フレーム。DSA 表示中は合成 imageId）。 */
  imageId: string;
  seriesUid: string;
  /** DSA 表示中か（血管が明るいか暗いかの判断に使う）。 */
  isSubtracted: boolean;
  saveContext: XaSaveContext;
  onClose: () => void;
  onCalibrated?: () => void;
}) {
  const { t } = useI18n();
  // 校正を確定/解除したら自分の表示も更新する（imageId は変わらないので版番号で回す）。
  const [calibVersion, setCalibVersion] = useState(0);
  const calib = useMemo(
    () => calibrationForImageId(imageId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imageId, calibVersion],
  );
  // world → 画像ピクセルの換算は**ローダの spacing**で行う（校正値ではない）。
  const picks = useMemo(() => {
    const sp = loaderSpacingFor(imageId);
    return collectLengthPicks(imageId, sp.row, sp.col);
  }, [imageId, calibVersion]);
  const [selected, setSelected] = useState(0);
  const [knownMm, setKnownMm] = useState("");
  const [frSize, setFrSize] = useState("6");
  const [result, setResult] = useState<QcaResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // ── 手修正（§8.6）─────────────────────────────────────────────────
  const [waypoints, setWaypoints] = useState<[number, number][]>([]);
  const [edgeEdits, setEdgeEdits] = useState<Record<number, { left?: number; right?: number }>>({});
  const [edgeToken, setEdgeToken] = useState<string | null>(null);
  const [trim, setTrim] = useState<{ from: number; to: number } | null>(null);
  const [refMode, setRefMode] = useState<QcaReferenceMode>({ kind: "auto" });
  const [editMode, setEditMode] = useState<QcaEditMode>("none");
  const [chartMode, setChartMode] = useState<"none" | "trim" | "reference">("none");
  const [highlight, setHighlight] = useState<number | null>(null);
  /** 解析に使った画素。手修正のたびに読み直すと重いのでキャッシュする。 */
  const sliceRef = useRef<{ imageId: string; values: Float32Array; width: number; height: number } | null>(null);

  const resetEdits = () => {
    setWaypoints([]);
    setEdgeEdits({});
    setEdgeToken(null);
    setTrim(null);
    setRefMode({ kind: "auto" });
    setEditMode("none");
    setChartMode("none");
    setHighlight(null);
  };

  useEffect(() => {
    setResult(null);
    setError(null);
    setSaved(null);
    sliceRef.current = null;
    resetEdits();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  const pick = picks[selected] ?? null;

  const applyCalibration = (mm: number, method: "catheter" | "ruler", note: string) => {
    if (!pick || !(pick.lengthPx > 0) || !(mm > 0)) {
      setError(t("xa.analysis.needLength"));
      return;
    }
    setXaUserCalibration(seriesUid, { mmPerPx: mm / pick.lengthPx, method, note });
    clearXaCalibrationCache();
    invalidateAnnotations();
    setError(null);
    setCalibVersion((v) => v + 1);
    onCalibrated?.();
  };

  /**
   * 表示状態を XA/XRF GSPS として保存する（非破壊）。
   * QCA を実行済みなら、中心線とエッジ・%DS のラベルも図形として一緒に保存する。
   */
  const savePresentationState = () => {
    const sop = saveContext.sopInstanceUid;
    if (!sop) {
      setError(t("xa.analysis.noReference"));
      return;
    }
    setSaving(true);
    setError(null);
    const c = calibrationForImageId(imageId);
    const voi = readVoiFor(imageId);
    const polylines: NonNullable<AngioPresentationRequest["polylines"]> = [];
    const texts: NonNullable<AngioPresentationRequest["texts"]> = [];
    if (result) {
      polylines.push({ layer: "QCA", points: flatten(result.centerline) });
      polylines.push({ layer: "QCA", points: flatten(result.edges.map((e) => e.left)) });
      polylines.push({ layer: "QCA", points: flatten(result.edges.map((e) => e.right)) });
      const mldPoint = result.centerline[result.mldIndex];
      if (mldPoint) {
        texts.push({
          layer: "QCA",
          text: `%DS ${result.percentDiameterStenosis.toFixed(1)} / MLD ${result.mld.toFixed(2)}${result.unit}`,
          anchorX: mldPoint[0],
          anchorY: mldPoint[1],
        });
      }
    }
    createXaPresentationState({
      studyInstanceUid: saveContext.studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sop,
      // DICOM のフレーム番号は 1 origin。
      frameNumbers: [saveContext.frameIndex + 1],
      label: "QCA",
      description: result
        ? `QCA %DS ${result.percentDiameterStenosis.toFixed(1)}${
            result.provenance.edited ? " (manually corrected)" : ""
          }`
        : "GRAPHY-Next presentation state",
      voi,
      invert: false,
      mask: saveContext.dsa
        ? {
            maskFrameNumbers: saveContext.dsa.maskFrames.map((i) => i + 1),
            // DICOM の MaskSubPixelShift は [row, column]。内部の {dx=横, dy=縦} と並びが逆。
            subPixelShiftRow: saveContext.dsa.dy,
            subPixelShiftCol: saveContext.dsa.dx,
          }
        : null,
      calibration:
        c && c.mmPerPxRow != null && c.mmPerPxCol != null
          ? {
              mmPerPxRow: c.mmPerPxRow,
              mmPerPxCol: c.mmPerPxCol,
              type: c.source === "user-catheter" || c.source === "dicom-fiducial" ? "FIDUCIAL" : "GEOMETRY",
              description: c.provenance,
            }
          : null,
      polylines,
      texts,
    })
      .then((r) => setSaved(t("xa.analysis.savedGsps", { uid: shortUid(r.sopInstanceUid) })))
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  /** QCA の計測値を Comprehensive SR として保存する。 */
  const saveQca = () => {
    const sop = saveContext.sopInstanceUid;
    if (!sop || !result) return;
    setSaving(true);
    setError(null);
    const c = calibrationForImageId(imageId);
    createQcaSr({
      studyInstanceUid: saveContext.studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: sop,
      frameNumber: saveContext.frameIndex + 1,
      unit: result.unit,
      calibration: c?.provenance ?? null,
      vesselLabel: null,
      // 手で直した値を自動値と同じ顔で保存しない（§8.6）。
      manualCorrection: describeManual(result),
      mld: result.mld,
      rvd: result.rvd,
      percentDiameterStenosis: result.percentDiameterStenosis,
      percentAreaStenosis: result.percentAreaStenosis,
      lesionLength: result.lesionLength,
    })
      .then((r) => setSaved(t("xa.analysis.savedSr", { uid: shortUid(r.sopInstanceUid) })))
      .catch(() => setError(t("xa.analysis.saveFailed")))
      .finally(() => setSaving(false));
  };

  /** 手修正を当てて解析し直す。画素はキャッシュを使うので同期的に終わる。 */
  const analyzeWith = (edits: QcaManualEdits, slice: { values: Float32Array; width: number; height: number }) => {
    if (!pick) return;
    const c = calibrationForImageId(imageId);
    const r = runQca({
      pixels: slice.values,
      width: slice.width,
      height: slice.height,
      start: pick.p0,
      end: pick.p1,
      edits,
      mmPerPxRow: c?.mmPerPxRow ?? null,
      mmPerPxCol: c?.mmPerPxCol ?? null,
      // DSA 後は血管が正の大きな値（明るい）、非サブトラクションは暗い。
      vesselIsDark: !isSubtracted,
    });
    if (!r) {
      // 失敗したときに**古い結果が残らない**ようにする（前回値を見て「変わっていない」と
      // 誤解する事故を防ぐ。実機で踏んだ）。
      setResult(null);
      // 🚨 検証用スナップショットも必ず消す。ここを残すと automator は**前のフレームの
      //    数値**を読んで合格してしまう（実際に「別フレームの結果が出ている」形で踏んだ）。
      //    画面と同じ理由で、失敗は「値が無い」でなければならない。
      publishQcaSnapshot(null);
      setError(t("xa.analysis.failed"));
      return;
    }
    setError(null);
    setResult(r);
    // 実機検証（automator）が掴む対象を計算できるように公開する。DEV 以外では何もしない。
    publishQcaSnapshot({
      imageId,
      centerline: r.centerline,
      edges: r.edges,
      pathIndices: r.pathIndices,
      centerlineToken: r.centerlineToken,
      provenance: r.provenance,
      mld: r.mld,
      rvd: r.rvd,
      percentDiameterStenosis: r.percentDiameterStenosis,
      percentAreaStenosis: r.percentAreaStenosis,
      lesionLength: r.lesionLength,
      points: r.diameters.length,
      referenceFirst: r.reference[0] ?? 0,
      referenceLast: r.reference[r.reference.length - 1] ?? 0,
      unit: r.unit,
      warnings: r.warnings,
    });
    // 3D QCA（A6a）で選べるように登録する。投影幾何が読めない装置・データでは登録しない
    // （角度や SID/SOD が無ければ 3D にはできない。§10.1 の表）。
    const view = readXaViewGeometry(imageId, saveContext.frameIndex);
    if (view.geometry) {
      registerQcaRun({
        imageId,
        studyUid: saveContext.studyUid,
        seriesUid,
        sopInstanceUid: saveContext.sopInstanceUid,
        frameIndex: saveContext.frameIndex,
        label: describeView(view.geometry, saveContext.frameIndex),
        geometry: view.geometry,
        centerline: r.centerline,
        diameters: r.diameters,
        diameterPathIndices: r.pathIndices,
        unit: r.unit,
        edited: r.provenance.edited,
        at: Date.now(),
      });
    }
    // 中心線が変わったらエッジ修正の宛先も変わる。UI 側の token を追随させる
    // （合わないまま持ち回ると runQca が捨てて警告を出す）。
    if (r.centerlineToken !== edgeToken) {
      setEdgeToken(r.centerlineToken);
      if (r.warnings.includes("edgeEditsDropped")) setEdgeEdits({});
    }
  };

  const currentEdits = (over?: Partial<QcaManualEdits>): QcaManualEdits => ({
    waypoints,
    edges: edgeToken && Object.keys(edgeEdits).length ? { token: edgeToken, byPathIndex: edgeEdits } : null,
    trim,
    reference: refMode,
    ...over,
  });

  /** 手修正を変えたら即座に再解析する（押し直しを要求しない）。 */
  const reanalyze = (over: Partial<QcaManualEdits>) => {
    const slice = sliceRef.current;
    if (!slice) return;
    analyzeWith(currentEdits(over), slice);
  };

  // ── 段（ステップ・レール。§21.6）─────────────────────────────────
  // 🚨 段の状態は**持たずに導出する**。フラグを別に持つと必ず実体とずれる。
  //    結果があるときは `result.provenance`（＝実際に適用された手修正）を見る。
  //    UI の状態を見ると「捨てられた手修正」を「適用済み」と表示してしまう。
  const steps = useMemo(
    () =>
      deriveQcaSteps({
        hasPick: !!pick,
        calibrated: calib ? isXaCalibrated(calib) : false,
        calibrationSource: calib?.source ?? null,
        hasResult: !!result,
        waypoints: result?.provenance.waypoints ?? 0,
        editedEdges: result?.provenance.editedEdges.length ?? 0,
        trimmed: result?.provenance.trimmed ?? false,
        referenceKind: result?.provenance.reference ?? "auto",
        edgeEditsDropped: result?.warnings.includes("edgeEditsDropped") ?? false,
        canSave: !!saveContext.sopInstanceUid,
        saved: !!saved,
      }),
    [pick, calib, result, saveContext.sopInstanceUid, saved],
  );

  /** 段に対応する節へスクロールする。節側は `data-step`（空白区切りで複数可）で名乗る。 */
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const goToStep = (id: string) => {
    const el = bodyRef.current?.querySelector(`[data-step~="${id}"]`);
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  /**
   * その段からやり直す。**捨てる範囲は `clearedBy()` が決める**（ここで個別に判断しない）。
   *
   * <p>「無効になる段」と「捨てる手修正」は別物。校正をやり直しても通過点は残る（画素座標なので）。
   */
  const redoFrom = (id: string) => {
    const keys: ManualInputKey[] = clearedBy(id);
    if (keys.length === 0) {
      goToStep(id);
      return;
    }
    const over: Partial<QcaManualEdits> = {};
    if (keys.includes("waypoints")) {
      setWaypoints([]);
      over.waypoints = [];
    }
    if (keys.includes("edges")) {
      setEdgeEdits({});
      over.edges = null;
    }
    if (keys.includes("trim")) {
      setTrim(null);
      over.trim = null;
    }
    if (keys.includes("reference")) {
      setRefMode({ kind: "auto" });
      over.reference = { kind: "auto" };
    }
    reanalyze(over);
    goToStep(id);
  };

  const runAnalysis = (edits?: QcaManualEdits) => {
    if (!pick) {
      setError(t("xa.analysis.needLength"));
      return;
    }
    const cached = sliceRef.current;
    if (cached && cached.imageId === imageId) {
      analyzeWith(edits ?? currentEdits(), cached);
      return;
    }
    setBusy(true);
    setError(null);
    setResult(null);
    readModalitySlice(imageId)
      .then((slice) => {
        if (!slice) {
          setError(t("xa.analysis.noPixels"));
          return;
        }
        sliceRef.current = { imageId, values: slice.values, width: slice.width, height: slice.height };
        analyzeWith(edits ?? currentEdits(), slice);
      })
      .catch(() => setError(t("xa.analysis.failed")))
      .finally(() => setBusy(false));
  };

  return (
    <div style={backdrop} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>
        <div style={title} data-testid="xa-analysis-dialog">{t("xa.analysis.title")}</div>

        <div style={body}>
        <div style={content} ref={bodyRef}>

        {/* 入力（Length 計測）の選択 */}
        <div style={section} data-step="input">
          <div style={sectionTitle}>{t("xa.analysis.input")}</div>
          {picks.length === 0 ? (
            <div style={hint}>{t("xa.analysis.needLength")}</div>
          ) : (
            <select value={selected} onChange={(e) => setSelected(Number(e.target.value))} style={select}>
              {picks.map((p, i) => (
                <option key={p.uid} value={i}>
                  #{i + 1} — {p.lengthPx.toFixed(1)} px
                </option>
              ))}
            </select>
          )}
        </div>

        {/* 校正（C2 カテーテル法 / C3 ルーラー法） */}
        <div style={section} data-step="calibration">
          <div style={sectionTitle}>{t("xa.analysis.calibration")}</div>
          <div style={hint} data-testid="xa-calib-status">
            {t("xa.calib.label")}: {calib ? t(`xa.calib.source.${calib.source}`) : "—"}
            {calib?.mmPerPxCol != null && ` (${calib.mmPerPxCol.toFixed(4)} mm/px)`}
          </div>
          <div style={row}>
            <label style={label}>
              {t("xa.analysis.catheterFr")}
              <input
                data-testid="xa-catheter-fr"
                value={frSize}
                onChange={(e) => setFrSize(e.target.value)}
                style={input}
                inputMode="decimal"
              />
            </label>
            <button
              style={btn}
              data-testid="xa-calibrate-catheter"
              disabled={!pick}
              onClick={() => {
                const fr = Number(frSize);
                if (!(fr > 0)) {
                  setError(t("xa.analysis.badNumber"));
                  return;
                }
                // Fr → mm は定義計算（1Fr = 1/3 mm）。実測外径は製品差があるので「公称値による」。
                applyCalibration(fr / 3, "catheter", t("xa.analysis.catheterNote", { fr: String(fr) }));
              }}
            >
              {t("xa.analysis.calibrateCatheter")}
            </button>
          </div>
          <div style={row}>
            <label style={label}>
              {t("xa.analysis.knownMm")}
              <input
                data-testid="xa-known-mm"
                value={knownMm}
                onChange={(e) => setKnownMm(e.target.value)}
                style={input}
                inputMode="decimal"
              />
            </label>
            <button
              style={btn}
              disabled={!pick}
              onClick={() => {
                const mm = Number(knownMm);
                if (!(mm > 0)) {
                  setError(t("xa.analysis.badNumber"));
                  return;
                }
                applyCalibration(mm, "ruler", t("xa.analysis.rulerNote", { mm: String(mm) }));
              }}
            >
              {t("xa.analysis.calibrateRuler")}
            </button>
            <button
              style={btn}
              data-testid="xa-clear-calibration"
              onClick={() => {
                setXaUserCalibration(seriesUid, null);
                clearXaCalibrationCache();
                invalidateAnnotations();
                setCalibVersion((v) => v + 1);
                onCalibrated?.();
              }}
            >
              {t("xa.analysis.clearCalibration")}
            </button>
          </div>
          <div style={hint}>{t("xa.analysis.catheterCaveat")}</div>
        </div>

        {/* QCA */}
        <div style={section} data-step="analysis">
          <div style={sectionTitle}>{t("xa.analysis.qca")}</div>
          <div style={row}>
            <button style={primaryBtn} data-testid="xa-qca-run" onClick={() => runAnalysis()} disabled={!pick || busy}>
              {busy ? t("common.loading") : t("xa.analysis.run")}
            </button>
            {result && (
              <button
                style={btn}
                data-testid="xa-qca-reset"
                disabled={!result.provenance.edited}
                onClick={() => {
                  resetEdits();
                  runAnalysis({ waypoints: [], edges: null, trim: null, reference: { kind: "auto" } });
                }}
              >
                {t("xa.qca.resetEdits")}
              </button>
            )}
            <span style={hint}>{t("xa.analysis.researchOnly")}</span>
          </div>

          {result && sliceRef.current && (
            /* 中心線とエッジはどちらもこのパネルで直すので、両方の段がここを指す。 */
            <div data-step="centerline edges">
              {/* 手修正（§8.6）。自動の中心線は外れていても必ず結果を出すので、ここが要る。 */}
              <div style={row}>
                <span style={{ fontSize: 11, color: "#44586a" }}>{t("xa.qca.editMode")}:</span>
                {(["none", "waypoint", "edge"] as const).map((m) => (
                  <button
                    key={m}
                    style={editMode === m ? primaryBtn : btn}
                    data-testid={`xa-qca-mode-${m}`}
                    onClick={() => setEditMode(m)}
                  >
                    {t(`xa.qca.mode.${m}`)}
                  </button>
                ))}
              </div>
              <QcaEditor
                pixels={sliceRef.current.values}
                width={sliceRef.current.width}
                height={sliceRef.current.height}
                voi={readVoiWindowFor(imageId)}
                result={result}
                mode={editMode}
                waypoints={waypoints}
                edgeEdits={edgeEdits}
                highlightIndex={highlight}
                onWaypointsChange={(next) => {
                  // 中心線が変わる＝エッジ修正の宛先が無意味になる（§8.6 の token）。
                  setWaypoints(next);
                  setEdgeEdits({});
                  reanalyze({ waypoints: next, edges: null });
                }}
                onEdgeEdit={(pathIndex, side, offset) => {
                  if (!edgeToken) return;
                  const next = { ...edgeEdits, [pathIndex]: { ...edgeEdits[pathIndex], [side]: offset } };
                  setEdgeEdits(next);
                  reanalyze({ edges: { token: edgeToken, byPathIndex: next } });
                }}
              />
            </div>
          )}

          {result && (
            <div data-step="range">
            <QcaReport
              result={result}
              chartMode={chartMode}
              trimmed={!!trim}
              referenceMode={refMode}
              onChartModeChange={setChartMode}
              onHighlight={setHighlight}
              onSelectRange={(from, to) => {
                if (chartMode === "trim") {
                  const next = { from, to };
                  setTrim(next);
                  // 切り詰めは計測点インデックスの意味なので、エッジ修正（path インデックス）は生きる。
                  reanalyze({ trim: next });
                } else if (chartMode === "reference") {
                  const ranges =
                    refMode.kind === "segments" ? [...refMode.ranges, [from, to] as [number, number]] : [[from, to] as [number, number]];
                  const next: QcaReferenceMode = { kind: "segments", ranges };
                  setRefMode(next);
                  reanalyze({ reference: next });
                }
              }}
              onClearTrim={() => {
                setTrim(null);
                reanalyze({ trim: null });
              }}
              onClearReference={() => {
                const next: QcaReferenceMode = { kind: "auto" };
                setRefMode(next);
                reanalyze({ reference: next });
              }}
            />
            </div>
          )}
        </div>

        {/* 保存（非破壊: GSPS ＝表示状態と描画 / SR ＝計測値）。fw/angio-design.md §14 */}
        <div style={section} data-step="save">
          <div style={sectionTitle}>{t("xa.analysis.save")}</div>
          <div style={row}>
            <button style={btn} disabled={saving || !saveContext.sopInstanceUid} onClick={savePresentationState}>
              {t("xa.analysis.saveGsps")}
            </button>
            <button
              style={btn}
              disabled={saving || !result || !saveContext.sopInstanceUid}
              onClick={saveQca}
            >
              {t("xa.analysis.saveSr")}
            </button>
            {saved && <span style={hint}>{saved}</span>}
          </div>
          <div style={hint}>{t("xa.analysis.saveHint")}</div>
        </div>

        {error && <div style={errorText}>{error}</div>}

        </div>
        <TaskStepRail steps={steps} onGo={goToStep} onRedo={redoFrom} />
        </div>

        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button style={btn} data-testid="xa-dialog-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 結果の数値と径プロファイル（依存を増やさないため素の SVG）。
 *
 * <p>グラフ上のドラッグで**解析区間の切り詰め**と**参照径に使う健常部の指定**ができる
 * （`fw/angio-design.md` §8.6）。どちらも「自動の推定が外れたときに人が決め直す」ためのもの。
 */
function QcaReport({
  result,
  chartMode,
  trimmed,
  referenceMode,
  onChartModeChange,
  onSelectRange,
  onClearTrim,
  onClearReference,
  onHighlight,
}: {
  result: QcaResult;
  chartMode: "none" | "trim" | "reference";
  trimmed: boolean;
  referenceMode: QcaReferenceMode;
  onChartModeChange: (m: "none" | "trim" | "reference") => void;
  onSelectRange: (from: number, to: number) => void;
  onClearTrim: () => void;
  onClearReference: () => void;
  onHighlight: (i: number | null) => void;
}) {
  const { t } = useI18n();
  const u = result.unit;
  const w = 460;
  const h = 120;
  const pad = 4;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  const n = result.diameters.length;
  const maxD = Math.max(...result.diameters, ...result.reference) * 1.1 || 1;
  const maxP = result.positions[result.positions.length - 1] || 1;
  const px = (i: number) => pad + (result.positions[i] / maxP) * (w - pad * 2);
  const py = (v: number) => h - pad - (v / maxD) * (h - pad * 2);
  const line = (vals: number[]) => vals.map((v, i) => `${px(i)},${py(v)}`).join(" ");

  /** 画面 x → 計測点インデックス。 */
  const indexAt = (clientX: number): number => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return 0;
    const target = ((clientX - rect.left) / rect.width) * w;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(px(i) - target);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  const band = (from: number, to: number, fill: string, key: string) => {
    const a = Math.min(from, to);
    const b = Math.max(from, to);
    return <rect key={key} x={px(a)} y={pad} width={Math.max(1, px(b) - px(a))} height={h - pad * 2} fill={fill} />;
  };

  return (
    <div>
      <table style={table}>
        <tbody>
          <tr>
            <td style={th}>MLD</td>
            <td style={td}>
              {result.mld.toFixed(2)} {u}
            </td>
            <td style={th}>RVD</td>
            <td style={td}>
              {result.rvd.toFixed(2)} {u}
            </td>
          </tr>
          <tr>
            <td style={th}>% Diameter Stenosis</td>
            <td style={td}>{result.percentDiameterStenosis.toFixed(1)} %</td>
            <td style={th}>% Area Stenosis</td>
            <td style={td}>{result.percentAreaStenosis.toFixed(1)} %</td>
          </tr>
          <tr>
            <td style={th}>{t("xa.analysis.lesionLength")}</td>
            <td style={td}>
              {result.lesionLength.toFixed(2)} {u}
            </td>
            <td style={th}>{t("xa.analysis.points")}</td>
            <td style={td}>{result.diameters.length}</td>
          </tr>
        </tbody>
      </table>

      {/* グラフ上での手修正（区間の切り詰め・健常部の指定）。 */}
      <div style={row}>
        <span style={{ fontSize: 11, color: "#44586a" }}>{t("xa.qca.chartMode")}:</span>
        {(["none", "trim", "reference"] as const).map((m) => (
          <button
            key={m}
            style={chartMode === m ? primaryBtn : btn}
            data-testid={`xa-qca-chart-${m}`}
            onClick={() => onChartModeChange(m)}
          >
            {t(`xa.qca.chart.${m}`)}
          </button>
        ))}
        {trimmed && (
          <button style={btn} data-testid="xa-qca-clear-trim" onClick={onClearTrim}>
            {t("xa.qca.clearTrim")}
          </button>
        )}
        {referenceMode.kind !== "auto" && (
          <button style={btn} data-testid="xa-qca-clear-reference" onClick={onClearReference}>
            {t("xa.qca.clearReference")}
          </button>
        )}
      </div>

      <svg
        ref={svgRef}
        width={w}
        height={h}
        data-testid="xa-qca-chart"
        style={{
          background: "#0f1720",
          borderRadius: 4,
          cursor: chartMode === "none" ? "default" : "col-resize",
          touchAction: "none",
        }}
        onPointerDown={(e) => {
          if (chartMode === "none") return;
          e.currentTarget.setPointerCapture(e.pointerId);
          const i = indexAt(e.clientX);
          setDragFrom(i);
          setDragTo(i);
        }}
        onPointerMove={(e) => {
          const i = indexAt(e.clientX);
          onHighlight(i);
          if (dragFrom != null) setDragTo(i);
        }}
        onPointerLeave={() => onHighlight(null)}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (dragFrom != null && dragTo != null && dragFrom !== dragTo) {
            onSelectRange(Math.min(dragFrom, dragTo), Math.max(dragFrom, dragTo));
          }
          setDragFrom(null);
          setDragTo(null);
        }}
      >
        {referenceMode.kind === "segments" &&
          referenceMode.ranges.map((r, i) => band(r[0], r[1], "rgba(109,139,168,0.28)", `ref-${i}`))}
        {dragFrom != null && dragTo != null && band(dragFrom, dragTo, "rgba(255,209,102,0.25)", "drag")}
        <polyline points={line(result.reference)} fill="none" stroke="#6d8ba8" strokeDasharray="4 3" />
        <polyline points={line(result.diameters)} fill="none" stroke="#7fd1b9" strokeWidth={1.5} />
        {result.provenance.editedEdges.map((i) => (
          <circle key={`e-${i}`} cx={px(i)} cy={py(result.diameters[i])} r={2} fill="#ffd166" />
        ))}
        <circle cx={px(result.mldIndex)} cy={py(result.mld)} r={3} fill="#e07a5f" />
      </svg>
      <div style={hint}>
        {chartMode === "trim"
          ? t("xa.qca.hintTrim")
          : chartMode === "reference"
            ? t("xa.qca.hintReference")
            : t("xa.analysis.chartHint", { unit: u })}
      </div>
      <div style={hint}>{t("xa.analysis.areaCaveat")}</div>
      {/* 手が入っているなら**必ず**表示する。自動値と同じ顔をさせない（保存物にも入る）。 */}
      {result.provenance.edited && (
        <div style={warn} data-testid="xa-qca-manual-badge">
          {t("xa.qca.manualBadge", {
            waypoints: String(result.provenance.waypoints),
            edges: String(result.provenance.editedEdges.length),
            trim: result.provenance.trimmed ? t("xa.qca.yes") : t("xa.qca.no"),
            reference: t(`xa.qca.refKind.${result.provenance.reference}`),
          })}
        </div>
      )}
      {result.warnings.includes("uncalibrated") && <div style={warn}>{t("xa.analysis.uncalibratedWarn")}</div>}
    </div>
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
  minWidth: 520,
  maxHeight: "86vh",
  // 中身（節の列）だけをスクロールさせ、**レールは常に見えている**ようにする。
  // パネル全体をスクロールさせると、段の一覧が画面外に出て意味を成さない。
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
};
/** 節の列 ＋ ステップ・レールの横並び。 */
const body: React.CSSProperties = { display: "flex", gap: 10, minHeight: 0, flex: 1 };
/** 節の列（ここだけスクロールする）。`minWidth:0` が無いと flex 子が縮まない。 */
const content: React.CSSProperties = { flex: 1, minWidth: 0, overflowY: "auto", paddingRight: 2 };
const title: React.CSSProperties = { fontWeight: 600, fontSize: 15, marginBottom: 10 };
const section: React.CSSProperties = {
  border: "1px solid #d5dde4",
  borderRadius: 4,
  padding: 10,
  marginBottom: 10,
};
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600, marginBottom: 6, color: "#44586a" };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 6, flexWrap: "wrap" };
const label: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 12 };
const input: React.CSSProperties = { width: 70, padding: "2px 4px", border: "1px solid #c3ced9", borderRadius: 3 };
const select: React.CSSProperties = { padding: "2px 4px", border: "1px solid #c3ced9", borderRadius: 3 };
const btn: React.CSSProperties = {
  padding: "3px 10px",
  background: "#e6ecf1",
  border: "1px solid #c3ced9",
  borderRadius: 4,
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = { ...btn, background: "#2f6f9f", color: "#fff", borderColor: "#2a6088" };
const hint: React.CSSProperties = { fontSize: 11, color: "#66788a", marginTop: 4 };
const warn: React.CSSProperties = { fontSize: 11, color: "#a5642a", marginTop: 4 };
const errorText: React.CSSProperties = { fontSize: 12, color: "#b3452f", marginBottom: 8 };
const table: React.CSSProperties = { fontSize: 12, borderCollapse: "collapse", marginBottom: 8 };
const th: React.CSSProperties = { textAlign: "left", padding: "2px 10px 2px 0", color: "#66788a" };
const td: React.CSSProperties = { textAlign: "right", padding: "2px 16px 2px 0", fontVariantNumeric: "tabular-nums" };
