/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RenderingEngine, Enums, EVENTS, metaData, utilities, type Types } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  LengthTool,
  BidirectionalTool,
  AngleTool,
  EllipticalROITool,
  RectangleROITool,
  ProbeTool,
  PlanarFreehandROITool,
  BrushTool,
  annotation as csAnnotation,
  utilities as csToolsUtilities,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { ensureStackSegmentation, disposeViewportSegmentation, noteSegViewport } from "./segmentation";
import { WandTool, commitWand } from "./wandTool";
import { LevelSetTool, commitLevelSet } from "./levelSetsTool";
import { TOOL_IDS } from "./toolIds";
import { ToolIcon } from "../icons/ToolIcon";
import { UI_ICON_FILES, ACTIVE_ICON_STYLE } from "../icons/toolIcons";
import { emitToast } from "./toast";
import { ERASER_TOOL_ID, WAND2D_TOOL_ID, WAND3D_TOOL_ID, LEVELSET2D_TOOL_ID } from "./toolIds";
import { setViewerContext, clearViewerContext, getViewerContext, type ViewerContext } from "./viewerContext";
import { getRoiMaskMeta, setRoiMaskMeta, subscribeRoiMaskStore } from "./roiMaskStore";
import { reconcileGlobalAnnotations } from "./globalRoiSync";
import { loadRoisCached, scheduleRoiSave } from "./roiSaveStore";
import { restoreRoisIntoStack } from "./roiRestore";
import { listSpheres3D, sphereCanvasCircle, subscribeSphere3D, type SphereCanvasCircle } from "./sphere3dStore";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import { applyTransform, isPanned, readTransform, type ViewTransform, FIT_TRANSFORM } from "./transform";
import { readImageInfo, sampleAtCanvas, computeSliceSpacing, calibratedUnit, type ImageInfo, type PixelSample } from "./imageInfo";
import { dicomDateToIso, readColormapName, readInvert, resolveSliceIndex } from "./viewportRead";
import { readModalitySlice } from "./pixelCalibration";
import { autoWindow, rasterizeOverlay, type OverlayWindow } from "./overlayRaster";
import { encodeFrames, framePixelsBase64, hasNonFinite } from "./derivedSeriesEncode";
import { httpSend } from "../http";
import { emitDbChanged } from "../dbEvents";
import { computeOrientationMarkers, type OrientationMarkers } from "./orientation";
import { computeScaleBar, type ScaleBar } from "./scaleBar";
import { getOrCreateCameraSync, getOrCreateVoiSync, getOrCreatePresentationSync, getOrCreateSeriesVoiSync, broadcastSeriesProperties, captureVoiBaseline, clearVoiBaseline } from "./sync";
import { registerReferenceSource, bumpReference, subscribeReference, computeReferenceSegments, type RefSegment } from "./referenceLines";
import {
  registerViewerCommands,
  type ViewerCommands,
  type ViewerDerivedSeriesRequest,
  type ViewerDerivedSeriesResult,
  type ViewerOverlay,
  type ViewerPixelData,
  type ViewerSrRequest,
  type ViewerSrResult,
  type ViewerPixelDataOptions,
  type ViewerRoi,
  type ViewerTargetInfo,
  type ViewerViewState,
} from "./viewerCommands";
import { buildPluginMeta, computeCalipers, hasShapeCalipers, pickPluginMeta, readRoiStats } from "./roiRead";
import { CONTOUR_TOOL_NAMES, contourToolConfig } from "./roiContourTools";
import { subscribeSuvStore, suvForImageId, seriesUidOf } from "./suvStore";
import { resolveOverlay } from "./overlayText";
import { useOverlayConfig } from "./overlayConfig";
import { ImageInfoPanel } from "./ImageInfoPanel";
import { matchesCombo } from "../shortcuts/registry";
import { useI18n } from "../i18n/i18n";
import { LutDialog } from "./LutDialog";
import { fetchLutData, type LutData } from "../api";
import { LoadingSpinner } from "./LoadingSpinner";

type ViewSnapshot = { transform: ViewTransform; voi: { lower: number; upper: number } | null };

const { MouseBindings } = csToolsEnums;

/**
 * 2 本指タッチのバインド（`fw/mobile-ui-design.md` §3.3）。
 *
 * <p>**ZoomTool に割り当てる**のがポイント。ZoomTool は既定で `pinchToZoom: true` かつ `pan: true`
 * なので、2 本指で**ピンチ拡大縮小と平行移動を同時に**扱う（`ZoomTool._pinchCallback`）。
 * PanTool を割り当てると平行移動しかできない。
 *
 * <p>1 本指は Cornerstone が「Primary にバインドされたアクティブツール」へ暗黙フォールバックする
 * （`getActiveToolForTouchEvent`）ので、明示的なバインドは要らない。
 */
const TOUCH_ZOOM_BINDING = { numTouchPoints: 2 } as const;

/** カラー（RGB/YBR/PALETTE）画像か。MONOCHROME 以外を色付きとみなす。LUT/Invert の可否判定に使う。 */
function isColorImage(inf: ImageInfo | null): boolean {
  const p = inf?.photometricInterpretation;
  return !!p && !/MONOCHROME/i.test(p);
}

/**
 * カーソル位置のモダリティ値を表示用に整形する。
 * CT の HU（整数近傍・大きい値）は整数表示、テクスチャマップ等の<b>小さな小数（例 1e-5）は切り捨てず</b>
 * 有効桁で表示、極端に小さい/大きい値は指数表記にする。
 */
function fmtValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e6 || a < 1e-4) return v.toExponential(3); // 例 1.000e-5
  const digits = a >= 100 ? 1 : a >= 1 ? 3 : 6;
  const s = v.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s; // 末尾ゼロを除去
}

// LUT 解除（グレースケール復帰）用の線形グレースケール colormap 名。
// Cornerstone は colormap の明示「解除」手段を公開しないため、これを適用して戻す。
const GRAY_COLORMAP = "graphy-gray";
/** LUT を Cornerstone の colormap として登録するときの名前の接頭辞（`graphy-lut-<LUT 名>`）。 */
const LUT_COLORMAP_PREFIX = "graphy-lut-";

// 計測（ROI）ツール名。setActiveTool で左ドラッグに割り当てる。
const MEASURE_TOOLS = [
  LengthTool.toolName,
  BidirectionalTool.toolName,
  AngleTool.toolName,
  EllipticalROITool.toolName,
  RectangleROITool.toolName,
  ProbeTool.toolName,
  // 輪郭系（ポリゴン/フリーハンド × 閉じる/閉じない）。viewer/roiContourTools.ts
  CONTOUR_TOOL_NAMES.polygon,
  CONTOUR_TOOL_NAMES.polyline,
  CONTOUR_TOOL_NAMES.freehand,
  CONTOUR_TOOL_NAMES.freeLine,
];
// 左ドラッグに割り当て可能なツール一覧（操作＋計測＋ブラシ＋3D Wand＋Level Sets）。
const PRIMARY_TOOLS = [WindowLevelTool.toolName, PanTool.toolName, ZoomTool.toolName, ...MEASURE_TOOLS, BrushTool.toolName, WandTool.toolName, LevelSetTool.toolName];
// 描画/計測/セグメンテーション系ツール（左ドラッグ占有）。これらが有効な間は per-tile の Pan↔W/L 切替を抑止し、
// 先にツールバーで解除するよう促す（グローバルツールが優先＝ナビ切替が黙って効かないのを避ける）。
const BLOCKING_TOOLS = new Set<string>([...MEASURE_TOOLS, BrushTool.toolName, ERASER_TOOL_ID, WAND2D_TOOL_ID, WAND3D_TOOL_ID, LEVELSET2D_TOOL_ID]);

// 単一の RenderingEngine を全ビューポートで共有する（WebGL コンテキストを 1 つに保つ＝省メモリ）。
export const ENGINE_ID = "graphy-engine";
let sharedEngine: RenderingEngine | null = null;
function getEngine(): RenderingEngine {
  if (!sharedEngine) {
    sharedEngine = new RenderingEngine(ENGINE_ID);
  }
  return sharedEngine;
}

/**
 * エンジン単位でまとめて 1 回だけリサイズする（タイルレイアウト変更時の zoom ずれ対策）。
 *
 * <p>問題: `engine.resize()` は共有エンジン上の<b>全</b>ビューポートに対して
 * `resetCameraForResize()` を呼び、各ビューポートの `initialCamera`（＝Fit 基準＝zoom 100% の
 * 基準スケール）を<b>新しいサイズの Fit 値へ差し替える</b>（`keepCamera` で戻るのは
 * parallelScale だけ）。タイルごとの ResizeObserver がそれぞれ `engine.resize()` を呼ぶと、
 * 最初に走ったタイル以外は「すでに新 Fit で再基準化された」相対 zoom を読んでしまい、
 * それを再適用するので絶対スケールが据え置かれ、レイアウト変更のたびに表示倍率が
 * newFit/oldFit 倍ずれる（タイルのアスペクト比が変わると Fit 値が変わるため顕在化する）。
 *
 * <p>対策: リサイズ要求を rAF で 1 回に束ね、<b>engine.resize の前に全ビューポートの
 * ViewPresentation を退避</b>してから、リサイズ後に各ビューポートで再 Fit＋再適用する。
 * これで「どのタイルの ResizeObserver が先に走ったか」に結果が依存しなくなる。
 */
