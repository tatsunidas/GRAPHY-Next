/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** Cornerstone ツール名の単一ソース（メニュー/ツールバーから setActiveTool に渡す）。 */
import {
  WindowLevelTool,
  PanTool,
  ZoomTool,
  LengthTool,
  AngleTool,
  EllipticalROITool,
  RectangleROITool,
  ProbeTool,
  BrushTool,
} from "@cornerstonejs/tools";

/** 消しゴムの合成ツール ID（BrushTool の ERASE ストラテジに対応する内部値）。 */
export const ERASER_TOOL_ID = "__graphy_eraser__";
/** Wand（対話型リージョングロー）の合成 ID。実ツールは WandTool、mode でモード切替（2D/3D）。 */
export const WAND2D_TOOL_ID = "__graphy_wand2d__";
export const WAND3D_TOOL_ID = "__graphy_wand3d__";

export const TOOL_IDS = {
  windowLevel: WindowLevelTool.toolName,
  pan: PanTool.toolName,
  zoom: ZoomTool.toolName,
  length: LengthTool.toolName,
  angle: AngleTool.toolName,
  ellipse: EllipticalROITool.toolName,
  rect: RectangleROITool.toolName,
  probe: ProbeTool.toolName,
  brush: BrushTool.toolName,
  eraser: ERASER_TOOL_ID,
  /** 3D Wand（対話型・輝度領域成長。ダイアログで seed/connectivity/threshold）。 */
  region3d: WAND3D_TOOL_ID,
  /** 2D Wand（対話型・輝度領域成長。単一スライス）。 */
  wand2d: WAND2D_TOOL_ID,
} as const;
