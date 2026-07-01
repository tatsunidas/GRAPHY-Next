/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ImageJ ROI DTO（画像ピクセル座標）→ Cornerstone アノテーション再構築（Import）。
 *
 * backend `/api/imagej/import` がデコードした {@link ImageJRoiDto} 群を、表示中の stack ビューポートへ
 * Cornerstone アノテーションとして復元する。`imageToWorldCoords`（export の逆）で画素→world 化し、
 * oval→EllipticalROI / rect→RectangleROI / それ以外→PlanarFreehandROI（閉輪郭）にマップする。
 * position（1-based）でスライスを選び、`roiMaskStore` にメタ（patient/series/scope）を紐付ける。
 */
import { getRenderingEngines, utilities as csUtils } from "@cornerstonejs/core";
import { annotation as csAnnotation, utilities as csToolsUtil } from "@cornerstonejs/tools";
import { getViewerContext } from "./viewerContext";
import { setRoiMaskMeta } from "./roiMaskStore";
import type { ImageJRoiDto } from "../api";

type V3 = [number, number, number];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function firstBaseViewport(): any {
  // roiContext を持つ（＝main 2D）stack viewport を優先。無ければ imageIds を持つ最初。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fallback: any = null;
  for (const e of getRenderingEngines() ?? []) {
    for (const vp of e?.getViewports() ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = (vp as any).getImageIds?.() as string[] | undefined;
      if (!ids?.length) continue;
      if (getViewerContext(vp.id)) return vp;
      fallback ??= vp;
    }
  }
  return fallback;
}

/**
 * DTO 群を復元して addAnnotation。復元できた件数を返す。
 * 対象ビューポートが無ければ 0。
 */
export function importImageJDtos(dtos: ImageJRoiDto[]): number {
  const vp = firstBaseViewport();
  if (!vp) return 0;
  const imageIds = vp.getImageIds() as string[];
  const camera = vp.getCamera();
  const ctx = getViewerContext(vp.id);
  let count = 0;

  for (const d of dtos) {
    const zIdx = Math.min(imageIds.length - 1, Math.max(0, (d.position || 1) - 1));
    const imageId = imageIds[zIdx];
    if (!imageId) continue;
    const toWorld = (x: number, y: number): V3 =>
      csUtils.imageToWorldCoords(imageId, [x, y]) as V3;

    let toolName: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let data: any;
    if (d.type === "oval" && d.bx != null && d.by != null && d.bw != null && d.bh != null) {
      const cx = d.bx + d.bw / 2, cy = d.by + d.bh / 2;
      toolName = "EllipticalROI";
      data = {
        handles: {
          points: [toWorld(cx, d.by), toWorld(cx, d.by + d.bh), toWorld(d.bx, cy), toWorld(d.bx + d.bw, cy)],
          activeHandleIndex: null,
          textBox: emptyTextBox(),
        },
        cachedStats: {},
      };
    } else if (d.type === "rect" && d.bx != null && d.by != null && d.bw != null && d.bh != null) {
      toolName = "RectangleROI";
      data = {
        handles: {
          points: [toWorld(d.bx, d.by), toWorld(d.bx + d.bw, d.by), toWorld(d.bx + d.bw, d.by + d.bh), toWorld(d.bx, d.by + d.bh)],
          activeHandleIndex: null,
          textBox: emptyTextBox(),
        },
        cachedStats: {},
      };
    } else {
      // polygon / freehand / polyline / point / angle → 閉/開輪郭（PlanarFreehandROI）。
      const xs = d.xs ?? [], ys = d.ys ?? [];
      if (!xs.length) continue;
      const polyline = xs.map((x, i) => toWorld(x, ys[i]));
      const closed = !(d.type === "polyline" || d.type === "angle" || d.type === "point");
      toolName = "PlanarFreehandROI";
      data = {
        handles: {
          points: [polyline[0], polyline[polyline.length - 1]],
          activeHandleIndex: null,
          textBox: emptyTextBox(),
        },
        contour: { polyline, closed },
        polyline,
        isOpenContour: !closed,
        cachedStats: {},
      };
    }

    const annotationUID = csUtils.uuidv4();
    const viewRef = vp.getViewReference ? vp.getViewReference({ sliceIndex: zIdx }) : {};
    const annotation = {
      annotationUID,
      highlighted: false,
      invalidated: true,
      isLocked: false,
      isVisible: true,
      metadata: {
        ...viewRef,
        toolName,
        referencedImageId: imageId,
        viewPlaneNormal: camera?.viewPlaneNormal,
        viewUp: camera?.viewUp,
        cameraPosition: camera?.position,
        cameraFocalPoint: camera?.focalPoint,
      },
      data,
    };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (csAnnotation.state as any).addAnnotation(annotation, vp.element);
    } catch {
      continue;
    }
    // マネージャ表示・scope 用メタ。
    if (ctx) {
      const scope = { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: zIdx, c: ctx.c, t: ctx.t };
      setRoiMaskMeta(annotationUID, {
        patientKey: ctx.patientKey,
        seriesLabel: ctx.seriesLabel,
        scope,
        origin: scope,
        label: d.name,
      });
    }
    count++;
  }

  if (count > 0) {
    try { csToolsUtil.triggerAnnotationRenderForViewportIds([vp.id]); } catch { /* ignore */ }
  }
  return count;
}

function emptyTextBox() {
  return {
    hasMoved: false,
    worldPosition: [0, 0, 0],
    worldBoundingBox: { topLeft: [0, 0, 0], topRight: [0, 0, 0], bottomLeft: [0, 0, 0], bottomRight: [0, 0, 0] },
  };
}
