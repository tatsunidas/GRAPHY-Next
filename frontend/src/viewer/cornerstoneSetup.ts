/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Cornerstone3D の初期化（1 度だけ）。
// - core.init(): レンダリング基盤。
// - dicomImageLoader.init(): wadouri / wadors の画像ローダ登録＋デコード用 Web Worker 構成。
//   CSP は wasm-unsafe-eval / worker-src blob: を許可済み（圧縮 TS はワーカ＋WASM でデコード）。
import { init as coreInit, cache } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import {
  DEFAULT_VOLUME_MAX_MB,
  normalizeVolumeMaxMb,
  setAppliedVolumeMaxMb,
  volumeMaxBytes,
} from "./volumeMemory";
import { resolveVolumeBudgetMb } from "./volumeMemoryGuard";
import { registerSegMetadataProvider } from "./segMetadata";
import { registerThickSlabLoader } from "./thickSlab";
import { WandTool } from "./wandTool";
import { LevelSetTool } from "./levelSetsTool";
import { installSegDebug } from "./segDebug";
import {
  init as toolsInit,
  addTool,
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
  PaintFillTool,
  RegionSegmentTool,
  RegionSegmentPlusTool,
  RectangleScissorsTool,
  CircleScissorsTool,
  SphereScissorsTool,
  RectangleROIThresholdTool,
  CrosshairsTool,
  StackScrollTool,
  TrackballRotateTool,
  OrientationMarkerTool,
  segmentation as csSeg,
  annotation as csAnnotation,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import {
  FreeLineRoiTool,
  FreehandRoiTool,
  PolygonRoiTool,
  PolylineRoiTool,
} from "./roiContourTools";

/**
 * マスク（labelmap）のグローバル既定スタイルを適用する。新規マスクの塗り不透明度（fillAlpha 0..1）・
 * アウトライン幅（outlineWidth）の既定になる。環境設定（viewer.maskFillOpacity / maskOutlineWidth）を
 * 読み込んだ後に呼び出して上書きする。
 */
export function applyGlobalLabelmapStyle(style: { outlineWidth?: number; fillAlpha?: number }): void {
  try {
    csSeg.segmentationStyle.setStyle(
      { type: csToolsEnums.SegmentationRepresentations.Labelmap },
      style,
    );
  } catch {
    /* ignore */
  }
}

/** "#rrggbb" → "rgb(r, g, b)"（Cornerstone annotation の色は rgb 文字列）。不正入力は null。 */
function hexToRgbStr(hex: string): string | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  return `rgb(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)})`;
}

/**
 * 計測 ROI（annotation）のグローバル既定スタイルを適用する。新規に描く注釈の色・線幅の既定になる。
 * `setDefaultToolStyles` は既定を丸ごと置換するため、既存既定にマージする。
 */
export function applyGlobalAnnotationStyle(style: { colorHex?: string; lineWidth?: number }): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg = csAnnotation.config.style as any;
    const cur = cfg.getDefaultToolStyles?.() ?? {};
    const next = { ...cur };
    if (style.colorHex) {
      const rgb = hexToRgbStr(style.colorHex);
      if (rgb) next.color = rgb;
    }
    if (typeof style.lineWidth === "number" && style.lineWidth > 0) {
      next.lineWidth = String(style.lineWidth);
    }
    cfg.setDefaultToolStyles?.(next);
  } catch {
    /* ignore */
  }
}

/**
 * Cornerstone の画像キャッシュ上限（＝ボリューム構築のバジェット）を明示設定する。
 *
 * <p>cornerstone の既定は 3GB（`cache.js` の `3 * ONE_GB`）で、これまで
 * `setMaxCacheSize()` をどこからも呼んでいなかったため<b>設定値と実際の上限が乖離</b>していた。
 * 環境設定 `viewer.volumeMaxMb` と一致させるのが目的（`fw/volume-memory-guard.md` V1）。
 */
export function applyVolumeCacheLimit(maxMb: number): void {
  const mb = normalizeVolumeMaxMb(maxMb);
  try {
    cache.setMaxCacheSize(volumeMaxBytes(mb));
    setAppliedVolumeMaxMb(mb);
  } catch {
    /* 上限設定に失敗しても初期化は続行（既定の 3GB のまま） */
  }
}

let initPromise: Promise<void> | null = null;

