/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { type Types } from "@cornerstonejs/core";
import { utilities as csToolsUtilities } from "@cornerstonejs/tools";

// Cornerstone3D の実装を利用（LPS ベクトル → 向き文字列）。
// 規約: +X=L/−X=R, +Y=P/−Y=A, +Z=H/−Z=F（DICOM 患者座標 LPS）。
const getOrientationStringLPS = csToolsUtilities.orientation.getOrientationStringLPS;

/** 画像の四辺に表示する向き文字（例 top="A", right="L"）。 */
export interface OrientationMarkers {
  top: string;
  bottom: string;
  left: string;
  right: string;
}

function dirTo(center: Types.Point3, edge: Types.Point3): Types.Point3 {
  const d: Types.Point3 = [edge[0] - center[0], edge[1] - center[1], edge[2] - center[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  return [d[0] / len, d[1] / len, d[2] / len];
}

/**
 * 表示中の四辺の患者方向（A/P・R/L・H/F）を求める。
 *
 * <p>各辺の world(LPS) 方向を `canvasToWorld`（=現在カメラの逆変換。zoom/pan/flip/rotation を
 * すべて含む）で求めるため、回転・反転にそのまま追従する。world→画像ジオメトリは IOP/IPP に
 * 基づくので、向きは DICOM の IOP に従って計算される。
 */
export function computeOrientationMarkers(
  viewport: Types.IStackViewport,
  element: HTMLElement,
): OrientationMarkers | null {
  try {
    const w = element.clientWidth;
    const h = element.clientHeight;
    if (!w || !h) return null;
    const center = viewport.canvasToWorld([w / 2, h / 2]);
    const right = getOrientationStringLPS(dirTo(center, viewport.canvasToWorld([w, h / 2])));
    const left = getOrientationStringLPS(dirTo(center, viewport.canvasToWorld([0, h / 2])));
    const top = getOrientationStringLPS(dirTo(center, viewport.canvasToWorld([w / 2, 0])));
    const bottom = getOrientationStringLPS(dirTo(center, viewport.canvasToWorld([w / 2, h])));
    if (![top, bottom, left, right].some(Boolean)) return null;
    return { top, bottom, left, right };
  } catch {
    return null;
  }
}
