/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D ベクタ ROI（面積型）→ DICOM RTSTRUCT 書き出しリクエストの組み立て（frontend 側）。
 * 各 ROI をスライス面の**閉輪郭（患者座標 mm 点列）**にして backend `/api/dicom/rtstruct` へ送る。
 * 楕円/円はポリゴン近似、矩形は 4 隅、フリーハンドは polyline をそのまま使う。
 * 線 ROI は OPEN_PLANAR、点 ROI は POINT（MARKER）で書く。計測（Length/Angle/Probe 等）は書き出さない。設計 `fw/dicom-seg-rtstruct-design.md` S2。
 */
import { cache, metaData } from "@cornerstonejs/core";
import { annotation as csAnnotation, segmentation as csSeg } from "@cornerstonejs/tools";
import { traceMaskContours, type Pt } from "./maskContour";
import { imageToWorldOnPlane, type PlaneGeometry } from "./imageCoords";
import { getRoiMaskMeta } from "./roiMaskStore";
import { roiKindOf } from "./roiKind";
import { exportDicomRtStruct, type RtStructContour, type RtStructRoi, type RtStructExportRequest, type SegExportResult } from "../api";

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
/**
 * マスク（ラベルマップ）→ RTSTRUCT の構造。segment ごとに 1 構造。
 * スライスごとに外周と穴を、それぞれ閉じた輪郭（CLOSED_PLANAR）として入れる（穴を別の輪郭で書くのは
 * RTSTRUCT の一般的な書き方）。輪郭は画素の境界をなぞる（`maskContour.ts`。`fw/roi-mask-model.md` §10）。
 * 幾何（IPP/IOP/画素間隔）の無いスライスは書かない。
 */
export function maskToRtStructRois(segId: string, segIndex?: number): { rois: Omit<RtStructRoi, "number">[]; refImageId?: string } {
  let labelmapIds: string[];
  try {
    labelmapIds = ((csSeg as AnyObj).getLabelmapImageIds(segId) as string[]) ?? [];
  } catch {
    return { rois: [] };
  }
  const meta = getRoiMaskMeta(segId);
  const bySeg = new Map<number, RtStructContour[]>();
  let refImageId: string | undefined;
  for (const lmId of labelmapIds) {
    const lm = cache.getImage(lmId) as AnyObj | undefined;
    const vm = lm?.voxelManager;
    const srcId = lm?.referencedImageId as string | undefined;
    if (!vm || !srcId) continue;
    const w = (lm.columns ?? lm.width) as number;
    const h = (lm.rows ?? lm.height) as number;
    const len = vm.getScalarDataLength() as number;
    const labels = new Uint8Array(len);
    const present = new Set<number>();
    for (let i = 0; i < len; i++) {
      const v = vm.getAtIndex(i) as number;
      if (v > 0) {
        labels[i] = v;
        present.add(v);
      }
    }
    if (!present.size) continue;
    const plane = metaData.get("imagePlaneModule", srcId) as AnyObj | undefined;
    const sop = sopOf(srcId);
    if (!plane?.imagePositionPatient || !plane.rowCosines || !plane.columnCosines || !sop) continue;
    if (!(plane.rowPixelSpacing > 0) || !(plane.columnPixelSpacing > 0)) continue;
    refImageId ??= srcId;
    const toWorld = (p: Pt) => imageToWorldOnPlane(plane as PlaneGeometry, p);
    for (const seg of [...present].sort((a, b) => a - b)) {
      if (segIndex != null && seg !== segIndex) continue;
      const list = bySeg.get(seg) ?? [];
      for (const c of traceMaskContours(labels, w, h, seg)) {
        for (const ring of [c.outer, ...c.holes]) {
          list.push({ sopInstanceUid: sop, points: flatten(ring.map(toWorld)), geometricType: "CLOSED_PLANAR" });
        }
      }
      bySeg.set(seg, list);
    }
  }
  const base = meta?.label || segId;
  const names = meta?.segmentLabels ?? {};
  // 色は segment 色（マスクを表示している viewport のもの）。取れなければ null。
  const vpIds = ((csSeg.state as AnyObj).getViewportIdsWithSegmentation?.(segId) as string[] | undefined) ?? [];
  const segColor = (seg: number): [number, number, number] | null => {
    try {
      if (!vpIds[0]) return null;
      const c = (csSeg.config.color as AnyObj).getSegmentIndexColor(vpIds[0], segId, seg) as number[] | undefined;
      if (c && c.length >= 3) return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
    } catch { /* ignore */ }
    return null;
  };
  const rois = [...bySeg.entries()].map(([seg, contours]) => ({
    name: names[seg] || (bySeg.size > 1 || (meta?.segments?.length ?? 1) > 1 ? `${base} #${seg}` : base),
    color: segColor(seg),
    type: "ORGAN",
    contours,
  }));
  return { rois, refImageId };
}

