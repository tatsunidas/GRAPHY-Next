/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RenderingEngine, Enums, EVENTS, utilities, type Types } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  LengthTool,
  AngleTool,
  EllipticalROITool,
  RectangleROITool,
  ProbeTool,
  BrushTool,
  annotation as csAnnotation,
  utilities as csToolsUtilities,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { ensureStackSegmentation, disposeViewportSegmentation } from "./segmentation";
import { ERASER_TOOL_ID } from "./toolIds";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import { applyTransform, isPanned, readTransform, type ViewTransform, FIT_TRANSFORM } from "./transform";
import { readImageInfo, sampleAtCanvas, computeSliceSpacing, type ImageInfo, type PixelSample } from "./imageInfo";
import { computeOrientationMarkers, type OrientationMarkers } from "./orientation";
import { computeScaleBar, type ScaleBar } from "./scaleBar";
import { getOrCreateCameraSync, getOrCreateVoiSync, getOrCreatePresentationSync, getOrCreateSeriesVoiSync, broadcastSeriesProperties, captureVoiBaseline, clearVoiBaseline } from "./sync";
import { registerReferenceSource, bumpReference, subscribeReference, computeReferenceSegments, type RefSegment } from "./referenceLines";
import { registerViewerCommands, type ViewerCommands } from "./viewerCommands";
import { resolveOverlay } from "./overlayText";
import { useOverlayConfig } from "./overlayConfig";
import { ImageInfoPanel } from "./ImageInfoPanel";
import { matchesCombo } from "../shortcuts/registry";
import { useI18n } from "../i18n/i18n";
import { LutDialog } from "./LutDialog";
import type { LutData } from "../api";

type ViewSnapshot = { transform: ViewTransform; voi: { lower: number; upper: number } | null };

const { MouseBindings } = csToolsEnums;

/** カラー（RGB/YBR/PALETTE）画像か。MONOCHROME 以外を色付きとみなす。LUT/Invert の可否判定に使う。 */
function isColorImage(inf: ImageInfo | null): boolean {
  const p = inf?.photometricInterpretation;
  return !!p && !/MONOCHROME/i.test(p);
}

// LUT 解除（グレースケール復帰）用の線形グレースケール colormap 名。
// Cornerstone は colormap の明示「解除」手段を公開しないため、これを適用して戻す。
const GRAY_COLORMAP = "graphy-gray";

// 計測（ROI）ツール名。setActiveTool で左ドラッグに割り当てる。
const MEASURE_TOOLS = [
  LengthTool.toolName,
  AngleTool.toolName,
  EllipticalROITool.toolName,
  RectangleROITool.toolName,
  ProbeTool.toolName,
];
// 左ドラッグに割り当て可能なツール一覧（操作＋計測＋ブラシ）。
const PRIMARY_TOOLS = [WindowLevelTool.toolName, PanTool.toolName, ZoomTool.toolName, ...MEASURE_TOOLS, BrushTool.toolName];

// 単一の RenderingEngine を全ビューポートで共有する（WebGL コンテキストを 1 つに保つ＝省メモリ）。
export const ENGINE_ID = "graphy-engine";
let sharedEngine: RenderingEngine | null = null;
function getEngine(): RenderingEngine {
  if (!sharedEngine) {
    sharedEngine = new RenderingEngine(ENGINE_ID);
  }
  return sharedEngine;
}

let viewportSeq = 0;

/**
 * 2D 画像ビューア（単一スライス＋表示変換）。
 *
 * <p>表示の約束:
 * <ul>
 *   <li>表示倍率はコンポーネントサイズに Fit した状態を <b>1.0（100%）</b>とする。</li>
 *   <li>既定原点はコンポーネント中央（画像が中央）。</li>
 *   <li>zoom / pan / 上下左右 flip / rotation は <b>すべて affine（ViewPresentation）で管理</b>。</li>
 *   <li>コンポーネントの拡縮に追従して画像サイズを再 Fit（相対 zoom は維持）。</li>
 *   <li>zoom が 1.0 以外、または pan オフセットがあると Pan 状態 = true。</li>
 * </ul>
 *
 * <p>レイヤ: 深層に Cornerstone3D の StackViewport（canvas／WebGL）。上に DOM オーバーレイを
 * `pointer-events:none` で重ねる。入力はビューポート要素が処理（最前面の不透明イベント層は置かない）。
 */
/** 画像上オーバーレイの表示可否。SeriesViewer から制御。 */
export interface ViewerOverlays {
  text?: boolean;
  caliper?: boolean;
  orientation?: boolean;
}

/** 現在スライスの画像が画面上に描画されている矩形（wrap 内の CSS px）。 */
export interface ImageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** renderOverlay に渡すコンテキスト（Fusion オーバーレイ等が base 画像に正確に重なるための情報）。 */
export interface OverlayRenderContext {
  /** base 画像の表示矩形。zoom/pan/fit/flip に追従。 */
  rect: ImageRect;
  /** 現在スライスの Cornerstone3D imageId（空間 Fusion 用）。 */
  imageId: string;
  /** 現在スライスのインデックスと総数（比例 Fusion フォールバック用）。 */
  index: number;
  count: number;
}

export type RenderOverlay = (ctx: OverlayRenderContext) => React.ReactNode;

/**
 * base ビューポートの画像表示矩形（wrap 内 CSS px）を算出する。
 * 画像の四隅 index → world → canvas に変換した軸並行バウンディングボックス。
 * （回転時は厳密でないが、fit/zoom/pan/flip には追従する）
 */
function computeImageRect(vp: Types.IStackViewport): ImageRect | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const imgData = vp.getImageData() as any;
    const vtk = imgData?.imageData;
    const dims = imgData?.dimensions;
    if (!vtk || !dims) return null;
    const cols = dims[0];
    const rows = dims[1];
    // ピクセル端（-0.5 .. dim-0.5）を画像の外形とする。
    const tl = vp.worldToCanvas(utilities.transformIndexToWorld(vtk, [-0.5, -0.5, 0]));
    const tr = vp.worldToCanvas(utilities.transformIndexToWorld(vtk, [cols - 0.5, -0.5, 0]));
    const bl = vp.worldToCanvas(utilities.transformIndexToWorld(vtk, [-0.5, rows - 0.5, 0]));
    const left = Math.min(tl[0], tr[0], bl[0]);
    const top = Math.min(tl[1], tr[1], bl[1]);
    const width = Math.max(Math.abs(tr[0] - tl[0]), Math.abs(bl[0] - tl[0]));
    const height = Math.max(Math.abs(bl[1] - tl[1]), Math.abs(tr[1] - tl[1]));
    if (!Number.isFinite(left) || !Number.isFinite(top) || width <= 0 || height <= 0) return null;
    return { left, top, width, height };
  } catch {
    return null;
  }
}

