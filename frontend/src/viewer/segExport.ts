/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * マスク（labelmap）→ DICOM SEG 書き出しリクエストの組み立て（frontend 側）。
 * 各 segment index の**非空スライス**を 0/1 平面にして Base64 化し、参照 source スライスの
 * SOPInstanceUID・IPP・幾何を metadata から解決して backend `/api/dicom/seg` へ送る。
 * 設計 `fw/dicom-seg-rtstruct-design.md` S1。
 */
import { cache, metaData } from "@cornerstonejs/core";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { getRoiMaskMeta, getMaskSegments } from "./roiMaskStore";
import { maskVolumeStats } from "./roi3d";
import { exportDicomSeg, type SegExportRequest, type SegExportSegment, type SegExportFrame, type SegExportResult } from "../api";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;
type V3 = [number, number, number];

/** Uint8Array → Base64。 */
function u8ToBase64(u8: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/** source imageId から SOPInstanceUID を得る（wadouri URL or metadata）。 */
function sopOf(imageId: string): string | null {
  const m = /\/instances\/([^/]+)\//.exec(imageId);
  if (m) return decodeURIComponent(m[1]);
  const sc = metaData.get("sopCommonModule", imageId) as { sopInstanceUID?: string } | undefined;
  return sc?.sopInstanceUID ?? null;
}

function planeMeta(imageId: string): AnyObj {
  return (metaData.get("imagePlaneModule", imageId) as AnyObj) ?? {};
}

function dist(a: V3, b: V3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** マスクを DICOM SEG として書き出す。成功時 { seriesInstanceUid }、対象が空/幾何不明なら null。 */
export async function exportMaskAsSeg(segmentationId: string): Promise<SegExportResult | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labelmapIds = (csSeg as any).getLabelmapImageIds?.(segmentationId) as string[] | undefined;
  if (!labelmapIds?.length) return null;

  // 各 z の source imageId（派生 labelmap の referencedImageId）。
  const srcIds: (string | undefined)[] = labelmapIds.map((lm) => (cache.getImage(lm) as AnyObj | undefined)?.referencedImageId);

  // 幾何（最初の解決可能な source から）。
  let rows = 0, cols = 0;
  let iop: number[] | undefined;
  let ps: [number, number] | undefined; // [row, col]
  let forUid: string | undefined;
  const ippByZ: (V3 | undefined)[] = new Array(labelmapIds.length);
  const sopByZ: (string | undefined)[] = new Array(labelmapIds.length);
  for (let z = 0; z < labelmapIds.length; z++) {
    const src = srcIds[z];
    if (!src) continue;
    const pm = planeMeta(src);
    if (!rows && pm.rows) {
      rows = Number(pm.rows);
      cols = Number(pm.columns);
      iop = (pm.imageOrientationPatient as number[]) ?? undefined;
      const psRow = Number(pm.rowPixelSpacing ?? (pm.pixelSpacing?.[0]) ?? 1);
      const psCol = Number(pm.columnPixelSpacing ?? (pm.pixelSpacing?.[1]) ?? 1);
      ps = [psRow, psCol];
      forUid = pm.frameOfReferenceUID ?? undefined;
    }
    const ipp = pm.imagePositionPatient as V3 | undefined;
    if (ipp) ippByZ[z] = [Number(ipp[0]), Number(ipp[1]), Number(ipp[2])];
    sopByZ[z] = sopOf(src) ?? undefined;
  }
  if (!rows || !cols || !iop || iop.length < 6 || !ps) return null;

  // スライス厚 = 隣接 source IPP 間距離（無ければ metadata の sliceThickness）。
  let thickness = 1;
  const zs = ippByZ.map((p, z) => ({ p, z })).filter((e) => e.p) as { p: V3; z: number }[];
  if (zs.length >= 2) thickness = dist(zs[0].p, zs[1].p) || 1;
  else {
    const anySrc = srcIds.find(Boolean);
    if (anySrc) thickness = Number(planeMeta(anySrc).sliceThickness ?? 1) || 1;
  }

  // study/series は作成時 scope から（fallback: metadata）。
  const meta = getRoiMaskMeta(segmentationId);
  const firstSrc = srcIds.find(Boolean);
  const gsm = firstSrc ? (metaData.get("generalSeriesModule", firstSrc) as AnyObj) ?? {} : {};
  const studyUid = meta?.scope?.studyUid ?? gsm.studyInstanceUID;
  const seriesUid = meta?.scope?.seriesUid ?? gsm.seriesInstanceUID;
  if (!studyUid || !seriesUid) return null;

  const frameSize = rows * cols;
  const segIndices = getMaskSegments(segmentationId);
  const vpIds = ((csSeg.state as AnyObj).getViewportIdsWithSegmentation?.(segmentationId) as string[] | undefined) ?? [];
  const vp0 = vpIds[0];

  const segments: SegExportSegment[] = [];
  for (const segIndex of segIndices) {
    // 色（アクティブ viewport の segment 色）。
    let color: [number, number, number] | null = null;
    try {
      if (vp0) {
        const c = (csSeg.config.color as AnyObj).getSegmentIndexColor(vp0, segmentationId, segIndex) as number[] | undefined;
        if (c && c.length >= 3) color = [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
      }
    } catch { /* ignore */ }

    // dense: 幾何が解決できる全スライスをフレーム化（マスク無しは全 0 平面）。
    // → SEG の Z レイアウトが元シリーズと 1:1 一致し、Fusion 重ね合わせが合う（fw §3.1'）。
    const frames: SegExportFrame[] = [];
    let anyOverall = false;
    for (let z = 0; z < labelmapIds.length; z++) {
      const lm = cache.getImage(labelmapIds[z]) as AnyObj | undefined;
      const vm = lm?.voxelManager;
      const ipp = ippByZ[z];
      const sop = sopByZ[z];
      if (!ipp || !sop) continue; // 幾何が引けないスライスはスキップ（frame 化不可）
      const plane = new Uint8Array(frameSize);
      if (vm) {
        let data: ArrayLike<number> | undefined;
        try { data = vm.getScalarData?.() as ArrayLike<number> | undefined; } catch { /* ignore */ }
        if (data && data.length >= frameSize) {
          for (let i = 0; i < frameSize; i++) if (data[i] === segIndex) { plane[i] = 1; anyOverall = true; }
        } else {
          for (let i = 0; i < frameSize; i++) if (vm.getAtIndex(i) === segIndex) { plane[i] = 1; anyOverall = true; }
        }
      }
      frames.push({ sopInstanceUid: sop, imagePositionPatient: ipp, mask: u8ToBase64(plane) });
    }
    if (!frames.length || !anyOverall) continue; // 前景ゼロの segment は出さない
    const label = segIndices.length > 1 ? `${meta?.label ?? "Mask"} #${segIndex}` : (meta?.label ?? `Segment ${segIndex}`);
    // Volumetry（体積計測）結果を SegmentDescription として書き込み、SEG 単体で持ち運べるようにする
    // （`fw/mask-driven-pipelines-gap-analysis.md` 課題#4。SEG インポート側で meta.custom へ復元）。
    const vol = maskVolumeStats(segmentationId, segIndex);
    const description = vol ? `Volume: ${vol.volumeMl.toFixed(2)} mL (${vol.voxels} voxels, ${vol.slices} slices)` : null;
    segments.push({ number: segIndex, label, color, description, frames });
  }
  if (!segments.length) return null;

  const req: SegExportRequest = {
    studyInstanceUid: studyUid,
    seriesInstanceUid: seriesUid,
    rows,
    columns: cols,
    imageOrientationPatient: iop,
    pixelSpacing: ps,
    sliceThickness: thickness,
    frameOfReferenceUID: forUid ?? null,
    seriesDescription: meta?.label ? `SEG: ${meta.label}` : "Segmentation",
    segments,
  };
  return exportDicomSeg(req);
}