/** 書き出すマスク。`segIndex` を指定するとその segment だけ（塗りの ROI 1 件）、無ければ全 segment。 */
export interface RtStructMaskRef {
  maskId: string;
  segIndex?: number;
}

export async function exportRoisAsRtStruct(uids: string[], masks: RtStructMaskRef[] = []): Promise<SegExportResult | null> {
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
    // 計測（Length/Angle/Probe 等）は書き出さない。ROI は面→CLOSED_PLANAR・線→OPEN_PLANAR・点→POINT。
    const kind = roiKindOf(tool, ann.data?.contour?.closed as boolean | undefined);
    if (!kind || kind === "measure") continue;
    const isEllipse = /^ellipticalroi$/i.test(tool);
    const isCircle = /^circleroi$/i.test(tool);
    const isRect = /^rectangleroi/i.test(tool);

    const plane = (metaData.get("imagePlaneModule", refId) as AnyObj) ?? {};
    const iop = plane.imageOrientationPatient as number[] | undefined;
    const rowCos: V3 = iop && iop.length >= 6 ? [iop[0], iop[1], iop[2]] : [1, 0, 0];
    const colCos: V3 = iop && iop.length >= 6 ? [iop[3], iop[4], iop[5]] : [0, 1, 0];
    const sop = sopOf(refId);
    if (!sop) continue;

    const handles = (ann.data?.handles?.points as V3[] | undefined) ?? [];
    const polyline = (ann.data?.contour?.polyline as V3[] | undefined) ?? [];
    let ring: V3[] = [];
    let geometricType: RtStructContour["geometricType"] = "CLOSED_PLANAR";
    if (kind === "point") {
      if (handles.length < 1) continue;
      ring = [handles[0]];
      geometricType = "POINT";
    } else if (kind === "line") {
      ring = polyline.length >= 2 ? polyline : handles;
      if (ring.length < 2) continue;
      geometricType = "OPEN_PLANAR";
    } else {
      if (isEllipse) ring = ellipsePolygon(handles);
      else if (isCircle) ring = circlePolygon(handles, rowCos, colCos);
      else if (isRect) ring = rectPolygon(handles, rowCos, colCos);
      else if (polyline.length >= 3) ring = polyline;
      else ring = handles;
      if (ring.length < 3) continue;
    }

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
      type: kind === "point" ? "MARKER" : "ORGAN",
      contours: [{ sopInstanceUid: sop, points: flatten(ring), geometricType }],
    });
  }

  for (const { maskId: id, segIndex } of masks) {
    const m = maskToRtStructRois(id, segIndex);
    if (!m.rois.length || !m.refImageId) continue;
    if (!studyUid || !seriesUid) {
      const meta = getRoiMaskMeta(id);
      const gsm = (metaData.get("generalSeriesModule", m.refImageId) as AnyObj) ?? {};
      const plane = (metaData.get("imagePlaneModule", m.refImageId) as AnyObj) ?? {};
      studyUid = meta?.scope?.studyUid ?? gsm.studyInstanceUID;
      seriesUid = meta?.scope?.seriesUid ?? gsm.seriesInstanceUID;
      forUid = plane.frameOfReferenceUID ?? undefined;
    }
    for (const r of m.rois) rois.push({ number: ++n, ...r });
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
