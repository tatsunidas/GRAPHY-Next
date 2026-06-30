/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * base ビューポートの現在コンテキスト（患者・スタディ・シリーズ・現在 ZCT）。
 *
 * ROI/Mask 作成時に「どの患者・シリーズ・(z,c,t) で作られたか」を捕捉して
 * {@link ../viewer/roiMaskStore} のメタ（scope/patient）に紐付けるために、viewportId 単位で保持する。
 */
export interface ViewerContext {
  patientKey: string;
  studyUid: string;
  seriesUid: string;
  seriesLabel: string;
  c: number;
  t: number;
  z: number;
}

const byViewport = new Map<string, ViewerContext>();

export function setViewerContext(viewportId: string, ctx: ViewerContext): void {
  byViewport.set(viewportId, ctx);
}

export function getViewerContext(viewportId: string): ViewerContext | undefined {
  return byViewport.get(viewportId);
}

export function clearViewerContext(viewportId: string): void {
  byViewport.delete(viewportId);
}
