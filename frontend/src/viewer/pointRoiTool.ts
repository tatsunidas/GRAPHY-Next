/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 点 ROI。挙動は ProbeTool と同じだが、**計測ではなく ROI** として扱うため別名で登録する
 * （分類は {@link ./roiKind}）。Probe は計測のまま残す。
 */
import { ProbeTool } from "@cornerstonejs/tools";

export const POINT_ROI_TOOL_NAME = "GraphyPointROI";

export class PointRoiTool extends ProbeTool {
  static override toolName = POINT_ROI_TOOL_NAME;
}
