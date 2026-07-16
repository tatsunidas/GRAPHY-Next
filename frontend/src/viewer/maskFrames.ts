/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * フレーム配列（{sopInstanceUid, imagePositionPatient, mask(0/1 Base64)} の集合）から
 * Cornerstone labelmap（Mask）を再構築する共通処理。DICOM SEG インポート（`segImport.ts`）と、
 * 将来のウィンドウ間マスク同期（`fw/mask-driven-pipelines-gap-analysis.md` 課題#1/#2, 同課題#8）の
 * 両方が同じ配線（フレーム→スライス対応→labelmap 書き込み）を共有するための土台。
 */
import { cache, imageLoader, metaData, getRenderingEngines } from "@cornerstonejs/core";
import { segmentation as csSeg, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { getViewerContext } from "./viewerContext";
import { setRoiMaskMeta, getRoiMaskMeta, getMaskSegments } from "./roiMaskStore";
import { worldToVoxel, type LabelVolume, type VolumeGeom } from "./labelVolume";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;
type V3 = [number, number, number];

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
let seq = 0;

/** フレーム 1 枚（インポート/同期の共通入力形）。 */
export interface MaskFrameSource {
  referencedSopInstanceUid: string | null;
  imagePositionPatient: V3 | null;
  /** rows*columns の 0/1 バイト列（行優先）を Base64 エンコードした文字列。 */
  mask: string;
}
/** セグメント 1 つ分（複数フレームを持つ）。 */
export interface MaskSegmentSource {
  number: number;
  label: string;
  color: [number, number, number] | null;
  description?: string | null;
  frames: MaskFrameSource[];
}
export interface MaskFramesInput {
  rows: number;
  columns: number;
  segments: MaskSegmentSource[];
}

/** 表示中の base ビューポート（source 画像を持つもの）を探す。無ければ null。 */
export function firstBaseViewport(): AnyObj | null {
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
  if (m) return decodeURIComponent(m[1]);
  const sc = metaData.get("sopCommonModule", imageId) as { sopInstanceUID?: string } | undefined;
  return sc?.sopInstanceUID ?? null;
}

function planeMeta(imageId: string): AnyObj {
  return (metaData.get("imagePlaneModule", imageId) as AnyObj) ?? {};
}

function buildSopIndex(imageIds: string[]): Map<string, number> {
  const map = new Map<string, number>();
  imageIds.forEach((id, z) => {
    const s = sopOf(id);
    if (s) map.set(s, z);
  });
  return map;
}

/** IPP 最近傍の z を返す（5mm 超は無関係スライスとみなし null）。 */
function nearestZByIpp(ipp: V3, imageIds: string[]): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (let z = 0; z < imageIds.length; z++) {
    const p = planeMeta(imageIds[z]).imagePositionPatient as V3 | undefined;
    if (!p) continue;
    const d = Math.hypot(p[0] - ipp[0], p[1] - ipp[1], p[2] - ipp[2]);
    if (d < bestDist) {
      bestDist = d;
      best = z;
    }
  }
  return best != null && bestDist <= 5 ? best : null;
}

function resolveZ(fr: MaskFrameSource, sopToId: Map<string, number>, imageIds: string[]): number | null {
  if (fr.referencedSopInstanceUid) {
    const z = sopToId.get(fr.referencedSopInstanceUid);
    if (z != null) return z;
  }
  if (fr.imagePositionPatient) return nearestZByIpp(fr.imagePositionPatient, imageIds);
  return null;
}

