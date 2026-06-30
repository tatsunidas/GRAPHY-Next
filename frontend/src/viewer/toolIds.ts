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
} as const;