export function Viewer2D({
  imageIds,
  imageIndex,
  overlays,
  compact,
  height,
  fill,
  syncGroupId,
  viewSyncEnabled,
  referenceLinesEnabled,
  referenceLabel,
  commandKey,
  renderOverlay,
}: {
  imageIds: string[];
  imageIndex: number;
  overlays?: ViewerOverlays;
  /** グリッドセル用: ツール/状態バー/ツールバー/情報パネルを省き、画像＋オーバーレイのみ表示。 */
  compact?: boolean;
  /** 画像領域の高さ(px)。既定 512。fill=true のときは無視。 */
  height?: number;
  /** タイル表示用: 親の高さに追従して canvas を伸縮する（flex:1 レイアウト）。 */
  fill?: boolean;
  /** 指定すると、共有ツールグループ＋camera/VOI 同期に参加（GridView リンク）。 */
  syncGroupId?: string;
  /** シリーズ Sync: true で base ビューポートをグローバル presentation+VOI synchronizer に参加させ、
   *  他タイルと W/L・Zoom・Pan・Rotation・Flip・Invert・LUT を連動させる（SliderView base 専用）。 */
  viewSyncEnabled?: boolean;
  /** リファレンスライン: true で他シリーズの現在スライス面が交差する線をこのビューに描画する。 */
  referenceLinesEnabled?: boolean;
  /** リファレンスラインのラベル（このシリーズ名。他ビューに描かれる線の凡例に使う）。 */
  referenceLabel?: string;
  /** 指定すると、この tileId をキーに画面メニュー/ツールバーからの一括コマンドに参加する（base のみ）。 */
  commandKey?: string;
  /** Fusion 等のオーバーレイを base 画像に重ねて描く。base 画像の表示矩形に追従する。 */
  renderOverlay?: RenderOverlay;
}) {
  const { t } = useI18n();
  const ov = { text: true, caliper: true, orientation: true, ...overlays };
  const elementRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Types.IStackViewport | null>(null);
  const viewportIdRef = useRef(`graphy-vp-${viewportSeq++}`);
  // 識別子は再レンダで変わるが init を再実行しないよう ref で最新を持つ。
  const imageIdsRef = useRef(imageIds);
  imageIdsRef.current = imageIds;
  const indexRef = useRef(imageIndex);
  indexRef.current = imageIndex;
  // 同じスタック(imageIds)なら init を再実行しない。C/T 切替で配列が変わると再 setStack。
  const stackKey = imageIds.join("|");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [transform, setTransform] = useState<ViewTransform>(FIT_TRANSFORM);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const infoRef = useRef<ImageInfo | null>(null);
  const [sample, setSample] = useState<PixelSample | null>(null);
  const [markers, setMarkers] = useState<OrientationMarkers | null>(null);
  const [scaleBar, setScaleBar] = useState<ScaleBar | null>(null);
  // base 画像の表示矩形（renderOverlay 用）。zoom/pan/fit に追従して更新。
  const [imageRect, setImageRect] = useState<ImageRect | null>(null);
  // onCameraModified の古いクロージャ問題を避けるため ref で最新の有無を参照。
  const renderOverlayRef = useRef(renderOverlay);
  renderOverlayRef.current = renderOverlay;
  // ライブの WW/WL（左ドラッグで変更。モダリティ値=HU 等の単位）。
  const [voi, setVoi] = useState<{ ww: number; wc: number } | null>(null);
  // 右の Image Info パネルの表示。Off で画像をその領域まで広げる。
  const [showInfo, setShowInfo] = useState(false);
  // 表示状態の Undo/Redo（クライアント側履歴。DICOM 不要）。
  const historyRef = useRef<ViewSnapshot[]>([]);
  const histIdxRef = useRef(-1);
  const applyingHistRef = useRef(false);
  const captureTimerRef = useRef<number | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [inverted, setInverted] = useState(false);
  // Pan モード: ON で左ドラッグ=パン、OFF で左ドラッグ=W/L。中ドラッグは常にパン、右はズーム。
  const [panMode, setPanMode] = useState(false);
  // リファレンスライン: 他シリーズの現在スライス面がこのビューと交差する線分（CSS px）。
  const [refSegments, setRefSegments] = useState<RefSegment[]>([]);
  const refLinesEnabledRef = useRef(referenceLinesEnabled);
  refLinesEnabledRef.current = referenceLinesEnabled;
  // シリーズ Sync 参加状態（invert/LUT の直接ブロードキャスト判定用。applyLut が useCallback で
  // stale クロージャになるため ref で最新を参照）。
  const viewSyncEnabledRef = useRef(viewSyncEnabled);
  viewSyncEnabledRef.current = viewSyncEnabled;
  // onCameraModified（init effect 内・stackKey 依存）から最新の再計算関数を呼ぶための間接参照。
  const recomputeRefLinesRef = useRef<() => void>(() => {});

  /** このビューに描く他シリーズの参照線分を再計算する。enabled でなければクリア。 */
  const recomputeRefLines = useCallback(() => {
    const v = viewportRef.current;
    if (!v || !refLinesEnabledRef.current) {
      setRefSegments((prev) => (prev.length ? [] : prev));
      return;
    }
    setRefSegments(computeReferenceSegments(viewportIdRef.current, v));
  }, []);
  recomputeRefLinesRef.current = recomputeRefLines;

  /** 左ドラッグの割り当てを Pan↔W/L で切り替える。 */
  const togglePan = () => {
    const tg = ToolGroupManager.getToolGroup(`${viewportIdRef.current}-tg`);
    const next = !panMode;
    if (tg) {
      try {
        if (next) {
          // 左＋中ドラッグ=Pan、W/L は無効化。
          tg.setToolActive(PanTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Primary }, { mouseButton: MouseBindings.Auxiliary }],
          });
          tg.setToolPassive(WindowLevelTool.toolName);
        } else {
          // 左=W/L、中=Pan に戻す。
          tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
        }
      } catch {
        /* ツールグループ未準備時は無視 */
      }
    }
    setPanMode(next);
  };

  // --- Undo/Redo（zoom/pan/rotate/flip/VOI のスナップショット） ---
  const snapshot = (): ViewSnapshot | null => {
    const vp = viewportRef.current;
    if (!vp) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const range = (vp.getProperties() as any)?.voiRange ?? null;
    return { transform: readTransform(vp), voi: range };
  };
  const updateUndoRedo = () => {
    setCanUndo(histIdxRef.current > 0);
    setCanRedo(histIdxRef.current < historyRef.current.length - 1);
  };
  const captureHistory = () => {
    if (applyingHistRef.current) return;
    const s = snapshot();
    if (!s) return;
    const h = historyRef.current;
    h.length = histIdxRef.current + 1; // redo 側を破棄
    h.push(s);
    if (h.length > 50) h.shift();
    histIdxRef.current = h.length - 1;
    updateUndoRedo();
  };
  const scheduleCapture = () => {
    if (applyingHistRef.current) return;
    if (captureTimerRef.current) window.clearTimeout(captureTimerRef.current);
    captureTimerRef.current = window.setTimeout(captureHistory, 350);
  };
  const applySnapshot = (s: ViewSnapshot | undefined) => {
    const vp = viewportRef.current;
    if (!vp || !s) return;
    applyingHistRef.current = true;
    if (captureTimerRef.current) window.clearTimeout(captureTimerRef.current);
    applyTransform(vp, s.transform);
    if (s.voi) {
      vp.setProperties({ voiRange: s.voi });
      vp.render();
      setVoi({ ww: s.voi.upper - s.voi.lower, wc: (s.voi.upper + s.voi.lower) / 2 });
    }
    setTransform(readTransform(vp));
    window.setTimeout(() => {
      applyingHistRef.current = false;
    }, 0);
  };
  const undo = () => {
    if (histIdxRef.current > 0) {
      histIdxRef.current -= 1;
      applySnapshot(historyRef.current[histIdxRef.current]);
      updateUndoRedo();
    }
  };
  const redo = () => {
    if (histIdxRef.current < historyRef.current.length - 1) {
      histIdxRef.current += 1;
      applySnapshot(historyRef.current[histIdxRef.current]);
      updateUndoRedo();
    }
  };
  const toggleInvert = () => {
    const vp = viewportRef.current;
    if (!vp) return;
    // カラー(RGB)画像は階調反転を適用しない（Cornerstone3D が invert を解釈できずエラーになる）。
    if (isColorImage(infoRef.current)) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cur = Boolean((vp.getProperties() as any)?.invert);
    try {
      vp.setProperties({ invert: !cur });
      vp.render();
      setInverted(!cur);
      // シリーズ Sync 中は他シリーズへ invert を伝播（VOI synchronizer は stack の invert を運ばない）。
      if (viewSyncEnabledRef.current) {
        broadcastSeriesProperties(viewportIdRef.current, { invert: !cur });
      }
    } catch {
      /* 反転非対応の画像は無視 */
    }
  };

  // ── LUT / カラーマップ ─────────────────────────────────────────

  const [showLutDialog, setShowLutDialog] = useState(false);
  const [activeLutName, setActiveLutName] = useState<string | null>(null);

  /** LUT データを Cornerstone3D に登録して適用する。null でグレースケールにリセット。 */
  const applyLut = useCallback((lut: LutData | null) => {
    const vp = viewportRef.current;
    if (!vp) return;
    // カラー(RGB)画像には LUT(カラーマップ)を適用しない。
    if (isColorImage(infoRef.current)) return;
    if (lut === null) {
      // グレースケールにリセット。Cornerstone は setProperties({colormap: undefined}) を no-op
      // とするため解除できない。そこで**線形グレースケール colormap を明示適用**して戻す。
      // （スライス変更時の colormap 再適用・シリーズ Sync とも整合する。）
      if (!utilities.colormap.getColormap(GRAY_COLORMAP)) {
        const grayPoints: number[] = [];
        for (let i = 0; i < 256; i++) grayPoints.push(i / 255, i / 255, i / 255, i / 255);
        utilities.colormap.registerColormap({ ColorSpace: "RGB", Name: GRAY_COLORMAP, RGBPoints: grayPoints });
      }
      vp.setProperties({ colormap: { name: GRAY_COLORMAP } });
      vp.render();
      setActiveLutName(null);
      if (viewSyncEnabledRef.current) {
        broadcastSeriesProperties(viewportIdRef.current, { colormap: { name: GRAY_COLORMAP } });
      }
      return;
    }
    const colormapName = `graphy-lut-${lut.name}`;
    // まだ登録されていなければ登録する
    if (!utilities.colormap.getColormap(colormapName)) {
      const rgbPoints: number[] = [];
      for (let i = 0; i < 256; i++) {
        rgbPoints.push(i / 255, lut.r[i] / 255, lut.g[i] / 255, lut.b[i] / 255);
      }
      utilities.colormap.registerColormap({
        ColorSpace: "RGB",
        Name: colormapName,
        RGBPoints: rgbPoints,
      });
    }
    vp.setProperties({ colormap: { name: colormapName } });
    vp.render();
    setActiveLutName(lut.name);
    // シリーズ Sync 中は他シリーズへ LUT を伝播（colormap は global 登録済みなので名前で適用可能）。
    if (viewSyncEnabledRef.current) {
      broadcastSeriesProperties(viewportIdRef.current, { colormap: { name: colormapName } });
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const element = elementRef.current;
    if (!element) return;
    const viewportId = viewportIdRef.current;
    const toolGroupId = `${viewportId}-tg`;
    let resizeObserver: ResizeObserver | null = null;

    // カーソル位置の輝度値（モダリティ値=HU 等）を読む。tools の入力は妨げない（受動的）。
    const onMove = (e: MouseEvent) => {
      const v = viewportRef.current;
      if (!v || !infoRef.current) return;
      const rect = element.getBoundingClientRect();
      setSample(sampleAtCanvas(v, [e.clientX - rect.left, e.clientY - rect.top], infoRef.current));
    };
    const onLeave = () => setSample(null);

    // カメラ暴走の自己修復。共有 RenderingEngine 上でスライス/シリーズ切替時にまれに
    // parallelScale が画像フィット規模を大きく超え（真っ黒/点表示）ることがあるため、
    // 検知したら resetCamera + 再描画で復帰する。無限ループ防止に再入ガードと回数上限。
    let healing = false;
    let healAttempts = 0;
    const sanitizeCamera = (vp: Types.IStackViewport): void => {
      if (healing) return;
      const ps = (vp.getCamera() as { parallelScale?: number })?.parallelScale;
      if (!ps || !Number.isFinite(ps) || ps <= 0) return;
      const inf = infoRef.current;
      const hWorld = (inf?.rows ?? 512) * (inf?.rowPixelSpacing ?? 1);
      const wWorld = (inf?.columns ?? 512) * (inf?.columnPixelSpacing ?? 1);
      const fitGuess = Math.max(hWorld, wWorld) / 2; // 概略フィット規模
      if (fitGuess > 0 && ps > fitGuess * 50) {
        if (healAttempts >= 3) return; // これ以上は無限ループ回避のため諦める
        healAttempts++;
        healing = true;
        try { vp.resetCamera(); vp.render(); } catch { /* ignore */ } finally { healing = false; }
      } else {
        healAttempts = 0; // 正常値を観測したらリセット
      }
    };

    const onCameraModified = () => {
      const vp = viewportRef.current;
      if (!vp || disposed) return;
      sanitizeCamera(vp);
      setTransform(readTransform(vp));
      // 向きマーカーは IOP があるときだけ。canvasToWorld 経由で zoom/pan/flip/rotation に追従。
      setMarkers(infoRef.current?.hasOrientation ? computeOrientationMarkers(vp, element) : null);
      // スケールバー（Caliper）: 校正の有無で mm/cm・px と色(黄/グレー)を切替。FOV(ズーム)に追従。
      const calibrated = Boolean(infoRef.current?.columnPixelSpacing);
      setScaleBar(computeScaleBar(vp, element, calibrated));
      if (renderOverlayRef.current) setImageRect(computeImageRect(vp)); // Fusion 等のオーバーレイ位置追従
      // リファレンスライン: 自分の面変化を他へ通知し、自分の描画も更新（pan/zoom/回転で追従）。
      if (!compact && !syncGroupId) {
        bumpReference();
        recomputeRefLinesRef.current();
      }
      if (!compact) scheduleCapture(); // Undo/Redo 履歴（操作確定後にデバウンス）
    };

    // VOI(WW/WL) を読み戻す。voiRange は [lower, upper]（モダリティ値）。WW=upper−lower, WL=中点。
    const onVoiModified = () => {
      const vp = viewportRef.current;
      if (!vp || disposed) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const range = (vp.getProperties() as any)?.voiRange;
      if (range && Number.isFinite(range.lower) && Number.isFinite(range.upper)) {
        setVoi({ ww: range.upper - range.lower, wc: (range.upper + range.lower) / 2 });
      }
      scheduleCapture();
    };

    (async () => {
      try {
        setLoading(true);
        setError(null);
        await ensureCornerstoneInitialized();
        if (disposed) return;

        const engine = getEngine();
        engine.enableElement({ viewportId, type: Enums.ViewportType.STACK, element });
        const viewport = engine.getViewport(viewportId) as Types.IStackViewport;
        viewportRef.current = viewport;
        await viewport.setStack(imageIdsRef.current, indexRef.current);

        // 輝度/ボクセル/FOV のキャリブレーション情報（読み込み後にメタが揃う）。
        const curId = imageIdsRef.current[indexRef.current];
        const inf = readImageInfo(curId);
        infoRef.current = inf;
        if (!disposed) setInfo(inf);

        // 初期 Window: DICOM の WindowCenter/Width があれば明示適用する。
        // CT 等は自動 VOI が生 16bit のパディング画素（例 -2048）や広いダイナミックレンジに
        // 引っ張られて真っ黒になりやすいため、DICOM 既定ウィンドウを優先する
        // （voiRange は Modality LUT 適用後＝CT は HU 空間。WindowCenter/Width も同空間）。
        if (inf.windowCenter !== undefined && inf.windowWidth !== undefined && inf.windowWidth > 0) {
          viewport.setProperties({
            voiRange: {
              lower: inf.windowCenter - inf.windowWidth / 2,
              upper: inf.windowCenter + inf.windowWidth / 2,
            },
          });
        }
        viewport.render();

        // スライス方向ボクセル奥行きは非同期（複数枚は隣接スライスのメタを要する）。後から合流。
        void (async () => {
          const r = await computeSliceSpacing(curId, imageIdsRef.current, inf.sliceThickness);
          if (disposed) return;
          const merged = { ...inf, sliceSpacing: r.spacing, sliceSpacingSource: r.source };
          infoRef.current = merged;
          setInfo(merged);
        })();

        // CAMERA_MODIFIED は compact でも必要（向きマーカー/スケールバーの初期計算・再Fit）。
        element.addEventListener(EVENTS.CAMERA_MODIFIED, onCameraModified);

        const wireTools = (tg: ReturnType<typeof ToolGroupManager.createToolGroup>) => {
          if (!tg) return;
          // 左ドラッグ=WW/WL、中ドラッグ=Pan、右ドラッグ=Zoom（ホイールはスライス送り）。
          if (!tg.hasTool(WindowLevelTool.toolName)) {
            tg.addTool(WindowLevelTool.toolName);
            tg.addTool(PanTool.toolName);
            tg.addTool(ZoomTool.toolName);
            // 計測（ROI）ツールは passive で追加。setActiveTool で左ドラッグに割当。
            for (const tn of MEASURE_TOOLS) {
              tg.addTool(tn);
              tg.setToolPassive(tn);
            }
            // ROI ブラシ（セグメンテーション編集）。passive で追加。
            tg.addTool(BrushTool.toolName);
            tg.setToolPassive(BrushTool.toolName);
            tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
            tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
            tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
          }
          tg.addViewport(viewportId, ENGINE_ID);
        };

        if (syncGroupId) {
          // GridView リンク: 共有ツールグループ＋camera/VOI 同期（シリーズ全体で連動）。
          wireTools(ToolGroupManager.getToolGroup(syncGroupId) ?? ToolGroupManager.createToolGroup(syncGroupId));
          getOrCreateCameraSync(`${syncGroupId}:cam`).add({ renderingEngineId: ENGINE_ID, viewportId });
          getOrCreateVoiSync(`${syncGroupId}:voi`).add({ renderingEngineId: ENGINE_ID, viewportId });
        } else if (!compact) {
          // 単独ツールグループ（SliderView）。
          wireTools(ToolGroupManager.getToolGroup(toolGroupId) ?? ToolGroupManager.createToolGroup(toolGroupId));
          element.addEventListener(EVENTS.VOI_MODIFIED, onVoiModified);
          element.addEventListener("mousemove", onMove);
          element.addEventListener("mouseleave", onLeave);
          onVoiModified();
        }
        onCameraModified();

        // コンポーネント拡縮に追従。再 Fit したうえで相対 zoom/pan/rotation/flip を維持する。
        // 注意: 共有 RenderingEngine では engine.resize(true,false) の自動再フィットが
        // 複数ビューポート時に誤った巨大 parallelScale を返し（黒画面/スケールバー暴走）、
        // さらに get/setViewPresentation で増幅される。これを避けるため、canvas のリサイズは
        // keepCamera=true（自動フィットしない）にし、フィットは viewport 単位の resetCamera で行う。
        // 実サイズが変化したときのみ実行（resize フィードバックループも防止）。
        let lastRW = element.clientWidth;
        let lastRH = element.clientHeight;
        resizeObserver = new ResizeObserver(() => {
          const vp = viewportRef.current;
          if (!vp || disposed) return;
          const w = element.clientWidth;
          const h = element.clientHeight;
          if (!w || !h) return; // 退化サイズ（レイアウト途中）は無視
          if (w === lastRW && h === lastRH) return; // 実サイズ変化なし
          lastRW = w;
          lastRH = h;
          const pres = vp.getViewPresentation();
          engine.resize(true, true); // canvas のみ新サイズへ（カメラ維持＝自動再フィットしない）
          vp.resetCamera(); // この viewport を要素サイズへ正しくフィット
          const fitScale = vp.getCamera().parallelScale ?? 0;
          try { vp.setViewPresentation(pres); } catch { /* 相対 zoom/pan/rotation/flip を再適用 */ }
          // 妥当性ガード: 再適用が異常な巨大/極小スケールを生んだら（共有エンジン由来の暴走）
          // クリーンなフィットへ戻す。50倍/1/50 は通常の深いズームを許容しつつ暴走のみ捕捉。
          const afterScale = vp.getCamera().parallelScale ?? 0;
          if (fitScale > 0 && afterScale > 0 && (afterScale > fitScale * 50 || afterScale < fitScale / 50)) {
            vp.resetCamera();
          }
          vp.render();
        });
        resizeObserver.observe(element);

        if (!disposed) setLoading(false);
      } catch (e) {
        if (!disposed) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      element.removeEventListener(EVENTS.CAMERA_MODIFIED, onCameraModified);
      element.removeEventListener(EVENTS.VOI_MODIFIED, onVoiModified);
      element.removeEventListener("mousemove", onMove);
      element.removeEventListener("mouseleave", onLeave);
      if (!compact && !syncGroupId) {
        disposeViewportSegmentation(viewportId);
      }
      if (syncGroupId) {
        // 共有ツールグループ/同期からこのビューポートだけ外す（グループ自体は他セルが使用）。
        try {
          getOrCreateCameraSync(`${syncGroupId}:cam`).remove({ renderingEngineId: ENGINE_ID, viewportId });
        } catch {
          /* 無ければ無視 */
        }
        try {
          getOrCreateVoiSync(`${syncGroupId}:voi`).remove({ renderingEngineId: ENGINE_ID, viewportId });
        } catch {
          /* 無ければ無視 */
        }
        try {
          ToolGroupManager.getToolGroup(syncGroupId)?.removeViewports(ENGINE_ID, viewportId);
        } catch {
          /* 無ければ無視 */
        }
      } else {
        try {
          ToolGroupManager.destroyToolGroup(toolGroupId);
        } catch {
          /* 無ければ無視 */
        }
      }
      try {
        getEngine().disableElement(viewportId);
      } catch {
        /* 既に破棄済みなら無視 */
      }
      viewportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackKey]);

  // スライス送り: imageIndex の変化を viewport へ反映（同一スタック内は setImageIdIndex が速い）。
  useEffect(() => {
    const v = viewportRef.current;
    if (!v) return;
    let cancelled = false;
    (async () => {
      try {
        if (v.getCurrentImageIdIndex() !== imageIndex) {
          await v.setImageIdIndex(imageIndex);
        }
        if (cancelled) return;
        // スライスごとに Rescale/Window/IPP 等が変わりうるので再読込（奥行きは据え置き）。
        const base = readImageInfo(imageIds[imageIndex]);
        const prev = infoRef.current;
        const merged = { ...base, sliceSpacing: prev?.sliceSpacing, sliceSpacingSource: prev?.sliceSpacingSource };
        infoRef.current = merged;
        setInfo(merged);
        // LUT(colormap) はスライス変更で actor の transfer function が grayscale に戻ることがある
        // （特に未ロード画像の初回表示）。viewport が保持する現在の colormap を読み直して再適用する。
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cmap = (v.getProperties() as any)?.colormap;
        if (cmap?.name) {
          try { v.setProperties({ colormap: cmap }); v.render(); } catch { /* ignore */ }
        }
        // リファレンスライン: スライスが変わると面も変わるので他へ通知し自分も更新（ZCT 追従）。
        if (!compact && !syncGroupId) {
          bumpReference();
          recomputeRefLinesRef.current();
        }
      } catch {
        // スライス切替の競合・例外時はフォールバックとして再フィット＋再描画を試みる
        // （まれに描画が崩れて真っ黒になるのを復帰させる）。
        try {
          const vp = viewportRef.current;
          if (vp && !cancelled) { vp.resetCamera(); vp.render(); }
        } catch { /* ignore */ }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIndex, stackKey]);

  // renderOverlay が後から有効化されたとき（Fusion 設定時など）に矩形を初期計算する。
  // renderOverlay は親で useCallback 安定化されている前提（毎レンダ別関数だとループするため）。
  useEffect(() => {
    if (!renderOverlay) {
      setImageRect(null);
      return;
    }
    const vp = viewportRef.current;
    if (vp) setImageRect(computeImageRect(vp));
  }, [renderOverlay]);

  // リファレンスライン: base ビューポートを source として常時登録（他ビューが参照）。
  // ラベル（シリーズ名）変化・再構築で再登録。SliderView base のみ。
  useEffect(() => {
    if (compact || syncGroupId) return;
    const unregister = registerReferenceSource({
      id: viewportIdRef.current,
      label: referenceLabel ?? "",
      getViewport: () => viewportRef.current,
    });
    return unregister;
  }, [compact, syncGroupId, referenceLabel]);

  // リファレンスライン: 他 source の面変化を購読し、自分の描画を更新する。
  useEffect(() => {
    if (compact || syncGroupId) return;
    const unsub = subscribeReference(() => recomputeRefLinesRef.current());
    return unsub;
  }, [compact, syncGroupId]);

  // リファレンスライン: トグル変化・初期化完了で再計算（自分が target としての描画）。
  useEffect(() => {
    recomputeRefLines();
  }, [referenceLinesEnabled, loading, stackKey, recomputeRefLines]);

  // シリーズ Sync（表示状態）: base ビューポートをグローバル presentation+VOI synchronizer に
  // add/remove する。SliderView base のみ（compact/grid セルは対象外）。viewSyncEnabled と
  // 初期化完了(loading)・スタック再構築(stackKey)に追従する。
  useEffect(() => {
    if (compact || syncGroupId || !viewSyncEnabled || loading) return;
    const vp = viewportRef.current;
    if (!vp) return;
    const target = { renderingEngineId: ENGINE_ID, viewportId: viewportIdRef.current };
    const pres = getOrCreatePresentationSync("graphy-series:pres");
    const voi = getOrCreateSeriesVoiSync("graphy-series:voi");
    try { pres.add(target); } catch { /* 既参加なら無視 */ }
    try { voi.add(target); } catch { /* 既参加なら無視 */ }
    // W/L 相対同期: 参加時点の W/L を基準値として記録（以降は変化量のみ適用）。
    captureVoiBaseline(viewportIdRef.current, vp);
    return () => {
      try { pres.remove(target); } catch { /* 無ければ無視 */ }
      try { voi.remove(target); } catch { /* 無ければ無視 */ }
      clearVoiBaseline(viewportIdRef.current);
    };
  }, [viewSyncEnabled, loading, compact, syncGroupId, stackKey]);

  // 画像表示用キーボード（スライダー単独表示のみ）: I=階調反転, Mod+Z=Undo, Mod+Shift+Z=Redo。
  useEffect(() => {
    if (compact || syncGroupId) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (matchesCombo("Mod+Shift+Z", e)) {
        e.preventDefault();
        redo();
      } else if (matchesCombo("Mod+Z", e)) {
        e.preventDefault();
        undo();
      } else if (matchesCombo("I", e)) {
        e.preventDefault();
        toggleInvert();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        // 選択中の ROI（計測注釈）を 1 つずつ削除。ROI をクリックで選択 → Delete/Backspace。
        const sel = csAnnotation.selection.getAnnotationsSelected();
        if (sel.length) {
          e.preventDefault();
          for (const uid of sel) {
            try { csAnnotation.state.removeAnnotation(uid); } catch { /* ignore */ }
          }
          viewportRef.current?.render();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact, syncGroupId]);

  // --- 操作（すべて affine = ViewPresentation 経由） ---
  const vp = () => viewportRef.current;
  // Fit: コンポーネントに合わせて 1.0・中央へ（回転/反転は保持）。
  const fit = () => {
    const v = vp();
    if (v) applyTransform(v, { zoom: 1, pan: [0, 0] });
  };
  // Reset: zoom/pan/回転/反転をすべて初期状態へ。
  const reset = () => {
    const v = vp();
    if (v) applyTransform(v, FIT_TRANSFORM);
  };
  const zoomBy = (f: number) => {
    const v = vp();
    if (v) applyTransform(v, { zoom: readTransform(v).zoom * f });
  };
  const rotate90 = () => {
    const v = vp();
    if (v) applyTransform(v, { rotation: (readTransform(v).rotation + 90) % 360 });
  };
  const flipH = () => {
    const v = vp();
    if (v) applyTransform(v, { flipHorizontal: !readTransform(v).flipHorizontal });
  };
  const flipV = () => {
    const v = vp();
    if (v) applyTransform(v, { flipVertical: !readTransform(v).flipVertical });
  };

  // W/L プリセット適用（モダリティ値=HU 等の windowCenter/Width）。
  const setWindowLevel = (center: number, width: number) => {
    const v = vp();
    if (!v || !(width > 0)) return;
    try {
      v.setProperties({ voiRange: { lower: center - width / 2, upper: center + width / 2 } });
      v.render();
      setVoi({ ww: width, wc: center });
    } catch {
      /* ignore */
    }
  };
  // DICOM 既定ウィンドウへ戻す（infoRef の WindowCenter/Width）。
  const resetWindow = () => {
    const inf = infoRef.current;
    if (inf?.windowCenter !== undefined && inf?.windowWidth !== undefined && inf.windowWidth > 0) {
      setWindowLevel(inf.windowCenter, inf.windowWidth);
    }
  };

  // 操作/計測/ブラシツールの切替（左ドラッグ割当）。中=Pan・右=Zoom はナビ用に常時維持。
  // ブラシ/消しゴムは BrushTool に集約（消しゴム=ERASE ストラテジ）。選択時に labelmap を保証。
  const setActiveTool = (toolName: string) => {
    const tg = ToolGroupManager.getToolGroup(`${viewportIdRef.current}-tg`);
    if (!tg) return;
    const isBrush = toolName === BrushTool.toolName;
    const isEraser = toolName === ERASER_TOOL_ID;
    const primary = isEraser ? BrushTool.toolName : toolName;
    const applyBindings = () => {
      try {
        for (const tn of PRIMARY_TOOLS) {
          if (tn !== primary) tg.setToolPassive(tn);
        }
        const isPan = primary === PanTool.toolName;
        const isZoom = primary === ZoomTool.toolName;
        tg.setToolActive(primary, {
          bindings: [
            { mouseButton: MouseBindings.Primary },
            ...(isPan ? [{ mouseButton: MouseBindings.Auxiliary }] : []),
            ...(isZoom ? [{ mouseButton: MouseBindings.Secondary }] : []),
          ],
        });
        if (!isPan) tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
        if (!isZoom) tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
        if (isBrush || isEraser) {
          tg.setToolConfiguration(BrushTool.toolName, {
            activeStrategy: isEraser ? "ERASE_INSIDE_CIRCLE" : "FILL_INSIDE_CIRCLE",
          });
        }
        setPanMode(isPan);
      } catch {
        /* ツールグループ未準備時は無視 */
      }
    };
    if (isBrush || isEraser) {
      // Mask(labelmap) を現在スタックに対し保証してからブラシを有効化。
      void ensureStackSegmentation(viewportIdRef.current, imageIdsRef.current).then(applyBindings);
    } else {
      applyBindings();
    }
  };
  // ブラシ径（px）。
  const setBrushSize = (size: number) => {
    try {
      csToolsUtilities.segmentation.setBrushSizeForToolGroup(`${viewportIdRef.current}-tg`, size);
    } catch {
      /* ignore */
    }
  };
  // この viewport の注釈（計測 ROI）を全消去。
  const clearAnnotations = () => {
    const v = vp();
    try {
      csAnnotation.state.removeAllAnnotations();
      if (v) v.render();
    } catch {
      /* ignore */
    }
  };

  // 画面メニュー/ツールバーからの一括コマンド。最新の実装を ref に保持し、登録は wrapper 経由で常に最新を呼ぶ。
  const commandsRef = useRef<ViewerCommands>({
    fit, reset, rotate90, flipH, flipV, invert: toggleInvert, applyLut, setWindowLevel, resetWindow,
    setActiveTool, setBrushSize, clearAnnotations, undo, redo,
  });
  commandsRef.current = {
    fit, reset, rotate90, flipH, flipV, invert: toggleInvert, applyLut, setWindowLevel, resetWindow,
    setActiveTool, setBrushSize, clearAnnotations, undo, redo,
  };
  useEffect(() => {
    if (!commandKey || compact || syncGroupId) return;
    return registerViewerCommands(commandKey, {
      fit: () => commandsRef.current.fit(),
      reset: () => commandsRef.current.reset(),
      rotate90: () => commandsRef.current.rotate90(),
      flipH: () => commandsRef.current.flipH(),
      flipV: () => commandsRef.current.flipV(),
      invert: () => commandsRef.current.invert(),
      applyLut: (lut) => commandsRef.current.applyLut(lut),
      setWindowLevel: (c, w) => commandsRef.current.setWindowLevel(c, w),
      resetWindow: () => commandsRef.current.resetWindow(),
      setActiveTool: (n) => commandsRef.current.setActiveTool(n),
      setBrushSize: (s) => commandsRef.current.setBrushSize(s),
      clearAnnotations: () => commandsRef.current.clearAnnotations(),
      undo: () => commandsRef.current.undo(),
      redo: () => commandsRef.current.redo(),
    });
  }, [commandKey, compact, syncGroupId]);

  const panned = isPanned(transform);
  // 校正済み画素値の単位: RescaleType(0028,1054) があればそれ（"US"=未指定は除外）、
  // 無ければ CT のみ "HU"、それ以外は単位なし。
  const rt = info?.rescaleType?.trim();
  const calUnit = rt && rt.toUpperCase() !== "US" ? rt : info?.modality === "CT" ? "HU" : "";

  // DICOM 属性テキストオーバーレイ（4 隅、設定可能）。設定 or スライス変化(info)で再解決。
  const overlayCfg = useOverlayConfig();
  const dicomText = useMemo(
    () => (ov.text ? resolveOverlay(overlayCfg, imageIds[imageIndex]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ov.text, overlayCfg, imageIds, imageIndex, info],
  );

  // ビューア状態（必須情報）は画像外の上部ラベルエリアに常時表示する。
  const cursorValue = sample
    ? sample.color
      ? `RGB(${sample.rgb?.[0]},${sample.rgb?.[1]},${sample.rgb?.[2]})`
      : `${Math.round(sample.modalityValue ?? 0)}${calUnit ? " " + calUnit : ""}`
    : "—";
  const cursorXY = sample ? `${sample.fx.toFixed(1)}, ${sample.fy.toFixed(1)}` : "—";

  const imagePanel = (
    <div style={fill ? { ...wrap, flex: 1, height: "auto" } : { ...wrap, height: height ?? 512 }}>
      {/* 深層: ピクセル canvas（Cornerstone3D が内部に canvas を生成） */}
          <div ref={elementRef} style={pixelLayer} />
          {/* Fusion 等のオーバーレイ。base 画像の表示矩形に重ねる（wrap の overflow:hidden でクリップ）。 */}
          {renderOverlay && imageRect && renderOverlay({
            rect: imageRect,
            imageId: imageIds[imageIndex] ?? "",
            index: imageIndex,
            count: imageIds.length,
          })}
          {/* リファレンスライン: 他シリーズの現在スライス面がこのビューと交差する線。 */}
          {referenceLinesEnabled && refSegments.length > 0 && (
            <svg style={refLineSvg}>
              {refSegments.map((s, i) => {
                const mx = (s.x1 + s.x2) / 2;
                const my = (s.y1 + s.y2) / 2;
                return (
                  <g key={i}>
                    <line x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} stroke={s.color} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.9} />
                    {s.label && (
                      <text x={mx + 4} y={my - 4} fill={s.color} fontSize={11} style={refLineText}>
                        {s.label}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
          {/* 患者の向き（A/P・R/L・H/F）。四辺に表示。pointer-events:none。 */}
          {ov.orientation && markers && (
            <>
              <div style={{ ...markerBase, top: 4, left: "50%", transform: "translateX(-50%)" }}>{markers.top}</div>
              <div style={{ ...markerBase, bottom: 4, left: "50%", transform: "translateX(-50%)" }}>{markers.bottom}</div>
              <div style={{ ...markerBase, left: 6, top: "50%", transform: "translateY(-50%)" }}>{markers.left}</div>
              <div style={{ ...markerBase, right: 6, top: "50%", transform: "translateY(-50%)" }}>{markers.right}</div>
            </>
          )}
          {/* スケールバー（Caliper）。校正あり=黄/mm・cm、なし=グレー/px。バー右端隅に単位。 */}
          {ov.caliper && scaleBar && (
            <div style={{ ...scaleWrap, width: scaleBar.lengthPx }}>
              <div style={{ ...scaleLabel, color: scaleBar.calibrated ? CAL_COLOR : UNCAL_COLOR }}>
                {scaleBar.label}
              </div>
              <div style={{ position: "relative", height: 8 }}>
                <div style={{ ...scaleLine, borderBottomColor: scaleBar.calibrated ? CAL_COLOR : UNCAL_COLOR }} />
                <div style={{ ...scaleTickL, background: scaleBar.calibrated ? CAL_COLOR : UNCAL_COLOR }} />
                <div style={{ ...scaleTickR, background: scaleBar.calibrated ? CAL_COLOR : UNCAL_COLOR }} />
              </div>
            </div>
          )}
          {/* DICOM 属性テキスト（4 隅・設定可能）。viewer 状態行(zoom/WL,cursor)の下に重ねる。 */}
          {dicomText && (
            <>
              <CornerText lines={dicomText.topLeft} style={dicomTL} />
              <CornerText lines={dicomText.topRight} style={dicomTR} />
              <CornerText lines={dicomText.bottomLeft} style={dicomBL} />
              <CornerText lines={dicomText.bottomRight} style={dicomBR} />
            </>
          )}
      {loading && !error && <div style={overlayCenter}>{t("common.loading")}</div>}
      {error && <div style={{ ...overlayCenter, color: "#ff8a80" }}>{t("common.fetchError", { error })}</div>}
    </div>
  );

  // LUT ダイアログ（position:fixed でツリー位置に依存しない）
  const lutDialogEl = showLutDialog ? (
    <LutDialog
      currentLutName={activeLutName}
      onSelect={applyLut}
      onClose={() => setShowLutDialog(false)}
    />
  ) : null;

  // カラー(RGB)画像は LUT/Invert を無効化（適用不可・エラー回避）。
  const isColor = isColorImage(info);

  // グリッドセル用: 画像＋オーバーレイのみ。
  if (compact) return <>{imagePanel}{lutDialogEl}</>;

  return (
    <>
    <div style={{
      display: "flex",
      gap: 12,
      alignItems: fill ? "stretch" : "flex-start",
      ...(fill ? { flex: 1, minHeight: 0 } : {}),
    }}>
      <div style={{
        flex: "1 1 auto",
        minWidth: 0,
        ...(fill ? { display: "flex", flexDirection: "column", minHeight: 0 } : {}),
      }}>
        {/* 画像外の状態ラベルエリア（必須情報）。 */}
        <div style={statusBar}>
          <StatusItem label={t("viewer.status.zoom")} value={`${Math.round(transform.zoom * 100)}%`} />
          {panned && <span style={panBadge}>{t("viewer.panned")}</span>}
          <StatusItem label={t("viewer.status.wl")} value={voi ? `${Math.round(voi.wc)}/${Math.round(voi.ww)}` : "—"} />
          <StatusItem label={t("viewer.status.value")} value={cursorValue} />
          <StatusItem label={t("viewer.status.xy")} value={cursorXY} />
          {/* 必須情報ラベル横の Info ボタン（右の情報パネルの On/Off）。 */}
          <button
            onClick={() => setShowInfo((v) => !v)}
            aria-pressed={showInfo}
            title={t("viewer.info.toggle")}
            style={{ ...infoBtn, ...(showInfo ? infoBtnOn : null), marginLeft: "auto" }}
          >
            {t("viewer.info.btn")}
          </button>
        </div>
        {imagePanel}

        {/* 操作バー（canvas の外＝ツール入力と競合しない） */}
        <div style={toolbar}>
          <button onClick={fit} style={btn} title={t("viewer.fit")}>{t("viewer.fit")}</button>
          <button
            onClick={togglePan}
            style={{ ...btn, ...(panMode ? infoBtnOn : null) }}
            aria-pressed={panMode}
            title={t("viewer.pan")}
          >
            ✋
          </button>
          <button onClick={() => zoomBy(1 / 1.2)} style={btn} title={t("viewer.zoomOut")}>−</button>
          <button onClick={() => zoomBy(1.2)} style={btn} title={t("viewer.zoomIn")}>＋</button>
          <button onClick={rotate90} style={btn} title={t("viewer.rotate")}>⟳</button>
          <button onClick={flipH} style={btn} title={t("viewer.flipH")}>⇄</button>
          <button onClick={flipV} style={btn} title={t("viewer.flipV")}>⇅</button>
          <button
            onClick={toggleInvert}
            disabled={isColor}
            style={{ ...btn, ...(inverted ? infoBtnOn : null), ...(isColor ? btnDisabled : null) }}
            title={t("viewer.invert")}
          >
            {t("viewer.invert")}
          </button>
          <button
            onClick={() => setShowLutDialog(true)}
            disabled={isColor}
            style={{ ...btn, ...(activeLutName ? infoBtnOn : null), ...(isColor ? btnDisabled : null) }}
            title={t("viewer.lut")}
          >
            {t("viewer.lut")}
          </button>
          <button onClick={reset} style={btn} title={t("viewer.reset")}>{t("viewer.reset")}</button>
          <span style={{ width: 1, alignSelf: "stretch", background: "#dde4ea", margin: "0 2px" }} />
          <button onClick={undo} disabled={!canUndo} style={btn} title={t("viewer.undo")}>↶</button>
          <button onClick={redo} disabled={!canRedo} style={btn} title={t("viewer.redo")}>↷</button>
        </div>
      </div>

      {/* 右サイド: 輝度/ボクセル/FOV のキャリブレーション情報＋マウス座標＋ライブ WW/WL。
          Off にすると非表示になり、画像パネルがこの領域まで広がる。 */}
      {showInfo && <ImageInfoPanel info={info} sample={sample} voi={voi} />}
    </div>
    {lutDialogEl}
    </>
  );
}

function CornerText({ lines, style }: { lines: string[]; style: React.CSSProperties }) {
  if (!lines.length) return null;
  return (
    <div style={style}>
      {lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}

const dicomBase: React.CSSProperties = {
  position: "absolute",
  display: "flex",
  flexDirection: "column",
  gap: 1,
  color: "#e8eef3",
  fontSize: 12,
  lineHeight: 1.35,
  textShadow: "0 0 3px #000, 0 0 2px #000",
  pointerEvents: "none",
  maxWidth: "46%",
  whiteSpace: "nowrap",
};
const dicomTL: React.CSSProperties = { ...dicomBase, top: 4, left: 6, alignItems: "flex-start", textAlign: "left" };
const dicomTR: React.CSSProperties = { ...dicomBase, top: 4, right: 6, alignItems: "flex-end", textAlign: "right" };
const dicomBL: React.CSSProperties = {
  ...dicomBase,
  bottom: 4,
  left: 6,
  flexDirection: "column-reverse",
  alignItems: "flex-start",
  textAlign: "left",
};
const dicomBR: React.CSSProperties = {
  ...dicomBase,
  bottom: 4,
  right: 6,
  flexDirection: "column-reverse",
  alignItems: "flex-end",
  textAlign: "right",
};

function StatusItem({ label, value }: { label: string; value: string }) {
  return (
    <span style={statusItem}>
      <span style={statusKey}>{label}</span>
      <span style={statusVal}>{value}</span>
    </span>
  );
}

const statusBar: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  flexWrap: "wrap",
  padding: "5px 10px",
  marginBottom: 6,
  background: "#eef2f6",
  border: "1px solid #dde4ea",
  borderRadius: 6,
  fontSize: 12,
  fontVariantNumeric: "tabular-nums",
};
const statusItem: React.CSSProperties = { display: "inline-flex", gap: 5, alignItems: "baseline" };
const infoBtn: React.CSSProperties = {
  padding: "2px 9px",
  border: "1px solid #cdd5de",
  borderRadius: 5,
  background: "#fff",
  color: "#33404d",
  cursor: "pointer",
  fontSize: 12,
};
// border は基底ボタンと同じくショートハンドで指定する（borderColor 単独だと shorthand と混在し
// React の「Removing a style property during rerender (borderColor)」警告が出るため）。
const infoBtnOn: React.CSSProperties = { background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
const btnDisabled: React.CSSProperties = { opacity: 0.45, cursor: "not-allowed" };
const statusKey: React.CSSProperties = { color: "#6b7785" };
const statusVal: React.CSSProperties = { color: "#1a2530", fontWeight: 600 };

const wrap: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: 512,
  background: "#000",
  borderRadius: 6,
  overflow: "hidden",
};
const pixelLayer: React.CSSProperties = { position: "absolute", inset: 0 };
const refLineSvg: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
  overflow: "visible",
};
const refLineText: React.CSSProperties = {
  paintOrder: "stroke",
  stroke: "#000",
  strokeWidth: 2,
  fontVariantNumeric: "tabular-nums",
};
const panBadge: React.CSSProperties = {
  padding: "1px 6px",
  borderRadius: 4,
  background: "#1565c0",
  color: "#fff",
  fontSize: 11,
};
// スケールバー色: 校正あり=黄、校正なし(px)=グレー。
const CAL_COLOR = "#ffeb3b";
const UNCAL_COLOR = "#9e9e9e";
const scaleWrap: React.CSSProperties = {
  position: "absolute",
  left: 12,
  bottom: 12,
  pointerEvents: "none",
};
const scaleLabel: React.CSSProperties = {
  textAlign: "right",
  fontSize: 11,
  fontWeight: 600,
  marginBottom: 2,
  textShadow: "0 0 3px #000",
  fontVariantNumeric: "tabular-nums",
};
const scaleLine: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  borderBottom: "2px solid",
};
const scaleTickL: React.CSSProperties = { position: "absolute", left: 0, bottom: 0, width: 2, height: 8 };
const scaleTickR: React.CSSProperties = { position: "absolute", right: 0, bottom: 0, width: 2, height: 8 };
const markerBase: React.CSSProperties = {
  position: "absolute",
  color: "#ffd54f",
  fontSize: 13,
  fontWeight: 700,
  letterSpacing: 0.5,
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const overlayCenter: React.CSSProperties = {
  position: "absolute",
  top: "50%",
  left: "50%",
  transform: "translate(-50%,-50%)",
  color: "#cfd8dc",
  fontSize: 13,
  pointerEvents: "none",
};
const toolbar: React.CSSProperties = {
  display: "flex",
  flexWrap: "nowrap",
  gap: 6,
  marginTop: 6,
  overflowX: "auto",
  paddingBottom: 2,
};
const btn: React.CSSProperties = {
  flexShrink: 0,
  minWidth: 34,
  padding: "4px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  cursor: "pointer",
  fontSize: 13,
};