let engineResizeScheduled = false;
function scheduleEngineResize(engine: RenderingEngine): void {
  if (engineResizeScheduled) return;
  engineResizeScheduled = true;
  requestAnimationFrame(() => {
    engineResizeScheduled = false;
    try {
      // ★ engine.resize より前に退避する（この時点の zoom は旧 Fit 基準＝正しい相対値）。
      const snaps: { vp: Types.IStackViewport; pres: ReturnType<Types.IStackViewport["getViewPresentation"]> }[] = [];
      for (const vp of engine.getViewports() as Types.IStackViewport[]) {
        try { snaps.push({ vp, pres: vp.getViewPresentation() }); } catch { /* 未初期化はスキップ */ }
      }
      engine.resize(true, true); // canvas のみ新サイズへ（カメラ維持＝自動再フィットしない）
      for (const { vp, pres } of snaps) {
        try {
          vp.resetCamera(); // 各 viewport を現在の要素サイズへ正しくフィット（＝Fit 基準を更新）
          const fitScale = vp.getCamera().parallelScale ?? 0;
          try { vp.setViewPresentation(pres); } catch { /* 相対 zoom/pan/rotation/flip を再適用 */ }
          // 妥当性ガード: 再適用が異常な巨大/極小スケールを生んだらクリーンなフィットへ戻す。
          // 50倍/1/50 は通常の深いズームを許容しつつ暴走のみ捕捉。
          const afterScale = vp.getCamera().parallelScale ?? 0;
          if (fitScale > 0 && afterScale > 0 && (afterScale > fitScale * 50 || afterScale < fitScale / 50)) {
            vp.resetCamera();
          }
          vp.render();
        } catch { /* 破棄済み viewport は無視 */ }
      }
    } catch { /* エンジン破棄済み等は無視 */ }
  });
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

/** プラグインの値マップの保持形（`ViewerOverlay` ＋ 対象スライスの imageId ＋ 解決済み既定値）。 */
interface PluginOverlayState {
  imageId: string;
  data: Float32Array;
  rows: number;
  cols: number;
  window: OverlayWindow | null;
  colormap: string | null;
  opacity: number;
  label?: string;
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
  showControls = true,
  syncGroupId,
  viewSyncEnabled,
  referenceLinesEnabled,
  referenceLabel,
  commandKey,
  roiContext,
  renderOverlay,
  thickSlab,
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
  /** 画像下の操作バー（ツールボタン列）を表示するか。false で畳んで画像領域を広げる。既定 true。 */
  showControls?: boolean;
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
  /** ROI/Mask 作成時に紐付ける患者・シリーズ・C/T コンテキスト（z は現在 imageIndex を使う）。 */
  roiContext?: Omit<ViewerContext, "z">;
  /** Fusion 等のオーバーレイを base 画像に重ねて描く。base 画像の表示矩形に追従する。 */
  renderOverlay?: RenderOverlay;
  /** ThickSlab（デジタルスライス厚）が有効か。合成スライスは単一 SOP に紐づかないため、
   *  ROI・計測の新規作成/編集ツールをブロックする（本家 Praparat 準拠）。 */
  thickSlab?: boolean;
}) {
  const { t } = useI18n();
  // 合成スライス上でのアノテーション作成をブロックする判定を、setActiveTool から最新参照する。
  const thickSlabRef = useRef(thickSlab);
  thickSlabRef.current = thickSlab;
  const ov = { text: true, caliper: true, orientation: true, ...overlays };
  const elementRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<Types.IStackViewport | null>(null);
  const viewportIdRef = useRef(`graphy-vp-${viewportSeq++}`);
  // 識別子は再レンダで変わるが init を再実行しないよう ref で最新を持つ。
  const imageIdsRef = useRef(imageIds);
  imageIdsRef.current = imageIds;
  const indexRef = useRef(imageIndex);
  indexRef.current = imageIndex;
  const roiContextRef = useRef(roiContext);
  roiContextRef.current = roiContext;
  // 同じスタック(imageIds)なら init を再実行しない。C/T 切替で配列が変わると再 setStack。
  const stackKey = imageIds.join("|");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // スライス送り先の画素がまだ未取得で待ちが発生している間だけ true。体感の一瞬の待ちで
  // 毎回チラつかせないよう、表示は一定時間の遅延読込が続いた場合のみに絞る（下の effect 参照）。
  const [sliceLoading, setSliceLoading] = useState(false);
  const [transform, setTransform] = useState<ViewTransform>(FIT_TRANSFORM);
  const [info, setInfo] = useState<ImageInfo | null>(null);
  const infoRef = useRef<ImageInfo | null>(null);
  const [sample, setSample] = useState<PixelSample | null>(null);
  const [markers, setMarkers] = useState<OrientationMarkers | null>(null);
  const [scaleBar, setScaleBar] = useState<ScaleBar | null>(null);
  // base 画像の表示矩形（renderOverlay 用）。zoom/pan/fit に追従して更新。
  const [imageRect, setImageRect] = useState<ImageRect | null>(null);
  // プラグインの値マップ（H4a）。imageId で束ねて、そのスライスを見ているときだけ描く。
  const [pluginOverlay, setPluginOverlay] = useState<PluginOverlayState | null>(null);
  const pluginOverlayRef = useRef<PluginOverlayState | null>(null);
  pluginOverlayRef.current = pluginOverlay;
  // ⚠ ref ではなく state で持つ: オーバーレイのキャンバスは `imageRect` が確定した後の
  // レンダで初めてマウントされるため、ref にすると「描画 effect が先に走って ref が null →
  // deps が変わらず再実行されない」で**空のキャンバスが乗ったまま**になる（実機検証で踏んだ）。
  // callback ref なら要素のマウントで state が変わり、描画 effect が確実に走る。
  const [overlayCanvas, setOverlayCanvas] = useState<HTMLCanvasElement | null>(null);
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
  // スタック再構築（C/T 切替・ThickSlab の ON/OFF・厚み変更）をまたいで表示状態（zoom/pan/rotation/
  // flip＋VOI）を維持するための退避。setStack はカメラをリセットするため、同一シリーズ幾何
  // （rows/cols/modality 一致）のときだけ再適用する（別シリーズには持ち越さない）。
  const lastViewRef = useRef<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pres: any;
    voi: { lower: number; upper: number } | null;
    rows?: number;
    cols?: number;
    modality?: string;
  } | null>(null);
  // Pan モード: ON で左ドラッグ=パン、OFF で左ドラッグ=W/L。中ドラッグは常にパン、右はズーム。
  const [panMode, setPanMode] = useState(false);
  // 現在このタイルの左ドラッグに割り当てられている論理ツール（グローバルツールバー or per-tile 切替で更新）。
  const activeToolRef = useRef<string>(WindowLevelTool.toolName);
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

  // パラメトリック 3D 球のライブ断面円プレビュー（現在スライス/scope で交差する円）。
  const [sphereCircles, setSphereCircles] = useState<SphereCanvasCircle[]>([]);
  const recomputeSpheresRef = useRef<() => void>(() => {});
  const recomputeSpheres = useCallback(() => {
    const v = viewportRef.current;
    const ctx = roiContextRef.current;
    if (!v || !ctx || compact || syncGroupId) {
      setSphereCircles((prev) => (prev.length ? [] : prev));
      return;
    }
    const out: SphereCanvasCircle[] = [];
    for (const s of listSpheres3D()) {
      if (s.seriesUid && s.seriesUid !== ctx.seriesUid) continue;
      const c = sphereCanvasCircle(v, s, ctx.c, ctx.t);
      if (c) out.push(c);
    }
    setSphereCircles(out);
  }, [compact, syncGroupId]);
  recomputeSpheresRef.current = recomputeSpheres;

  /** 左ドラッグの割り当てを Pan↔W/L で切り替える。 */
  const togglePan = () => {
    // ROI/描画/セグメンテーション系ツールが有効な間は切替を抑止し、先に解除を促す。
    if (BLOCKING_TOOLS.has(activeToolRef.current)) {
      emitToast(t("viewer2d.tool.releaseRoiFirst"));
      return;
    }
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
          // 左=W/L、中=Pan に戻す。2 本指タッチの Zoom バインドは別ツールなので触らない。
          tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
        }
      } catch {
        /* ツールグループ未準備時は無視 */
      }
    }
    activeToolRef.current = next ? PanTool.toolName : WindowLevelTool.toolName;
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
  // 現在適用中の LUT データ（r/g/b を含む全体）。Fusion への LUT 引き継ぎ用に保持。
  const lutDataRef = useRef<LutData | null>(null);

  /** LUT データを Cornerstone3D に登録して適用する。null でグレースケールにリセット。 */
  const applyLut = useCallback((lut: LutData | null) => {
    const vp = viewportRef.current;
    if (!vp) return;
    // カラー(RGB)画像には LUT(カラーマップ)を適用しない。
    if (isColorImage(infoRef.current)) return;
    lutDataRef.current = lut; // Fusion への引き継ぎ用に保持。
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
    const colormapName = `${LUT_COLORMAP_PREFIX}${lut.name}`;
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

  // 現在適用中の LUT データ（Fusion へ引き継ぐため）。
  const getLutData = (): LutData | null => lutDataRef.current;

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
    // フォーカス中タイルを記録（ROI マネージャの「＋新規マスク」対象）。
    const onFocusPointerDown = () => noteSegViewport(viewportIdRef.current, imageIdsRef.current);

    // ROI（計測注釈）作成完了時に、このビューポートの現在コンテキストでメタ（患者・scope）を紐付ける。
    const onAnnotationDone = (evt: Event) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const uid = (evt as any)?.detail?.annotation?.annotationUID as string | undefined;
      const ctx = getViewerContext(viewportIdRef.current);
      if (!uid || !ctx) return;
      const sc = { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: ctx.z, c: ctx.c, t: ctx.t };
      setRoiMaskMeta(uid, { patientKey: ctx.patientKey, seriesLabel: ctx.seriesLabel, scope: sc, origin: sc });
    };

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
      // スタック再構築をまたいで再適用するため、現在の表示状態を退避する。
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const range = (vp.getProperties() as any)?.voiRange ?? null;
        lastViewRef.current = {
          pres: vp.getViewPresentation(),
          voi: range,
          rows: infoRef.current?.rows,
          cols: infoRef.current?.columns,
          modality: infoRef.current?.modality,
        };
      } catch { /* ignore */ }
      // 向きマーカーは IOP があるときだけ。canvasToWorld 経由で zoom/pan/flip/rotation に追従。
      setMarkers(infoRef.current?.hasOrientation ? computeOrientationMarkers(vp, element) : null);
      // スケールバー（Caliper）: 校正の有無で mm/cm・px と色(黄/グレー)を切替。FOV(ズーム)に追従。
      const calibrated = Boolean(infoRef.current?.columnPixelSpacing);
      setScaleBar(computeScaleBar(vp, element, calibrated));
      // Fusion / プラグイン（H4a）のオーバーレイ位置追従。
      if (renderOverlayRef.current || pluginOverlayRef.current) setImageRect(computeImageRect(vp));
      // リファレンスライン: 自分の面変化を他へ通知し、自分の描画も更新（pan/zoom/回転で追従）。
      if (!compact && !syncGroupId) {
        bumpReference();
        recomputeRefLinesRef.current();
        recomputeSpheresRef.current(); // 球プレビューも zoom/pan/回転に追従
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
        // 現在フレームの imageData で確実にフィットさせる（parallelScale と focalPoint を再計算）。
        // マルチフレーム/MOSAIC（例: fMRI の frames/N）では setStack 内部のカメラ設定が
        // 現フレームの実幾何（64×64・origin）と異なる幾何でフィットし、parallelScale が過大（画像が
        // 極小）・focalPoint がズレ（隅寄り）になることがある。しかも誤差が ResizeObserver の暴走ガード
        // （50倍）未満だと setViewPresentation 再適用で保持され、リサイズしても直らない。ここで現フレーム
        // へ明示的に resetCamera し、正しいフィットを土台にする（通常画像は setStack と同一フィットで無害）。
        try { viewport.resetCamera(); } catch { /* ignore */ }

        // スタック再構築（C/T・ThickSlab 切替）前の表示状態を、同一シリーズ幾何なら再適用する。
        // これにより「デフォルトでない表示状態のまま ThickSlab を ON にしても、その状態で表示」される。
        // 上の resetCamera（正しいフィット）を土台に相対ズーム/パン/回転/flip を重ねる（ResizeObserver と同順序）。
        const prevView = lastViewRef.current;
        if (
          prevView &&
          prevView.rows === inf.rows &&
          prevView.cols === inf.columns &&
          prevView.modality === inf.modality
        ) {
          try { viewport.setViewPresentation(prevView.pres); } catch { /* ignore */ }
          if (prevView.voi) {
            try { viewport.setProperties({ voiRange: prevView.voi }); } catch { /* ignore */ }
          }
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
        // フォーカス中タイルを記録（ROI マネージャの「＋新規マスク」対象）。base ビューポートのみ。
        if (!compact) element.addEventListener("pointerdown", onFocusPointerDown);

        const wireTools = (tg: ReturnType<typeof ToolGroupManager.createToolGroup>) => {
          if (!tg) return;
          // 左ドラッグ=WW/WL、中ドラッグ=Pan、右ドラッグ=Zoom（ホイールはスライス送り）。
          if (!tg.hasTool(WindowLevelTool.toolName)) {
            tg.addTool(WindowLevelTool.toolName);
            tg.addTool(PanTool.toolName);
            tg.addTool(ZoomTool.toolName);
            // 計測（ROI）ツールは passive で追加。setActiveTool で左ドラッグに割当。
            for (const tn of MEASURE_TOOLS) {
              // 輪郭系は登録時にしか設定を渡せない（2 度目の addTool は無視される）。
              tg.addTool(tn, contourToolConfig(tn));
              tg.setToolPassive(tn);
            }
            // ImageJ インポートの polygon/freehand ROI 描画用（メニューには出さず passive で追加）。
            tg.addTool(PlanarFreehandROITool.toolName);
            tg.setToolPassive(PlanarFreehandROITool.toolName);
            // ROI ブラシ（セグメンテーション編集）。passive で追加。
            tg.addTool(BrushTool.toolName);
            tg.setToolPassive(BrushTool.toolName);
            // 3D Wand（ワンクリック growCut 領域成長）。passive で追加、setActiveTool で Primary 割当。
            // Wand（対話型リージョングロー: 2D/3D）。passive で追加、setActiveTool で mode 設定＋Primary 割当。
            tg.addTool(WandTool.toolName);
            tg.setToolPassive(WandTool.toolName);
            // Level Sets（対話型・Fast Marching、L1 時点）。passive で追加、setActiveTool で Primary 割当。
            tg.addTool(LevelSetTool.toolName);
            tg.setToolPassive(LevelSetTool.toolName);
            tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
            tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
            // 右クリック=Zoom に加えて、2 本指タッチでピンチ Zoom ＋ Pan（§3.3）。
            tg.setToolActive(ZoomTool.toolName, {
              bindings: [{ mouseButton: MouseBindings.Secondary }, TOUCH_ZOOM_BINDING],
            });
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
          element.addEventListener(csToolsEnums.Events.ANNOTATION_COMPLETED, onAnnotationDone as EventListener);
          onVoiModified();
        }
        onCameraModified();

        // コンポーネント拡縮に追従。再 Fit したうえで相対 zoom/pan/rotation/flip を維持する。
        // 注意: 共有 RenderingEngine では engine.resize(true,false) の自動再フィットが
        // 複数ビューポート時に誤った巨大 parallelScale を返し（黒画面/スケールバー暴走）、
        // さらに get/setViewPresentation で増幅される。これを避けるため、canvas のリサイズは
        // keepCamera=true（自動フィットしない）にし、フィットは viewport 単位の resetCamera で行う。
        // 実サイズが変化したときのみ実行（resize フィードバックループも防止）。
        // 実処理は scheduleEngineResize（エンジン単位で 1 回に束ね、退避→resize→再Fit→再適用）。
        // ★初回フィット補正: seed を 0 にして、ResizeObserver が observe() 時に必ず配送する
        // 「初回通知」で必ず補正フィットを走らせる。enableElement 時にコンテナが未確定サイズ
        // （flex レイアウト途中等）だと canvas が誤アスペクトで作られ画像が縦長等に歪むため、
        // レイアウト確定後の初回通知で canvas を実サイズへ同期＋再フィットして直す。
        // （observe は container を監視。engine.resize は canvas を変えるだけでループしない。）
        let lastRW = 0;
        let lastRH = 0;
        resizeObserver = new ResizeObserver(() => {
          const vp = viewportRef.current;
          if (!vp || disposed) return;
          const w = element.clientWidth;
          const h = element.clientHeight;
          if (!w || !h) return; // 退化サイズ（レイアウト途中）は無視
          if (w === lastRW && h === lastRH) return; // 実サイズ変化なし
          lastRW = w;
          lastRH = h;
          // ★ここで直接 engine.resize しない。タイルごとに呼ぶと 2 番目以降のタイルが
          // 「再基準化済みの zoom」を読んでしまい表示倍率がずれるため、エンジン単位で束ねる。
          scheduleEngineResize(engine);
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
      element.removeEventListener("pointerdown", onFocusPointerDown);
      element.removeEventListener(EVENTS.VOI_MODIFIED, onVoiModified);
      element.removeEventListener("mousemove", onMove);
      element.removeEventListener("mouseleave", onLeave);
      element.removeEventListener(csToolsEnums.Events.ANNOTATION_COMPLETED, onAnnotationDone as EventListener);
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
    let showTimer: number | undefined;
    (async () => {
      try {
        if (v.getCurrentImageIdIndex() !== imageIndex) {
          // 未取得スライスへの移動は WADO 取得を伴い得る。120ms 以上かかった場合だけ
          // スピナーを出し、キャッシュ済みスライスの高速切替ではチラつかせない。
          showTimer = window.setTimeout(() => {
            if (!cancelled) setSliceLoading(true);
          }, 120);
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
          recomputeSpheresRef.current(); // 球断面円もスライス追従
        }
      } catch {
        // スライス切替の競合・例外時はフォールバックとして再フィット＋再描画を試みる
        // （まれに描画が崩れて真っ黒になるのを復帰させる）。
        try {
          const vp = viewportRef.current;
          if (vp && !cancelled) { vp.resetCamera(); vp.render(); }
        } catch { /* ignore */ }
      } finally {
        if (showTimer !== undefined) window.clearTimeout(showTimer);
        if (!cancelled) setSliceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (showTimer !== undefined) window.clearTimeout(showTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageIndex, stackKey]);

  // SUV 校正の変更を購読。校正が付与/解除されたら info を読み直し（suvScale/suvUnit が反映され、
  // カーソル値・ROI 統計・W/L 表示が SUV へ切替）、本家同様に SUV 標準ウィンドウを自動適用する。
  const suvScaleRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const refresh = () => {
      const curId = imageIdsRef.current[indexRef.current];
      if (!curId) return;
      const scale = suvForImageId(curId)?.scale;
      // info を再読込（readImageInfo は suvStore を参照して suvScale/suvUnit を含める）。
      const base = readImageInfo(curId);
      const prev = infoRef.current;
      const merged = { ...base, sliceSpacing: prev?.sliceSpacing, sliceSpacingSource: prev?.sliceSpacingSource };
      infoRef.current = merged;
      setInfo(merged);
      // 校正状態が変化したときだけウィンドウを操作する（ユーザーの手動 W/L を尊重）。
      if (scale !== suvScaleRef.current) {
        if (scale) applySuvWindow(scale);
        else resetWindow();
        suvScaleRef.current = scale;
      }
    };
    // マウント時に既存校正を反映（購読前の初期同期）。
    suvScaleRef.current = suvForImageId(imageIdsRef.current[indexRef.current])?.scale;
    return subscribeSuvStore(refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stackKey]);

  // renderOverlay / プラグインオーバーレイが後から有効化されたとき（Fusion 設定時・
  // プラグイン実行時）に矩形を初期計算する。
  // renderOverlay は親で useCallback 安定化されている前提（毎レンダ別関数だとループするため）。
  useEffect(() => {
    if (!renderOverlay && !pluginOverlay) {
      setImageRect(null);
      return;
    }
    const vp = viewportRef.current;
    if (vp) setImageRect(computeImageRect(vp));
  }, [renderOverlay, pluginOverlay]);

  // スタック（シリーズ・C/T）が変わったらプラグインオーバーレイは破棄する。
  // 別シリーズに他シリーズの計算結果が残るのを防ぐ（imageId 一致だけでは C/T 切替を跨げる）。
  useEffect(() => {
    setPluginOverlay(null);
  }, [stackKey]);

  // 値マップ → RGBA。LUT 名が指定されていれば本体の LUT を取ってきて色付けする。
  useEffect(() => {
    const canvas = overlayCanvas;
    if (!canvas || !pluginOverlay) return;
    let alive = true;
    const draw = (lut: LutData | null) => {
      if (!alive) return;
      canvas.width = pluginOverlay.cols;
      canvas.height = pluginOverlay.rows;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const rgba = rasterizeOverlay(pluginOverlay.data, pluginOverlay.opacity, pluginOverlay.window, lut);
      // createImageData 経由で詰める（new ImageData(rgba, …) は Uint8ClampedArray の
      // ArrayBufferLike と lib.dom の ImageDataArray が噛み合わない）。
      const img = ctx.createImageData(pluginOverlay.cols, pluginOverlay.rows);
      img.data.set(rgba);
      ctx.putImageData(img, 0, 0);
    };
    if (pluginOverlay.colormap) {
      // 取得できなければグレースケールで描く（色が付かないだけで、結果は見える）。
      fetchLutData(pluginOverlay.colormap).then(draw).catch(() => draw(null));
    } else {
      draw(null);
    }
    return () => {
      alive = false;
    };
  }, [pluginOverlay, overlayCanvas]);

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

  // 3D 球プレビュー: ストア変化を購読し、初期化完了・スライス・スタックで再計算。
  useEffect(() => {
    if (compact || syncGroupId) return;
    return subscribeSphere3D(() => recomputeSpheresRef.current());
  }, [compact, syncGroupId]);
  useEffect(() => {
    recomputeSpheres();
  }, [loading, stackKey, imageIndex, recomputeSpheres]);

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
  // 現在の表示 VOI と対象 imageId（W/L 調整ダイアログの初期化用）。
  const getWindowState = (): { imageId: string; center: number; width: number } | null => {
    const v = vp();
    const imageId = imageIdsRef.current[indexRef.current];
    if (!v || !imageId) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const range = (v.getProperties() as any)?.voiRange;
    if (range && Number.isFinite(range.lower) && Number.isFinite(range.upper) && range.upper > range.lower) {
      return { imageId, center: (range.upper + range.lower) / 2, width: range.upper - range.lower };
    }
    // まだ VOI 未確定なら DICOM 既定ウィンドウで代用。
    const inf = infoRef.current;
    if (inf?.windowCenter !== undefined && inf?.windowWidth !== undefined && inf.windowWidth > 0) {
      return { imageId, center: inf.windowCenter, width: inf.windowWidth };
    }
    return { imageId, center: 0, width: 1 };
  };

  // SUV 校正ダイアログ用コンテキスト（表示中スライスの imageId・SeriesUID・モダリティ）。
  const getSuvContext = (): { imageId: string; seriesUid: string; modality: string } | null => {
    const imageId = imageIdsRef.current[indexRef.current];
    if (!imageId) return null;
    const seriesUid = seriesUidOf(imageId);
    if (!seriesUid) return null;
    return { imageId, seriesUid, modality: infoRef.current?.modality ?? "" };
  };

  // スタディの検査日（H6）。**DICOM のメタから読む**（画面の prop を引き回さない）:
  // 出所が 1 つになり、シリーズ/タイル構成が変わっても壊れない。解釈できない値は null。
  const studyDateOf = (imageId: string): string | null => {
    try {
      const m = metaData.get("generalStudyModule", imageId) as { studyDate?: unknown } | undefined;
      return dicomDateToIso(m?.studyDate);
    } catch {
      return null;
    }
  };

  // プラグイン host API（fw/plugin-architecture.md §7）の H1: いま何を表示しているか。
  // 対象の識別は tileId（=commandKey）側が持つので、ここではその中身だけを返す。
  const getTargetInfo = (): ViewerTargetInfo | null => {
    const imageId = imageIdsRef.current[indexRef.current];
    const ctx = roiContextRef.current;
    if (!imageId || !ctx) return null;
    return {
      patientKey: ctx.patientKey,
      studyUid: ctx.studyUid,
      studyDate: studyDateOf(imageId),
      seriesUid: ctx.seriesUid,
      seriesLabel: ctx.seriesLabel,
      imageId,
      sliceIndex: indexRef.current,
      sliceCount: imageIdsRef.current.length,
      c: ctx.c,
      t: ctx.t,
      modality: infoRef.current?.modality ?? "",
    };
  };

  // colormap の内部登録名 → 公開する LUT 名。`graphy-lut-` は本体の実装詳細なので剥がす
  // （シリーズ Sync で他タイルから伝播した colormap も同じ規則の名前で来る）。
  const lutNameForPlugins = (colormapName: string | null): string | null =>
    colormapName?.startsWith(LUT_COLORMAP_PREFIX)
      ? colormapName.slice(LUT_COLORMAP_PREFIX.length)
      : colormapName;

  // H2: いまの表示状態。W/L は getWindowState と同じ「voiRange → 無ければ DICOM 既定」で解決する。
  const getViewState = (): ViewerViewState | null => {
    const v = vp();
    if (!v) return null;
    const w = getWindowState();
    const tr = readTransform(v);
    return {
      windowCenter: w?.center ?? 0,
      windowWidth: w?.width ?? 1,
      unit: calibratedUnit(infoRef.current),
      // 内部のグレースケール colormap は「LUT 未適用」として畳み、LUT は
      // 内部の登録名ではなく**ユーザーが選んだ LUT 名**（"10_Percent" 等）で返す。
      colormap: lutNameForPlugins(readColormapName(v, GRAY_COLORMAP)),
      invert: readInvert(v),
      flipH: tr.flipHorizontal,
      flipV: tr.flipVertical,
      rotation: tr.rotation,
      zoom: tr.zoom,
      pan: tr.pan,
    };
  };

  // H4a: プラグインの値マップを表示中スライスへ重ねる。
  // 「どのスライスに対する結果か」を imageId で束ねる: スライスを送ると隠れ、戻ると再表示される
  // （送った先の画像に他スライスの計算結果が重なって見えるのが最悪なので、そこを構造で防ぐ）。
  const showOverlay = (o: ViewerOverlay): boolean => {
    const imageId = imageIdsRef.current[indexRef.current];
    const inf = infoRef.current;
    if (!imageId || !o?.data || !(o.rows > 0) || !(o.cols > 0)) return false;
    if (o.data.length !== o.rows * o.cols) return false;
    // 現在スライスの格子と一致しないマップは拒否する（勝手に伸縮すると座標の意味が壊れる）。
    if (inf?.rows !== undefined && inf?.columns !== undefined && (inf.rows !== o.rows || inf.columns !== o.cols)) {
      return false;
    }
    setPluginOverlay({
      imageId,
      data: o.data,
      rows: o.rows,
      cols: o.cols,
      window: o.window ?? autoWindow(o.data),
      colormap: o.colormap ?? null,
      opacity: o.opacity ?? 0.5,
      label: o.label,
    });
    return true;
  };
  const clearOverlay = () => setPluginOverlay(null);

  // H4b: 処理結果を派生シリーズとして保存する。**同意は画面側で取ってから来る**。
  // 幾何（IPP/IOP/PixelSpacing/厚み）はプラグインに書かせず、元シリーズから引き継ぐ
  // （座標を組ませると実空間の意味が壊れた派生シリーズを保管庫に作れてしまう）。
  // 保存要求の検証。**同意を求める前に**画面側がこれを呼ぶ（通らない要求で
  // ユーザーに確認ダイアログを見せないため）。saveDerivedSeries でも再度通す（多重防御）。
  const validateDerivedSeries = (req: ViewerDerivedSeriesRequest): string | null => {
    const ctx = roiContextRef.current;
    const ids = imageIdsRef.current;
    if (!ctx) return "no series context";
    if (!req?.frames?.length) return "frames is empty";
    if (!(req.rows > 0) || !(req.cols > 0)) return "rows/cols is invalid";
    const inf = infoRef.current;
    // 元スライスと同じ格子でなければ拒否（幾何を引き継ぐ前提が崩れる）。
    if (inf?.rows !== undefined && inf?.columns !== undefined && (inf.rows !== req.rows || inf.columns !== req.cols)) {
      return `rows/cols must match the source slice (${inf.rows}x${inf.columns})`;
    }
    for (const f of req.frames) {
      if (resolveSliceIndex(f.sliceIndex, indexRef.current, ids.length) === null) {
        return `sliceIndex out of range: ${f.sliceIndex}`;
      }
      if (f.data?.length !== req.rows * req.cols) {
        return "data length must be rows*cols";
      }
    }
    // NaN（データ無し）を含むなら背景値の明示が必須。既定を持たせない理由は
    // ViewerDerivedSeriesRequest.background の doc を参照（閾値マスクで背景が閾値に化ける事故）。
    if (req.background === undefined && hasNonFinite(req.frames.map((f) => f.data))) {
      return "frames contain NaN; specify `background` (the value to store where there is no data)";
    }
    if (req.background !== undefined && !Number.isFinite(req.background)) {
      return "background must be a finite number";
    }
    return null;
  };

  const saveDerivedSeries = async (
    req: ViewerDerivedSeriesRequest,
    producer: { id: string; name: string; version: string },
  ): Promise<ViewerDerivedSeriesResult> => {
    const ctx = roiContextRef.current;
    const ids = imageIdsRef.current;
    const invalid = validateDerivedSeries(req);
    if (invalid || !ctx) return { ok: false, error: invalid ?? "no series context" };
    const inf = infoRef.current;
    // 面内間隔・向きは元スライスの imagePlaneModule から。IOP が無いシリーズ（動画等）は
    // 幾何なしで保存する（backend が IOP/IPP/FrameOfReference を書かない＝空間登録を偽装しない）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plane = (id: string): any => metaData.get("imagePlaneModule", id);
    const p0 = plane(ids[req.frames[0].sliceIndex]);
    const rowCos = p0?.rowCosines as number[] | undefined;
    const colCos = p0?.columnCosines as number[] | undefined;
    const iop = rowCos && colCos ? [...rowCos, ...colCos] : [];
    const pixelSpacing = [
      inf?.rowPixelSpacing ?? p0?.rowPixelSpacing ?? 1,
      inf?.columnPixelSpacing ?? p0?.columnPixelSpacing ?? 1,
    ];
    const encoded = encodeFrames(req.frames.map((f) => f.data), req.background);
    const frames = req.frames.map((f, k) => ({
      instanceNumber: k + 1,
      imagePositionPatient: (plane(ids[f.sliceIndex])?.imagePositionPatient as number[] | undefined) ?? null,
      pixels: framePixelsBase64(encoded.frames[k]),
    }));
    try {
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUids: string[] }>(
        "/api/series/derived",
        "POST",
        {
          studyInstanceUid: ctx.studyUid,
          seriesInstanceUid: ctx.seriesUid,
          seriesDescription: req.seriesDescription,
          seriesNumber: null,
          rows: req.rows,
          columns: req.cols,
          pixelSpacing,
          sliceThickness: inf?.sliceThickness ?? inf?.sliceSpacing ?? 1,
          spacingBetweenSlices: inf?.sliceSpacing ?? inf?.sliceThickness ?? 1,
          imageOrientationPatient: iop,
          derivationDescription: req.derivationDescription ?? null,
          // 量子化した場合は係数を渡す（backend 既定は恒等）。
          rescaleSlope: encoded.slope,
          rescaleIntercept: encoded.intercept,
          rescaleType: req.unit ?? null,
          // 背景（NaN 埋め）は DICOM のパディング値として明示する。
          pixelPaddingValue: encoded.paddingStored,
          producer,
          frames,
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [ctx.studyUid] });
      return {
        ok: true,
        seriesInstanceUid: res.seriesInstanceUid,
        instanceCount: res.sopInstanceUids.length,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };

  /**
   * H9: 計測レポート（DICOM SR）として保存する。
   *
   * <p>**DICOM はここでは組み立てない**（backend が作る）。フロントがやるのは
   * 「どのスタディに付けるか」の解決と、シリーズ UID が欠けている計測グループの補完。
   * ROI は表示中シリーズのものなので、プラグインが series/sop を省略しても本体が埋められる。
   */
  const saveStructuredReport = async (
    req: ViewerSrRequest,
    producer: { id: string; name: string; version: string },
  ): Promise<ViewerSrResult> => {
    const ctx = roiContextRef.current;
    if (!ctx) return { ok: false, error: "no series context" };
    if ((req.groups?.length ?? 0) === 0 && (req.findings?.length ?? 0) === 0) {
      return { ok: false, error: "groups か findings のどちらかが必要です" };
    }
    try {
      const res = await httpSend<{ seriesInstanceUid: string; sopInstanceUid: string }>(
        "/api/sr/measurement-report",
        "POST",
        {
          studyInstanceUid: ctx.studyUid,
          seriesDescription: req.seriesDescription ?? "Measurement Report",
          documentTitle: req.documentTitle ?? null,
          observerName: req.observerName ?? null,
          groups: (req.groups ?? []).map((g) => ({
            trackingId: g.trackingId,
            trackingUid: g.trackingUid ?? null,
            findingText: g.findingText ?? null,
            // 省略時は表示中シリーズ。**別シリーズの UID を勝手に補わない**
            // （SOP が無いときは画像参照なしの計測グループになる）。
            seriesInstanceUid: g.seriesInstanceUid ?? ctx.seriesUid,
            sopInstanceUid: g.sopInstanceUid ?? null,
            measurements: g.measurements.map((m) => ({
              type: m.type,
              value: m.value,
              unit: m.unit ?? "mm",
            })),
          })),
          findings: req.findings ?? [],
          producer,
        },
      );
      emitDbChanged({ reason: "series-create", studyUids: [ctx.studyUid] });
      return { ok: true, seriesInstanceUid: res.seriesInstanceUid, sopInstanceUid: res.sopInstanceUid };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  };

  // H3: スライス 1 枚の校正済み画素。**読み出しは pixelCalibration に委譲する**
  // （getPixelData() へ直接 slope/intercept を掛けると preScale と二重適用になり CT が
  // 約 −1024 ずれる既知事故。校正の単一入口を必ず通す＝CLAUDE.md のルール 2）。
  const getPixelData = async (opts?: ViewerPixelDataOptions): Promise<ViewerPixelData | null> => {
    const ids = imageIdsRef.current;
    const index = resolveSliceIndex(opts?.sliceIndex, indexRef.current, ids.length);
    if (index === null) return null;
    const imageId = ids[index];
    if (!imageId) return null;
    const slice = await readModalitySlice(imageId);
    if (!slice) return null;
    // 幾何は表示中スライスの ImageInfo から。要求スライスが別でも面内間隔は同一シリーズで共通、
    // スライス間隔もシリーズ単位の値なので流用できる（非等間隔シリーズは sliceSpacing の
    // 導出元 sliceSpacingSource を参照する運用＝ImageInfoPanel と同じ扱い）。
    const inf = index === indexRef.current ? infoRef.current : readImageInfo(imageId);
    return {
      imageId,
      sliceIndex: index,
      rows: slice.height,
      cols: slice.width,
      data: slice.values,
      unit: slice.unit,
      spacing: [
        inf?.columnPixelSpacing ?? null,
        inf?.rowPixelSpacing ?? null,
        infoRef.current?.sliceSpacing ?? null,
      ],
      // **間隔で代用しない**（sliceSpacing は IPP 差や SpacingBetweenSlices から導出するため
      // ギャップのある収集で厚さと一致しない）。無ければ null を渡し、
      // 「厚さが分からない」ことをプラグイン側が判断できるようにする。
      sliceThickness: inf?.sliceThickness ?? null,
    };
  };

  // H5: このタイルが表示中のスタックに乗っている ROI（計測・幾何注釈）。
  // **幾何の算出は roiRead に委譲する**（長径・短径をプラグイン側に書かせると本体の計測値と
  // ずれたときどちらが正しいか言えなくなる＝計測の単一入口。CLAUDE.md のルール 3 と同趣旨）。
  const getRois = (): ViewerRoi[] => {
    const ctx = roiContextRef.current;
    const ids = imageIdsRef.current;
    if (!ctx || !ids.length) return [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let all: any[];
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      all = csAnnotation.state.getAllAnnotations() as any[];
    } catch {
      return [];
    }
    const out: ViewerRoi[] = [];
    for (const a of all) {
      const uid = a?.annotationUID as string | undefined;
      const refId = a?.metadata?.referencedImageId as string | undefined;
      if (!uid || !refId) continue;
      // このタイルが表示中のスタックに乗っていない ROI（別シリーズ・別 c/t）は出さない。
      const sliceIndex = ids.indexOf(refId);
      if (sliceIndex < 0) continue;
      const world = (a.data?.contour?.polyline ?? a.data?.handles?.points ?? []) as number[][];
      if (!world.length) continue;
      const points: Array<[number, number]> = [];
      for (const w of world) {
        try {
          const ic = utilities.worldToImageCoords(refId, w as Types.Point3) as [number, number] | undefined;
          if (ic && Number.isFinite(ic[0]) && Number.isFinite(ic[1])) points.push([ic[0], ic[1]]);
        } catch {
          /* 変換できない頂点は落とす（幾何が無いシリーズなど） */
        }
      }
      if (!points.length) continue;
      // 面内間隔は ROI が乗っているスライスの ImageInfo から（表示中スライスなら使い回す）。
      const inf = sliceIndex === indexRef.current ? infoRef.current : readImageInfo(refId);
      const sx = inf?.columnPixelSpacing ?? null;
      const sy = inf?.rowPixelSpacing ?? null;
      const stats = readRoiStats(a.data?.cachedStats, refId);
      const tool = (a.metadata?.toolName as string) ?? "";
      // 形状ベースの長径・短径は「輪郭として意味づけられるツール」だけに出す
      // （Bidirectional の 4 ハンドルの最遠距離はユーザーが引いた長軸より長くなり得る）。
      const cal = hasShapeCalipers(tool) ? computeCalipers(points, sx, sy) : null;
      // ツール値の length / shortAxis は **mm のときだけ**出す。画素間隔が無いシリーズでは
      // Cornerstone が px で計算するため、そのまま mm として渡すと単位が壊れる。
      const toolMm = stats.lengthUnit === undefined || stats.lengthUnit === "mm";
      const meta = getRoiMaskMeta(uid);
      const sop = (metaData.get("sopCommonModule", refId) as { sopInstanceUID?: string } | undefined)
        ?.sopInstanceUID;
      let visible = true;
      try {
        visible = csAnnotation.visibility.isAnnotationVisible(uid) ?? true;
      } catch {
        /* 既定 true */
      }
      out.push({
        roiUid: uid,
        tool,
        label: meta?.label ?? null,
        patientKey: ctx.patientKey,
        studyUid: ctx.studyUid,
        studyDate: studyDateOf(refId),
        seriesUid: ctx.seriesUid,
        sopInstanceUid: sop ?? null,
        sliceIndex,
        zScope: meta?.scope?.z ?? null,
        c: ctx.c,
        t: ctx.t,
        points,
        spacing: [sx, sy],
        measurements: {
          length: toolMm ? stats.length : undefined,
          shortAxis: toolMm ? stats.width : undefined,
          longAxisMm: cal?.longAxisMm,
          shortAxisMm: cal?.shortAxisMm,
          longAxisEnds: cal?.longAxisEnds as [[number, number], [number, number]] | undefined,
          area: stats.area,
          mean: stats.mean,
          stdDev: stats.stdDev,
          min: stats.min,
          max: stats.max,
          unit: stats.unit,
        },
        visible,
      });
    }
    // プラグインが安定した順序を前提にできるよう、スライス→UID で並べる
    // （Cornerstone の列挙順はツール登録順に依存し、契約として保証できない）。
    out.sort((p, q) => (p.sliceIndex - q.sliceIndex) || (p.roiUid < q.roiUid ? -1 : p.roiUid > q.roiUid ? 1 : 0));
    return out;
  };

  // H5: ROI に紐付くプラグイン属性。名前空間の付与/剥がしは roiRead の純関数へ委譲する
  // （プラグインが本体や他プラグインのキーを踏めないようにするのは host の責任なので、
  // その規則はテストで固定してある＝`roiRead.test.ts`）。
  const getRoiMeta = (roiUid: string, pluginId: string): Record<string, string> =>
    pickPluginMeta(getRoiMaskMeta(roiUid)?.custom, pluginId);

  const setRoiMeta = (roiUid: string, pluginId: string, patch: Record<string, string>): boolean => {
    try {
      if (!csAnnotation.state.getAnnotation(roiUid)) return false;
    } catch {
      return false;
    }
    setRoiMaskMeta(roiUid, { custom: buildPluginMeta(pluginId, patch) });
    return true;
  };

  // SUV 化時に臨床標準ウィンドウ（SUV 0〜7）を適用する。voiRange はモダリティ値(Bq/mL)空間のため
  // SUV=modalityValue×scale の逆算で modalityValue [0, 7/scale] を設定する（本家 setSUVFactor 準拠）。
  const applySuvWindow = (scale: number) => {
    const v = vp();
    if (!v || !(scale > 0)) return;
    const upper = 7 / scale;
    try {
      v.setProperties({ voiRange: { lower: 0, upper } });
      v.render();
      setVoi({ ww: upper, wc: upper / 2 });
    } catch {
      /* ignore */
    }
  };

  // 操作/計測/ブラシツールの切替（左ドラッグ割当）。中=Pan・右=Zoom はナビ用に常時維持。
  // ブラシ/消しゴムは BrushTool に集約（消しゴム=ERASE ストラテジ）。選択時に labelmap を保証。
  const setActiveTool = (toolName: string) => {
    const tg = ToolGroupManager.getToolGroup(`${viewportIdRef.current}-tg`);
    if (!tg) return;
    const isBrush = toolName === BrushTool.toolName;
    const isEraser = toolName === ERASER_TOOL_ID;
    const isWand2d = toolName === WAND2D_TOOL_ID;
    const isWand3d = toolName === WAND3D_TOOL_ID;
    const isWand = isWand2d || isWand3d;
    const isLevelSet = toolName === LEVELSET2D_TOOL_ID;
    // ThickSlab（合成スライス）有効中は ROI・計測・ブラシ・Wand・Level Sets の作成/編集をブロックする。
    // 合成画像は単一の実スライス(SOP)に一意対応せず、描いた注釈を安全に保存できないため。
    const isAnnotationTool = MEASURE_TOOLS.includes(toolName) || isBrush || isEraser || isWand || isLevelSet;
    if (thickSlabRef.current && isAnnotationTool) {
      emitToast(t("series.thickSlab.roiBlocked"));
      return;
    }
    const primary = isEraser ? BrushTool.toolName : isWand ? WandTool.toolName : isLevelSet ? LevelSetTool.toolName : toolName;
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
            // Zoom を選んでいるときも 2 本指はここ（＝Zoom）に来るので二重登録しない。
            ...(isZoom ? [{ mouseButton: MouseBindings.Secondary }, TOUCH_ZOOM_BINDING] : []),
          ],
        });
        if (!isPan) tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
        if (!isZoom) {
          tg.setToolActive(ZoomTool.toolName, {
            bindings: [{ mouseButton: MouseBindings.Secondary }, TOUCH_ZOOM_BINDING],
          });
        }
        if (isBrush || isEraser) {
          tg.setToolConfiguration(BrushTool.toolName, {
            activeStrategy: isEraser ? "ERASE_INSIDE_CIRCLE" : "FILL_INSIDE_CIRCLE",
          });
        }
        if (isWand) {
          tg.setToolConfiguration(WandTool.toolName, { mode: isWand3d ? "3d" : "2d" }, true);
        }
        setPanMode(isPan);
      } catch {
        /* ツールグループ未準備時は無視 */
      }
    };
    // 3D Wand は規則的ボリュームでないシリーズでは動かない（source を volume 走査できない）。UI で弾く。
    if (isWand3d && !utilities.isValidVolume(imageIdsRef.current)) {
      emitToast(t("viewer2d.tool.needVolume"));
      return;
    }
    // Wand/Level Sets 以外のツールへ切り替えるときは、開いているセッションを確定して閉じる。
    if (!isWand) commitWand();
    if (!isLevelSet) commitLevelSet();
    activeToolRef.current = toolName; // per-tile Pan↔W/L 切替の抑止判定に使う。
    if (isBrush || isEraser || isWand || isLevelSet) {
      // Mask(labelmap) を現在スタックに対し保証してからブラシ/Wand/Level Sets を有効化。
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
  // Wand のトレランスは Wand ダイアログ（seed 記憶＋動的 Update）へ移行したため、これは互換用の no-op。
  const setWandTolerance = (_tol: number) => {
    try {
      void _tol;
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
    // 保存を**明示的に**予約する。`removeAllAnnotations()` は個々の ANNOTATION_REMOVED を
    // 発火しないため、イベント購読だけに任せると全消去が保存されない（実機検証で判明）。
    const pk = roiContextRef.current?.patientKey;
    if (pk) scheduleRoiSave(pk);
  };

  // 画面メニュー/ツールバーからの一括コマンド。最新の実装を ref に保持し、登録は wrapper 経由で常に最新を呼ぶ。
  const commandsRef = useRef<ViewerCommands>({
    fit, reset, rotate90, flipH, flipV, invert: toggleInvert, applyLut, getLutData, setWindowLevel, resetWindow,
    getWindowState, getSuvContext, getTargetInfo, getViewState, getPixelData, showOverlay, clearOverlay,
    validateDerivedSeries, saveDerivedSeries, saveStructuredReport, setActiveTool, setBrushSize, setWandTolerance,
    getRois, getRoiMeta, setRoiMeta, clearAnnotations,
    undo, redo,
  });
  commandsRef.current = {
    fit, reset, rotate90, flipH, flipV, invert: toggleInvert, applyLut, getLutData, setWindowLevel, resetWindow,
    getWindowState, getSuvContext, getTargetInfo, getViewState, getPixelData, showOverlay, clearOverlay,
    validateDerivedSeries, saveDerivedSeries, saveStructuredReport, setActiveTool, setBrushSize, setWandTolerance,
    getRois, getRoiMeta, setRoiMeta, clearAnnotations,
    undo, redo,
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
      getLutData: () => commandsRef.current.getLutData(),
      setWindowLevel: (c, w) => commandsRef.current.setWindowLevel(c, w),
      resetWindow: () => commandsRef.current.resetWindow(),
      getWindowState: () => commandsRef.current.getWindowState(),
      getSuvContext: () => commandsRef.current.getSuvContext(),
      getTargetInfo: () => commandsRef.current.getTargetInfo(),
      getViewState: () => commandsRef.current.getViewState(),
      getPixelData: (o) => commandsRef.current.getPixelData(o),
      showOverlay: (o) => commandsRef.current.showOverlay(o),
      clearOverlay: () => commandsRef.current.clearOverlay(),
      validateDerivedSeries: (r) => commandsRef.current.validateDerivedSeries(r),
      saveDerivedSeries: (r, p) => commandsRef.current.saveDerivedSeries(r, p),
      saveStructuredReport: (r, p) => commandsRef.current.saveStructuredReport(r, p),
      setActiveTool: (n) => commandsRef.current.setActiveTool(n),
      setBrushSize: (s) => commandsRef.current.setBrushSize(s),
      setWandTolerance: (v) => commandsRef.current.setWandTolerance(v),
      getRois: () => commandsRef.current.getRois(),
      getRoiMeta: (u, p) => commandsRef.current.getRoiMeta(u, p),
      setRoiMeta: (u, p, patch) => commandsRef.current.setRoiMeta(u, p, patch),
      clearAnnotations: () => commandsRef.current.clearAnnotations(),
      undo: () => commandsRef.current.undo(),
      redo: () => commandsRef.current.redo(),
    });
  }, [commandKey, compact, syncGroupId]);

  // ROI/Mask 作成時に紐付ける現在コンテキスト（患者・シリーズ・現在 ZCT）をレジストリへ。
  useEffect(() => {
    if (compact || syncGroupId || !roiContext) return;
    const id = viewportIdRef.current;
    setViewerContext(id, { ...roiContext, z: imageIndex });
    return () => clearViewerContext(id);
  }, [roiContext, imageIndex, compact, syncGroupId]);

  // global ROI（scope に "all" を含む）を現在スライス/チャンネルへ追従描画させる。
  // 最新値は ref から読むため依存なしで安定（slice 変更・store 変更の両方から呼ぶ）。
  const reconcileGlobalRois = useCallback(() => {
    if (compact || syncGroupId) return;
    const ctx = roiContextRef.current;
    if (!ctx) return;
    reconcileGlobalAnnotations(
      { viewportId: viewportIdRef.current, seriesUid: ctx.seriesUid, c: ctx.c, t: ctx.t },
      imageIdsRef.current,
      indexRef.current,
    );
  }, [compact, syncGroupId]);

  // scope 編集（ダイアログ/トグル）で store が変わったら追従を再評価。
  useEffect(() => {
    if (compact || syncGroupId || !roiContext) return;
    return subscribeRoiMaskStore(reconcileGlobalRois);
  }, [reconcileGlobalRois, compact, syncGroupId, roiContext]);

  // スライス送り/スタック切替（C/T）・マウント時に global ROI の追従を反映。
  useEffect(() => {
    reconcileGlobalRois();
  }, [imageIndex, stackKey, reconcileGlobalRois]);

  // 保存済み ROI の復元（`fw/roi-manager-design.md` M5）。
  // スタックが確定したタイミングで、**このスタックに属する ROI だけ**を戻す
  // （SOP が一致しないものは別シリーズなので載せない＝座標の意味を壊さない）。
  useEffect(() => {
    if (compact || syncGroupId) return;
    const patientKey = roiContext?.patientKey;
    const seriesLabel = roiContext?.seriesLabel;
    if (!patientKey || !imageIds.length) return;
    let cancelled = false;
    void loadRoisCached(patientKey).then((parsed) => {
      if (cancelled || !parsed.rois.length) return;
      const v = vp();
      if (!v) return;
      const n = restoreRoisIntoStack(parsed.rois, imageIdsRef.current, v, patientKey, seriesLabel);
      if (n > 0) {
        try {
          csToolsUtilities.triggerAnnotationRenderForViewportIds([viewportIdRef.current]);
        } catch {
          /* 破棄途中は無視 */
        }
        // 復元した ROI にも global 追従の評価を通す（scope="all" が保存されていた場合）。
        reconcileGlobalRois();
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roiContext?.patientKey, stackKey, imageIds.length, compact, syncGroupId]);

  const panned = isPanned(transform);
  // 校正済み画素値の単位（プラグインの getViewState().unit と同じ解決）。
  const calUnit = calibratedUnit(info);

  // DICOM 属性テキストオーバーレイ（4 隅、設定可能）。設定 or スライス変化(info)で再解決。
  const overlayCfg = useOverlayConfig();
  const dicomText = useMemo(
    () => (ov.text ? resolveOverlay(overlayCfg, imageIds[imageIndex]) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ov.text, overlayCfg, imageIds, imageIndex, info],
  );

  // SUV 校正済み(PET)なら SUV 値・単位・W/L を SUV 空間で表示する（本家準拠）。
  const suvScale = info?.suvScale;
  const suvUnit = info?.suvUnit ?? "SUV";
  // ビューア状態（必須情報）は画像外の上部ラベルエリアに常時表示する。
  const cursorValue = sample
    ? sample.color
      ? `RGB(${sample.rgb?.[0]},${sample.rgb?.[1]},${sample.rgb?.[2]})`
      : sample.suvValue !== undefined
        ? `${sample.suvValue.toFixed(2)} ${suvUnit}`
        : `${fmtValue(sample.modalityValue ?? 0)}${calUnit ? " " + calUnit : ""}`
    : "—";
  const cursorXY = sample ? `${sample.fx.toFixed(1)}, ${sample.fy.toFixed(1)}` : "—";

  const imagePanel = (
    // data-graphy-image-panel: 画像キャンバス領域の目印。タイル枠の右クリックメニューは
    // この内側では開かず、cornerstone の右ドラッグ Zoom を優先させる（Viewer2DScreen 参照）。
    <div data-graphy-image-panel style={fill ? { ...wrap, flex: 1, height: "auto" } : { ...wrap, height: height ?? 512 }}>
      {/* 深層: ピクセル canvas（Cornerstone3D が内部に canvas を生成） */}
          <div ref={elementRef} data-testid="viewer2d-canvas-host" style={pixelLayer} />
          {/* プラグインの値マップ（H4a）。base 画像の表示矩形に重ね、対象スライスのときだけ出す。
              出所が分かるようにラベルを添える（プラグインの出力を本体の描画と混同させない）。 */}
          {pluginOverlay && imageRect && pluginOverlay.imageId === imageIds[imageIndex] && (
            <>
              <canvas
                ref={setOverlayCanvas}
                data-testid="plugin-overlay-canvas"
                style={{
                  position: "absolute",
                  left: imageRect.left,
                  top: imageRect.top,
                  width: imageRect.width,
                  height: imageRect.height,
                  pointerEvents: "none",
                }}
              />
              <div data-testid="plugin-overlay-label" style={pluginOverlayLabel}>
                {t("viewer2d.plugin.overlayLabel", { name: pluginOverlay.label ?? "plugin" })}
              </div>
            </>
          )}
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
          {/* パラメトリック 3D 球のライブ断面円プレビュー。 */}
          {sphereCircles.length > 0 && (
            <svg style={refLineSvg}>
              {sphereCircles.map((c, i) => (
                <g key={i}>
                  <circle cx={c.cx} cy={c.cy} r={c.r} fill="none" stroke={c.color} strokeWidth={1.5} strokeDasharray="4 3" opacity={0.9} />
                  <circle cx={c.cx} cy={c.cy} r={1.5} fill={c.color} />
                  {c.label && <text x={c.cx + c.r + 4} y={c.cy} fill={c.color} fontSize={11} style={refLineText}>{c.label}</text>}
                </g>
              ))}
            </svg>
          )}
          {/* 患者の向き（A/P・R/L・H/F）。四辺に表示。pointer-events:none。 */}
          {ov.orientation && markers && (
            <>
              <div data-testid="orientation-marker-top" style={{ ...markerBase, top: 4, left: "50%", transform: "translateX(-50%)" }}>{markers.top}</div>
              <div data-testid="orientation-marker-bottom" style={{ ...markerBase, bottom: 4, left: "50%", transform: "translateX(-50%)" }}>{markers.bottom}</div>
              <div data-testid="orientation-marker-left" style={{ ...markerBase, left: 6, top: "50%", transform: "translateY(-50%)" }}>{markers.left}</div>
              <div data-testid="orientation-marker-right" style={{ ...markerBase, right: 6, top: "50%", transform: "translateY(-50%)" }}>{markers.right}</div>
            </>
          )}
          {/* スケールバー（Caliper）。校正あり=黄/mm・cm、なし=グレー/px。バー右端隅に単位。 */}
          {ov.caliper && scaleBar && (
            <div data-testid="scale-bar" style={{ ...scaleWrap, width: scaleBar.lengthPx }}>
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
              <CornerText lines={dicomText.topLeft} style={dicomTL} testId="corner-text-tl" />
              <CornerText lines={dicomText.topRight} style={dicomTR} testId="corner-text-tr" />
              <CornerText lines={dicomText.bottomLeft} style={dicomBL} testId="corner-text-bl" />
              <CornerText lines={dicomText.bottomRight} style={dicomBR} testId="corner-text-br" />
            </>
          )}
      {loading && !error && (
        <div style={overlayCenter}>
          <LoadingSpinner size={28} />
          <div>{t("common.loading")}</div>
        </div>
      )}
      {/* 初回ロード後のスライス送りで、まだ未取得のスライスを待っている間の視覚フィードバック。 */}
      {!loading && sliceLoading && !error && (
        <div style={sliceLoadingBadge}>
          <LoadingSpinner size={20} />
        </div>
      )}
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
          <StatusItem testId="status-zoom" label={t("viewer.status.zoom")} value={`${Math.round(transform.zoom * 100)}%`} />
          {panned && <span style={panBadge}>{t("viewer.panned")}</span>}
          <StatusItem
            testId="status-wl"
            label={t("viewer.status.wl")}
            value={
              voi
                ? suvScale
                  ? `${(voi.wc * suvScale).toFixed(2)}/${(voi.ww * suvScale).toFixed(2)}`
                  : `${Math.round(voi.wc)}/${Math.round(voi.ww)}`
                : "—"
            }
          />
          <StatusItem testId="status-value" label={t("viewer.status.value")} value={cursorValue} />
          <StatusItem testId="status-xy" label={t("viewer.status.xy")} value={cursorXY} />
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

        {/* 操作バー（canvas の外＝ツール入力と競合しない）。showControls=false で畳む。 */}
        {showControls && (
        <div style={toolbar}>
          <button onClick={fit} style={btn} title={t("viewer.fit")}><ToolIcon file={UI_ICON_FILES.fit} size={16} /></button>
          <button
            onClick={togglePan}
            style={{ ...btn, ...(panMode ? infoBtnOn : null) }}
            aria-pressed={panMode}
            title={t("viewer.pan")}
          >
            <ToolIcon id={TOOL_IDS.pan} size={16} style={panMode ? ACTIVE_ICON_STYLE : undefined} />
          </button>
          <button data-testid="viewer-zoom-out-btn" onClick={() => zoomBy(1 / 1.2)} style={btn} title={t("viewer.zoomOut")}>−</button>
          <button data-testid="viewer-zoom-in-btn" onClick={() => zoomBy(1.2)} style={btn} title={t("viewer.zoomIn")}>＋</button>
          <button onClick={rotate90} style={btn} title={t("viewer.rotate")}><ToolIcon file={UI_ICON_FILES.rotate} size={16} /></button>
          <button onClick={flipH} style={btn} title={t("viewer.flipH")}><ToolIcon file={UI_ICON_FILES.flipH} size={16} /></button>
          <button onClick={flipV} style={btn} title={t("viewer.flipV")}><ToolIcon file={UI_ICON_FILES.flipV} size={16} /></button>
          <button
            onClick={toggleInvert}
            disabled={isColor}
            style={{ ...btn, ...(inverted ? infoBtnOn : null), ...(isColor ? btnDisabled : null) }}
            title={t("viewer.invert")}
          >
            <ToolIcon file={UI_ICON_FILES.invert} size={16} style={inverted ? ACTIVE_ICON_STYLE : undefined} />
          </button>
          <button
            data-testid="viewer-lut-button"
            onClick={() => setShowLutDialog(true)}
            disabled={isColor}
            style={{ ...btn, ...(activeLutName ? infoBtnOn : null), ...(isColor ? btnDisabled : null) }}
            title={t("viewer.lut")}
          >
            {t("viewer.lut")}
          </button>
          <button onClick={reset} style={btn} title={t("viewer.reset")}><ToolIcon file={UI_ICON_FILES.reset} size={16} /></button>
          <span style={{ width: 1, alignSelf: "stretch", background: "#dde4ea", margin: "0 2px" }} />
          <button data-testid="viewer-undo-btn" onClick={undo} disabled={!canUndo} style={btn} title={t("viewer.undo")}>↶</button>
          <button data-testid="viewer-redo-btn" onClick={redo} disabled={!canRedo} style={btn} title={t("viewer.redo")}>↷</button>
        </div>
        )}
      </div>

      {/* 右サイド: 輝度/ボクセル/FOV のキャリブレーション情報＋マウス座標＋ライブ WW/WL。
          Off にすると非表示になり、画像パネルがこの領域まで広がる。 */}
      {showInfo && <ImageInfoPanel info={info} sample={sample} voi={voi} />}
    </div>
    {lutDialogEl}
    </>
  );
}

function CornerText({ lines, style, testId }: { lines: string[]; style: React.CSSProperties; testId?: string }) {
  if (!lines.length) return null;
  return (
    <div data-testid={testId} style={style}>
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

function StatusItem({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <span style={statusItem}>
      <span style={statusKey}>{label}</span>
      <span data-testid={testId} style={statusVal}>{value}</span>
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
const pixelLayer: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  // ⚠️ タッチ端末では、これが無いと画像上のドラッグがブラウザのページスクロール／ピンチズームに
  // 奪われ、W/L も Pan も効かない（`fw/mobile-ui-design.md` §3.3）。ブラウザ既定のジェスチャを
  // すべて止めて、Cornerstone のツールに渡す。マウス操作には影響しない。
  touchAction: "none",
};
/** プラグインオーバーレイの出所ラベル（本体の描画と混同させないための表示）。 */
const pluginOverlayLabel: React.CSSProperties = {
  position: "absolute",
  left: 8,
  bottom: 8,
  padding: "2px 6px",
  borderRadius: 3,
  background: "rgba(11,92,173,0.75)",
  color: "#fff",
  font: "11px/1.4 monospace",
  pointerEvents: "none",
};
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
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 8,
  color: "#cfd8dc",
  fontSize: 13,
  pointerEvents: "none",
};
// スライス送り待ち中の円形インジケータ。タイル右上に小さく重ねて表示し、
// 直前スライスの表示自体は隠さない（layoutPending/overlayCenter は初回ロード専用）。
const sliceLoadingBadge: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  background: "rgba(0,0,0,0.45)",
  borderRadius: "50%",
  padding: 4,
  display: "flex",
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
