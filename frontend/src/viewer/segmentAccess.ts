/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** {@link SegmentAccess} の本番の実装（cornerstone・ROI マネージャのメタ）。 */
import { cache, metaData } from "@cornerstonejs/core";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import type { SegmentAccess } from "./segmentMask";
import { getMaskSegments, getRoiMaskMeta } from "./roiMaskStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = any;

function sopOf(imageId: string): string | null {
  const m = /\/instances\/([^/]+)\//.exec(imageId);
  if (m) return decodeURIComponent(m[1]);
  const sc = metaData.get("sopCommonModule", imageId) as { sopInstanceUID?: string } | undefined;
  return sc?.sopInstanceUID ?? null;
}

export const cornerstoneSegmentAccess: SegmentAccess = {
  segmentationIds: () => {
    try {
      return (csSeg.state.getSegmentations() as AnyObj[]).map((s) => String(s.segmentationId));
    } catch {
      return [];
    }
  },
  labelmapImageIds: (id) => (csSeg as AnyObj).getLabelmapImageIds?.(id) as string[] | undefined,
  referencedImageId: (lm) => (cache.getImage(lm) as AnyObj | undefined)?.referencedImageId as string | undefined,
  plane: (lm, frameSize) => {
    const vm = (cache.getImage(lm) as AnyObj | undefined)?.voxelManager;
    if (!vm) return null;
    try {
      const data = vm.getScalarData?.() as ArrayLike<number> | undefined;
      if (data && data.length >= frameSize) return data;
    } catch {
      /* 下の getAtIndex へ */
    }
    // maskFrames.extractMaskFrames と同じ流儀: スカラー配列が取れなければ 1 画素ずつ読む。
    if (typeof vm.getAtIndex !== "function") return null;
    const out = new Uint8Array(frameSize);
    for (let i = 0; i < frameSize; i++) out[i] = Number(vm.getAtIndex(i)) || 0;
    return out;
  },
  planeSize: (src) => {
    const pm = (metaData.get("imagePlaneModule", src) as AnyObj) ?? {};
    const cols = Number(pm.columns);
    const rows = Number(pm.rows);
    return cols > 0 && rows > 0 ? { cols, rows } : null;
  },
  sopOf,
  segmentsOf: (id) => getMaskSegments(id),
  metaOf: (id) => getRoiMaskMeta(id) as { label?: string; segmentLabels?: Record<string, string> } | undefined,
};