function base64ToU8(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * フレーム配列群を、表示中ビューポートの source スタックに対応した新規 Mask（labelmap）として書き込む。
 * rows/columns が現在シリーズと不一致（別シリーズ由来など）、または前景ゼロなら null。
 */
export async function importMaskFrames(
  vp: AnyObj,
  input: MaskFramesInput,
  label: string,
  onProgress?: (frac: number) => void,
): Promise<{ segmentationId: string; segmentCount: number } | null> {
  const imageIds = vp.getImageIds() as string[];
  if (!imageIds.length || !input.segments.length) return null;

  const pm0 = planeMeta(imageIds[0]);
  if (pm0.rows && (Number(pm0.rows) !== input.rows || Number(pm0.columns) !== input.columns)) {
    return null; // 解像度不一致（別シリーズ由来の SEG 等）
  }

  await Promise.all(imageIds.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
  const derived = imageLoader.createAndCacheDerivedLabelmapImages(imageIds);
  const labelmapIds = derived.map((d) => d.imageId);
  const sopToId = buildSopIndex(imageIds);
  const frameSize = input.rows * input.columns;

  const segmentationId = `graphy-maskimport-${++seq}`;
  csSeg.addSegmentations([
    { segmentationId, representation: { type: LABELMAP, data: { imageIds: labelmapIds } } },
  ]);
  try {
    csSeg.addLabelmapRepresentationToViewport(vp.id, [{ segmentationId, type: LABELMAP }]);
  } catch {
    /* ignore */
  }

  const segIndices: number[] = [];
  const modifiedByZ = new Map<number, Set<number>>();
  const descByIdx: Record<string, string> = {};
  for (const [segNo, seg] of input.segments.entries()) {
    const segIndex = seg.number > 0 ? seg.number : segIndices.length + 1;
    segIndices.push(segIndex);
    if (seg.description) descByIdx[String(segIndex)] = seg.description;
    for (const fr of seg.frames) {
      const z = resolveZ(fr, sopToId, imageIds);
      if (z == null) continue;
      const plane = base64ToU8(fr.mask);
      if (plane.length !== frameSize) continue;
      const vm = (cache.getImage(labelmapIds[z]) as AnyObj | undefined)?.voxelManager;
      if (!vm) continue;
      let touched = false;
      for (let i = 0; i < frameSize; i++) {
        if (plane[i] !== 0) {
          vm.setAtIndex(i, segIndex);
          touched = true;
        }
      }
      if (touched) {
        if (!modifiedByZ.has(segIndex)) modifiedByZ.set(segIndex, new Set());
        modifiedByZ.get(segIndex)!.add(z);
      }
    }
    if (seg.color) {
      try {
        (csSeg.config.color as AnyObj).setSegmentIndexColor(vp.id, segmentationId, segIndex, [...seg.color, 255]);
      } catch {
        /* ignore */
      }
    }
    onProgress?.((segNo + 1) / input.segments.length);
  }

  if (modifiedByZ.size === 0) {
    try {
      (csSeg.state as AnyObj).removeSegmentation?.(segmentationId);
    } catch {
      /* ignore */
    }
    return null;
  }

  for (const [segIndex, zs] of modifiedByZ) {
    try {
      csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(segmentationId, [...zs], segIndex);
    } catch {
      /* ignore */
    }
  }

  const ctx = getViewerContext(vp.id);
  const meta: AnyObj = { segments: segIndices, label };
  if (ctx) {
    const sc = { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: "all" as const, c: ctx.c, t: ctx.t };
    Object.assign(meta, { patientKey: ctx.patientKey, seriesLabel: ctx.seriesLabel, scope: sc, origin: sc });
  }
  if (Object.keys(descByIdx).length) meta.custom = descByIdx;
  setRoiMaskMeta(segmentationId, meta);

  return { segmentationId, segmentCount: segIndices.length };
}

function u8ToBase64(u8: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(u8.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/**
 * 既存の Mask（segmentationId）を `MaskFramesInput` 形へ抽出する（`importMaskFrames` の逆）。
 * ウィンドウ間マスク同期（`maskBridge.ts`）が、他ウィンドウへ渡すフレームデータを組み立てるのに使う。
 * 幾何が引けない（source imageId が cache に無い）スライスはスキップ。
 */
export function extractMaskFrames(segmentationId: string): MaskFramesInput | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labelmapIds = (csSeg as any).getLabelmapImageIds?.(segmentationId) as string[] | undefined;
  if (!labelmapIds?.length) return null;
  const srcIds: (string | undefined)[] = labelmapIds.map(
    (lm) => (cache.getImage(lm) as AnyObj | undefined)?.referencedImageId,
  );

  let rows = 0;
  let cols = 0;
  const ippByZ: (V3 | undefined)[] = new Array(labelmapIds.length);
  const sopByZ: (string | undefined)[] = new Array(labelmapIds.length);
  for (let z = 0; z < labelmapIds.length; z++) {
    const src = srcIds[z];
    if (!src) continue;
    const pm = planeMeta(src);
    if (!rows && pm.rows) {
      rows = Number(pm.rows);
      cols = Number(pm.columns);
    }
    const ipp = pm.imagePositionPatient as V3 | undefined;
    if (ipp) ippByZ[z] = [Number(ipp[0]), Number(ipp[1]), Number(ipp[2])];
    sopByZ[z] = sopOf(src) ?? undefined;
  }
  if (!rows || !cols) return null;
  const frameSize = rows * cols;

  const segIndices = getMaskSegments(segmentationId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vpIds = ((csSeg.state as any).getViewportIdsWithSegmentation?.(segmentationId) as string[] | undefined) ?? [];
  const vp0 = vpIds[0];
  const meta = getRoiMaskMeta(segmentationId);

  const segments: MaskSegmentSource[] = [];
  for (const segIndex of segIndices) {
    let color: [number, number, number] | null = null;
    try {
      if (vp0) {
        const c = (csSeg.config.color as AnyObj).getSegmentIndexColor(vp0, segmentationId, segIndex) as
          | number[]
          | undefined;
        if (c && c.length >= 3) color = [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
      }
    } catch {
      /* ignore */
    }
    // ウィンドウ間同期は DICOM SEG ではない（Fusion の Z レイアウト整合制約が無い）ため、
    // segExport.ts の dense 出力と異なり、前景を持つスライスのみ完全に疎で送る
    // （多セグメント×多スライスのマスクで BroadcastChannel の転送量が肥大化するのを防ぐ）。
    const frames: MaskFrameSource[] = [];
    let any = false;
    for (let z = 0; z < labelmapIds.length; z++) {
      const ipp = ippByZ[z];
      const sop = sopByZ[z];
      if (!ipp || !sop) continue;
      const vm = (cache.getImage(labelmapIds[z]) as AnyObj | undefined)?.voxelManager;
      if (!vm) continue;
      const plane = new Uint8Array(frameSize);
      let anyOnSlice = false;
      let data: ArrayLike<number> | undefined;
      try {
        data = vm.getScalarData?.() as ArrayLike<number> | undefined;
      } catch {
        /* ignore */
      }
      if (data && data.length >= frameSize) {
        for (let i = 0; i < frameSize; i++) if (data[i] === segIndex) { plane[i] = 1; anyOnSlice = true; }
      } else {
        for (let i = 0; i < frameSize; i++) if (vm.getAtIndex(i) === segIndex) { plane[i] = 1; anyOnSlice = true; }
      }
      if (!anyOnSlice) continue;
      any = true;
      frames.push({ referencedSopInstanceUid: sop, imagePositionPatient: ipp, mask: u8ToBase64(plane) });
    }
    if (!frames.length || !any) continue;
    const label = segIndices.length > 1 ? `${meta?.label ?? "Mask"} #${segIndex}` : (meta?.label ?? `Segment ${segIndex}`);
    const description = meta?.custom?.[String(segIndex)] ?? null;
    segments.push({ number: segIndex, label, color, description, frames });
  }
  if (!segments.length) return null;
  return { rows, columns: cols, segments };
}

/**
 * フレーム配列群を、3D Viewer が表示中のボリューム幾何（`geom`）に対応した `LabelVolume` へ直接
 * 変換する（`importMaskFrames` の 2D スタック版に対する 3D 版）。3D Viewer は Cornerstone
 * の 2D stack viewport を持たないため、`scene3d.addRoiObject` が受け取れる実空間 labelmap を
 * 直接組み立てる。frame の IPP を `geom` のボクセル格子上へ投影し最近傍スライスへ書き込む
 * （面内解像度・向きが一致している前提。ウィンドウ間マスク同期 `maskBridge.ts` から使う）。
 */
export function framesToLabelVolume(
  input: MaskFramesInput,
  geom: VolumeGeom,
  segmentIndex?: number,
): LabelVolume | null {
  const [nx, ny, nz] = geom.dims;
  if (nx !== input.columns || ny !== input.rows) return null; // 面内解像度不一致
  const frameSize = input.rows * input.columns;
  const data = new Uint8Array(nx * ny * nz);
  let any = false;
  for (const seg of input.segments) {
    const segIndex = seg.number > 0 ? seg.number : 1;
    if (segmentIndex != null && segIndex !== segmentIndex) continue;
    for (const fr of seg.frames) {
      if (!fr.imagePositionPatient) continue;
      const idx = worldToVoxel(geom, fr.imagePositionPatient);
      // フレーム IPP は当該スライスの voxel(0,0) 実座標のはず。面内残差が大きければ幾何不一致とみなす。
      if (Math.abs(idx[0]) > 0.5 || Math.abs(idx[1]) > 0.5) continue;
      const k = Math.round(idx[2]);
      if (k < 0 || k >= nz) continue;
      const plane = base64ToU8(fr.mask);
      if (plane.length !== frameSize) continue;
      const base = k * nx * ny;
      const writeValue = segmentIndex != null ? 1 : segIndex;
      for (let i = 0; i < frameSize; i++) {
        if (plane[i] !== 0) {
          data[base + i] = writeValue;
          any = true;
        }
      }
    }
  }
  if (!any) return null;
  const voxelMm3 = geom.spacing[0] * geom.spacing[1] * geom.spacing[2];
  return { geom, data, voxelMm3 };
}