/** 冪等な初期化。複数の Viewer2D から呼ばれても 1 回だけ実行する。 */
export function ensureCornerstoneInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await coreInit();
      // 画像キャッシュ上限を明示する。まず既定値を即時適用し、バジェットが解決したら上書きする
      // （設定/IPC の往復で初期表示を待たせない）。解決前に始まったボリューム構築は既定値で走る。
      // 決定順は resolveVolumeBudgetMb（設定 → 実搭載量×安全率 → 既定値）。
      applyVolumeCacheLimit(DEFAULT_VOLUME_MAX_MB);
      void resolveVolumeBudgetMb()
        .then(applyVolumeCacheLimit)
        .catch(() => {
          /* 既定のまま */
        });
      // メインスレッドを塞がないようワーカ数は CPU-1（最大 4）に抑える。
      const maxWebWorkers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      dicomImageLoader.init({ maxWebWorkers });
      // ツール基盤と、affine 変換（Pan/Zoom）を担うツールをグローバル登録（1 回だけ）。
      toolsInit();
      addTool(PanTool);
      addTool(ZoomTool);
      addTool(WindowLevelTool);
      // 計測（ROI）ツール。各 base ビューポートのツールグループへ後で追加し、setActiveTool で切替。
      addTool(LengthTool);
      // RECIST 1.1 の標準計測（長径＋それに直交する短径を 1 つの注釈で持つ）。
      // プラグイン host API の H5 は、この 2 軸を measurements.length / shortAxis として返す。
      addTool(BidirectionalTool);
      addTool(AngleTool);
      addTool(EllipticalROITool);
      addTool(RectangleROITool);
      addTool(ProbeTool);
      // ImageJ 由来の polygon/freehand ROI 描画用（インポート再構築の受け皿）。
      addTool(PlanarFreehandROITool);
      // 輪郭系 ROI（ポリゴン/フリーハンド × 閉じる/閉じない）。同じクラスを別名で登録して
      // 「閉じる／閉じない」を分けている（viewer/roiContourTools.ts）。
      addTool(PolygonRoiTool);
      addTool(PolylineRoiTool);
      addTool(FreehandRoiTool);
      addTool(FreeLineRoiTool);
      // セグメンテーション（Mask）編集: ROI ブラシ/消しゴム（2D 円 / 3D 球ストラテジ）。
      addTool(BrushTool);
      // セグメンテーション拡充（segmentation-tools-design.md）。3D 系ツールは stack labelmap から
      // on-demand で volume 化して動く（Cornerstone3D の EnsureSegmentationVolumeFor3DManipulation。
      // 規則的ボリュームでない場合は例外→2D フォールバック）。VolumeViewport 移行は不要。
      addTool(PaintFillTool); // Wand 2D: スライス内 flood fill
      addTool(RegionSegmentTool); // 領域成長（growCut ベース）
      addTool(RegionSegmentPlusTool); // 領域成長＋（seed 自動）
      addTool(RectangleScissorsTool);
      addTool(CircleScissorsTool);
      addTool(SphereScissorsTool); // 3D 球で fill/erase
      addTool(RectangleROIThresholdTool); // しきい値塗り
      addTool(WandTool); // Wand（対話型リージョングロー: 2D/3D 輝度 flood, ダイアログ駆動）
      addTool(LevelSetTool); // Level Sets（対話型・Fast Marching。L1 時点、fw/level-sets-design.md）
      // MPR（VolumeViewport）: 連動十字線・ボリュームスライス送り。
      addTool(CrosshairsTool);
      addTool(StackScrollTool);
      // 3D Viewer（VOLUME_3D）: アークボール回転（VR/MIP/Cinematic 共通の視点操作）＋向きギズモ。
      addTool(TrackballRotateTool);
      addTool(OrientationMarkerTool);
      // セグメンテーション: backend 幾何から imagePlaneModule を供給（labelmap 生成の画素プリロード撤廃）。
      registerSegMetadataProvider();
      // ThickSlab（デジタルスライス厚）: graphy-thickslab: スキームの合成スライスローダ＋メタデータ委譲。
      registerThickSlabLoader();
      // 診断: Brush 無言停止時に Console で `__graphySegDebug()` を実行して状態を出力。
      installSegDebug();
      // マスク（labelmap）の既定スタイル（アウトライン幅・塗り不透明度）。Cornerstone 既定は
      // outlineWidth:3 / fillAlpha:0.5。ここでは初期既定（1 / 0.5）を適用し、環境設定
      // （viewer.maskOutlineWidth / viewer.maskFillOpacity）読込後に applyGlobalLabelmapStyle で上書きする。
      applyGlobalLabelmapStyle({ outlineWidth: 1, fillAlpha: 0.5 });
    })();
  }
  return initPromise;
}
