/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM RTSTRUCT 読込 → 塗り（Mask）の復元。
 *
 * backend `/api/dicom/rtstruct` が返す構造（患者座標 mm の輪郭群）を、**表示中の source シリーズ**へ
 * 構造ごとに 1 つの Mask（labelmap の segment 1）として復元する。穴は別の閉輪郭で入っているので、
 * 輪郭ごとに ROI にして足すと穴が埋まる。同じスライスの閉輪郭をまとめて偶奇判定で塗る
 * （`rtstructRaster.ts`）。スライスは ContourImage の ReferencedSOPInstanceUID を表示中スタックに
 * 対応付けて決め、見つからない輪郭は別のスライスに置かず読み飛ばす。
 * 現在表示中スタディの RTSTRUCT シリーズ（Modality=RTSTRUCT）をまとめて取り込む。
 */
import { cache, getRenderingEngines } from "@cornerstonejs/core";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { getViewerContext } from "./viewerContext";
import { setRoiMaskMeta } from "./roiMaskStore";
import { createResultSeg, setScopeZFromForeground } from "./roiBooleanOps";
import { worldToImageCoords } from "./imageCoords";
import { rasterizeStructure } from "./rtstructRaster";
import { fetchSeries, readDicomRtStruct, type RtStructImportRoi } from "../api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

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

export interface RtStructImportResult {
  /** 復元した構造（Mask）の数。 */
  structureCount: number;
  /** 閉輪郭ではないため塗らなかった輪郭数（OPEN_PLANAR / POINT など）。 */
  skippedNotClosed: number;
  /** 参照スライスが表示中シリーズに無く読み飛ばした輪郭数。 */
  skippedNoSlice: number;
}

/** 構造 1 つを表示中スタックへ Mask として復元。前景が無ければ null。 */
async function restoreStructure(
  roi: RtStructImportRoi,
  vp: AnyObj,
  res: RtStructImportResult,
): Promise<boolean> {
  const imageIds = vp.getImageIds() as string[];
  const ctx = getViewerContext(vp.id);
  const sopToZ = new Map<string, number>();
  imageIds.forEach((id, z) => {
    const s = sopOf(id);
    if (s) sopToZ.set(s, z);
  });
  const first = cache.getImage(imageIds[0]) as AnyObj | undefined;
  const cols = (first?.columns ?? first?.width) as number;
  const rows = (first?.rows ?? first?.height) as number;
  if (!cols || !rows) return false;

  const r = rasterizeStructure(
    roi.contours,
    sopToZ,
    (z, w) => worldToImageCoords(imageIds[z], w),
    cols,
    rows,
  );
  res.skippedNotClosed += r.skippedNotClosed;
  res.skippedNoSlice += r.skippedNoSlice;
  if (!r.slices.size) return false;

  const made = await createResultSeg(imageIds, [vp.id], roi.name, "");
  if (!made) return false;
  const zs: number[] = [];
  for (const [z, fg] of r.slices) {
    const vm = (cache.getImage(made.labelmapIds[z]) as AnyObj | undefined)?.voxelManager;
    if (!vm) continue;
    for (let i = 0; i < fg.length; i++) if (fg[i]) vm.setAtIndex(i, 1);
    zs.push(z);
  }
  if (!zs.length) return false;
  csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(made.segId, zs, 1);
  const zMin = Math.min(...zs);
  const scope = ctx
    ? { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: zMin, c: ctx.c, t: ctx.t }
    : undefined;
  setRoiMaskMeta(made.segId, {
    patientKey: ctx?.patientKey,
    seriesLabel: ctx?.seriesLabel,
    scope,
    origin: scope,
    label: roi.name,
    segmentLabels: { "1": roi.name },
  });
  setScopeZFromForeground(made.segId, imageIds, zs);
  if (roi.color && roi.color.length >= 3) {
    try {
      (csSeg.config.color as AnyObj).setSegmentIndexColor(vp.id, made.segId, 1, [roi.color[0], roi.color[1], roi.color[2], 255]);
    } catch { /* ignore */ }
  }
  return true;
}

/**
 * 表示中スタディの RTSTRUCT シリーズをすべて読み、表示中 source シリーズへ構造ごとの Mask を復元する。
 * structureCount=0 なら対象 RTSTRUCT 無し or 復元不可。
 */
export async function importRtStructForCurrentView(): Promise<RtStructImportResult> {
  const res: RtStructImportResult = { structureCount: 0, skippedNotClosed: 0, skippedNoSlice: 0 };
  const vp = firstBaseViewport();
  const ctx = vp ? getViewerContext(vp.id) : null;
  if (!vp || !ctx?.studyUid) return res;
  const seriesList = await fetchSeries(ctx.studyUid).catch(() => []);
  const rtSeries = seriesList.filter((s) => (s.modality ?? "").toUpperCase() === "RTSTRUCT");
  for (const s of rtSeries) {
    const rois = await readDicomRtStruct(ctx.studyUid, s.seriesInstanceUid).catch(() => []);
    for (const roi of rois) {
      if (await restoreStructure(roi, vp, res)) res.structureCount++;
    }
  }
  return res;
}
