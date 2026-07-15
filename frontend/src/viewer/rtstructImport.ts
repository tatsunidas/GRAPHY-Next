/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM RTSTRUCT 読込 → Cornerstone アノテーション復元（S3）。
 *
 * backend `/api/dicom/rtstruct` が返す ROI 輪郭（患者座標 mm）を、**表示中の source シリーズ**へ
 * PlanarFreehandROI（閉輪郭）として復元する。輪郭点は既に world 座標なので変換不要。スライスは
 * ContourImage の ReferencedSOPInstanceUID を表示中スタックの imageId に対応付けて決める。
 * 現在表示中スタディの RTSTRUCT シリーズ（Modality=RTSTRUCT）をまとめて取り込む。
 */
import { getRenderingEngines } from "@cornerstonejs/core";
import { annotation as csAnnotation, utilities as csToolsUtil } from "@cornerstonejs/tools";
import { getViewerContext } from "./viewerContext";
import { setRoiMaskMeta } from "./roiMaskStore";
import { roiToMask } from "./roiBooleanOps";
import { fetchSeries, readDicomRtStruct, type RtStructImportRoi } from "../api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;
type V3 = [number, number, number];

function firstBaseViewport(): AnyObj | null {
  let fallback: AnyObj | null = null;
  for (const e of getRenderingEngines() ?? []) {
    for (const vp of (e as AnyObj)?.getViewports?.() ?? []) {
      const ids = (vp as AnyObj).getImageIds?.() as string[] | undefined;
      if (!ids?.length) continue;
      if (getViewerContext((vp as AnyObj).id)) return vp;
      fallback ??= vp;
    }
  }
  return fallback;
}

function sopOf(imageId: string): string | null {
  const m = /\/instances\/([^/]+)\//.exec(imageId);
  return m ? decodeURIComponent(m[1]) : null;
}

function emptyTextBox() {
  return {
    hasMoved: false,
    worldPosition: [0, 0, 0],
    worldBoundingBox: { topLeft: [0, 0, 0], topRight: [0, 0, 0], bottomLeft: [0, 0, 0], bottomRight: [0, 0, 0] },
  };
}

/** DTO 群を表示中ビューポートへ復元。復元した annotationUID 群を返す。 */
function reconstruct(rois: RtStructImportRoi[]): string[] {
  const vp = firstBaseViewport();
  if (!vp) return [];
  const imageIds = vp.getImageIds() as string[];
  const camera = vp.getCamera();
  const ctx = getViewerContext(vp.id);
  const sopToId = new Map<string, { id: string; z: number }>();
  imageIds.forEach((id, z) => {
    const s = sopOf(id);
    if (s) sopToId.set(s, { id, z });
  });

  const created: string[] = [];
  for (const roi of rois) {
    const colorStr = roi.color && roi.color.length >= 3 ? `rgb(${roi.color[0]}, ${roi.color[1]}, ${roi.color[2]})` : undefined;
    for (const c of roi.contours) {
      const pts = c.points;
      if (!pts || pts.length < 9) continue;
      const polyline: V3[] = [];
      for (let i = 0; i + 2 < pts.length; i += 3) polyline.push([pts[i], pts[i + 1], pts[i + 2]]);

      const hit = c.referencedSopInstanceUid ? sopToId.get(c.referencedSopInstanceUid) : undefined;
      const target = hit ?? { id: imageIds[0], z: 0 };
      if (!target.id) continue;

      const annotationUID = csToolsUtilUuid();
      const viewRef = vp.getViewReference ? vp.getViewReference({ sliceIndex: target.z }) : {};
      const annotation = {
        annotationUID,
        highlighted: false,
        invalidated: true,
        isLocked: false,
        isVisible: true,
        metadata: {
          ...viewRef,
          toolName: "PlanarFreehandROI",
          referencedImageId: target.id,
          viewPlaneNormal: camera?.viewPlaneNormal,
          viewUp: camera?.viewUp,
          cameraPosition: camera?.position,
          cameraFocalPoint: camera?.focalPoint,
        },
        data: {
          handles: {
            points: [polyline[0], polyline[polyline.length - 1]],
            activeHandleIndex: null,
            textBox: emptyTextBox(),
          },
          contour: { polyline, closed: true },
          polyline,
          isOpenContour: false,
          cachedStats: {},
        },
      };
      try {
        (csAnnotation.state as AnyObj).addAnnotation(annotation, vp.element);
      } catch {
        continue;
      }
      try {
        if (colorStr) (csAnnotation.config.style as AnyObj).setAnnotationStyles?.(annotationUID, { color: colorStr });
      } catch { /* ignore */ }
      if (ctx) {
        const scope = { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: target.z, c: ctx.c, t: ctx.t };
        setRoiMaskMeta(annotationUID, { patientKey: ctx.patientKey, seriesLabel: ctx.seriesLabel, scope, origin: scope, label: roi.name });
      }
      created.push(annotationUID);
    }
  }
  if (created.length > 0) {
    try { csToolsUtil.triggerAnnotationRenderForViewportIds([vp.id]); } catch { /* ignore */ }
  }
  return created;
}

// csToolsUtil.uuidv4 or core; use a simple uuid.
function csToolsUtilUuid(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const u = (csToolsUtil as any).uuidv4?.();
  if (u) return u;
  return "rtss-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

export interface RtStructImportResult {
  /** 復元した ROI（注釈）総数。 */
  roiCount: number;
  /** そのうち自動的に Mask 化できた数（3D Viewer/中心線解析/Volumetry へそのまま渡せる）。 */
  maskCount: number;
}

/**
 * 表示中スタディの RTSTRUCT シリーズをすべて読み、表示中 source シリーズへ ROI を復元する。
 * 復元した各 ROI は続けて自動的に Mask 化する（従来は手動の「▦」操作が必要だった。
 * `fw/mask-driven-pipelines-gap-analysis.md` 課題#3）。roiCount=0 なら対象 RTSTRUCT 無し or 復元不可。
 */
export async function importRtStructForCurrentView(): Promise<RtStructImportResult> {
  const vp = firstBaseViewport();
  const ctx = vp ? getViewerContext(vp.id) : null;
  if (!vp || !ctx?.studyUid) return { roiCount: 0, maskCount: 0 };
  const seriesList = await fetchSeries(ctx.studyUid).catch(() => []);
  const rtSeries = seriesList.filter((s) => (s.modality ?? "").toUpperCase() === "RTSTRUCT");
  if (!rtSeries.length) return { roiCount: 0, maskCount: 0 };
  const createdUids: string[] = [];
  for (const s of rtSeries) {
    const rois = await readDicomRtStruct(ctx.studyUid, s.seriesInstanceUid).catch(() => []);
    createdUids.push(...reconstruct(rois));
  }
  let maskCount = 0;
  for (const uid of createdUids) {
    const res = await roiToMask(uid).catch(() => null);
    if (res) maskCount++;
  }
  return { roiCount: createdUids.length, maskCount };
}
