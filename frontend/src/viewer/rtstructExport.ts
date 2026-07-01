/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D ベクタ ROI（面積型）→ DICOM RTSTRUCT 書き出しリクエストの組み立て（frontend 側）。
 * 各 ROI をスライス面の**閉輪郭（患者座標 mm 点列）**にして backend `/api/dicom/rtstruct` へ送る。
 * 楕円/円はポリゴン近似、矩形は 4 隅、フリーハンドは polyline をそのまま使う。
 * 線/角度/点は閉輪郭に不向きのため対象外（ImageJ/SR/GSPS 側で扱う）。設計 `fw/dicom-seg-rtstruct-design.md` S2。
 */
import { metaData } from "@cornerstonejs/core";
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { getRoiMaskMeta } from "./roiMaskStore";
import { exportDicomRtStruct, type RtStructRoi, type RtStructExportRequest, type SegExportResult } from "../api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;
type V3 = [number, number, number];

const CIRCLE_SAMPLES = 72;

function sopOf(imageId: string): string | null {
  const m = /\/instances\/([^/]+)\//.exec(imageId);
  if (m) return decodeURIComponent(m[1]);
  const sc = metaData.get("sopCommonModule", imageId) as { sopInstanceUID?: string } | undefined;
  return sc?.sopInstanceUID ?? null;
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function mean(pts: V3[]): V3 {
  const s: V3 = [0, 0, 0];
  for (const p of pts) { s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; }
  return [s[0] / pts.length, s[1] / pts.length, s[2] / pts.length];
}
function flatten(pts: V3[]): number[] {
  const out: number[] = [];
  for (const p of pts) out.push(p[0], p[1], p[2]);
  return out;
}

/** 楕円: 4 handle（両軸端）→ 中心＋2 半軸でポリゴン近似。 */
function ellipsePolygon(h: V3[]): V3[] {
  if (h.length < 4) return h;
  const c = mean(h);
  const v1 = sub(h[0], c);
  const v2 = sub(h[2], c);
  const out: V3[] = [];
  for (let k = 0; k < CIRCLE_SAMPLES; k++) {
    const t = (2 * Math.PI * k) / CIRCLE_SAMPLES;
    out.push(add(c, add(scale(v1, Math.cos(t)), scale(v2, Math.sin(t)))));
  }
  return out;
}

/** 円: [中心, 端] ＋スライス IOP 基底でポリゴン近似。 */
function circlePolygon(h: V3[], rowCos: V3, colCos: V3): V3[] {
  if (h.length < 2) return h;
  const c = h[0];
  const r = Math.hypot(h[1][0] - c[0], h[1][1] - c[1], h[1][2] - c[2]);
  const out: V3[] = [];
  for (let k = 0; k < CIRCLE_SAMPLES; k++) {
    const t = (2 * Math.PI * k) / CIRCLE_SAMPLES;
    out.push(add(c, add(scale(rowCos, r * Math.cos(t)), scale(colCos, r * Math.sin(t)))));
  }
  return out;
}

/** 矩形: 4 隅を中心角でソートして閉環にする（handle 順が対角でも破綻しない）。 */
function rectPolygon(h: V3[], rowCos: V3, colCos: V3): V3[] {
  if (h.length < 3) return h;
  const c = mean(h);
  return [...h].sort((p, q) => {
    const ap = Math.atan2(dot(sub(p, c), colCos), dot(sub(p, c), rowCos));
    const aq = Math.atan2(dot(sub(q, c), colCos), dot(sub(q, c), rowCos));
    return ap - aq;
  });
}

function annColorRgb(uid: string): [number, number, number] | null {
  try {
    const st = (csAnnotation.config.style as AnyObj).getAnnotationToolStyles?.(uid) as AnyObj | undefined;
    const col = st?.color as string | undefined;
    const m = col && /rgb\(\s*(\d+)\D+(\d+)\D+(\d+)/.exec(col);
    if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  } catch { /* ignore */ }
  return null;
}

/** 面積型 ROI 群を RTSTRUCT として書き出す。成功時 { seriesInstanceUid }、対象が無ければ null。 */
export async function exportRoisAsRtStruct(uids: string[]): Promise<SegExportResult | null> {
  let studyUid: string | undefined;
  let seriesUid: string | undefined;
  let forUid: string | undefined;
  const rois: RtStructRoi[] = [];
  let n = 0;

  for (const uid of uids) {
    const ann = (csAnnotation.state as AnyObj).getAnnotation?.(uid) as AnyObj | undefined;
    const refId = ann?.metadata?.referencedImageId as string | undefined;
    if (!ann || !refId) continue;
    const tool = String(ann.metadata?.toolName ?? "");
    // 面積型のみ（線/角度/点は不対応）。
    const isEllipse = /ellip/i.test(tool);
    const isCircle = /circle/i.test(tool);
    const isRect = /rect/i.test(tool);
    const isFreehand = /freehand|polygon|spline/i.test(tool);
    if (!(isEllipse || isCircle || isRect || isFreehand)) continue;

    const plane = (metaData.get("imagePlaneModule", refId) as AnyObj) ?? {};
    const iop = plane.imageOrientationPatient as number[] | undefined;
    const rowCos: V3 = iop && iop.length >= 6 ? [iop[0], iop[1], iop[2]] : [1, 0, 0];
    const colCos: V3 = iop && iop.length >= 6 ? [iop[3], iop[4], iop[5]] : [0, 1, 0];
    const sop = sopOf(refId);
    if (!sop) continue;

    const handles = (ann.data?.handles?.points as V3[] | undefined) ?? [];
    const polyline = (ann.data?.contour?.polyline as V3[] | undefined) ?? [];
    let ring: V3[] = [];
    if (isFreehand && polyline.length >= 3) ring = polyline;
    else if (isEllipse) ring = ellipsePolygon(handles);
    else if (isCircle) ring = circlePolygon(handles, rowCos, colCos);
    else if (isRect) ring = rectPolygon(handles, rowCos, colCos);
    else if (polyline.length >= 3) ring = polyline;
    else ring = handles;
    if (ring.length < 3) continue;

    // 参照 study/series/FoR は最初の ROI から採用（同一シリーズ前提）。
    if (!studyUid || !seriesUid) {
      const meta = getRoiMaskMeta(uid);
      const gsm = (metaData.get("generalSeriesModule", refId) as AnyObj) ?? {};
      studyUid = meta?.scope?.studyUid ?? gsm.studyInstanceUID;
      seriesUid = meta?.scope?.seriesUid ?? gsm.seriesInstanceUID;
      forUid = plane.frameOfReferenceUID ?? undefined;
    }

    n++;
    rois.push({
      number: n,
      name: getRoiMaskMeta(uid)?.label || tool || `ROI ${n}`,
      color: annColorRgb(uid),
      type: "ORGAN",
      contours: [{ sopInstanceUid: sop, points: flatten(ring) }],
    });
  }

  if (!rois.length || !studyUid || !seriesUid || !forUid) return null;

  const req: RtStructExportRequest = {
    studyInstanceUid: studyUid,
    seriesInstanceUid: seriesUid,
    frameOfReferenceUID: forUid,
    structureSetLabel: "ROI",
    rois,
  };
  return exportDicomRtStruct(req);
}
