/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Cornerstone3D の初期化（1 度だけ）。
// - core.init(): レンダリング基盤。
// - dicomImageLoader.init(): wadouri / wadors の画像ローダ登録＋デコード用 Web Worker 構成。
//   CSP は wasm-unsafe-eval / worker-src blob: を許可済み（圧縮 TS はワーカ＋WASM でデコード）。
import { init as coreInit } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import { registerSegMetadataProvider } from "./segMetadata";
import {
  init as toolsInit,
  addTool,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  LengthTool,
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
} from "@cornerstonejs/tools";

let initPromise: Promise<void> | null = null;

/** 冪等な初期化。複数の Viewer2D から呼ばれても 1 回だけ実行する。 */
export function ensureCornerstoneInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await coreInit();
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
      addTool(AngleTool);
      addTool(EllipticalROITool);
      addTool(RectangleROITool);
      addTool(ProbeTool);
      // ImageJ 由来の polygon/freehand ROI 描画用（インポート再構築の受け皿）。
      addTool(PlanarFreehandROITool);
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
      // MPR（VolumeViewport）: 連動十字線・ボリュームスライス送り。
      addTool(CrosshairsTool);
      addTool(StackScrollTool);
      // セグメンテーション: backend 幾何から imagePlaneModule を供給（labelmap 生成の画素プリロード撤廃）。
      registerSegMetadataProvider();
    })();
  }
  return initPromise;
}
