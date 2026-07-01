/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * セグメンテーション（Mask=labelmap）基盤。
 *
 * ROI ブラシ/ワンド等の編集対象となる stack labelmap を、各 base ビューポートの現在 Z スタックに
 * 対応して生成・登録する。ランタイムは Cornerstone labelmap（Uint8, segment index）。保存/管理は
 * GRAPHY 同様バイナリ（DICOM SEG BINARY と対称、別途実装）。
 *
 * 設計: `fw/roi-mask-model.md`。
 */
import { imageLoader } from "@cornerstonejs/core";
import { segmentation as csSeg, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { getViewerContext } from "./viewerContext";
import { setRoiMaskMeta } from "./roiMaskStore";
import { hasPlaneMetadata } from "./segMetadata";

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;

interface SegEntry {
  segmentationId: string;
  stackKey: string;
}

const byViewport = new Map<string, SegEntry>();

/**
 * 指定ビューポートの現在 Z スタックに対応する labelmap セグメンテーションを保証し、
 * segmentationId を返す。スタックが変わったら作り直す。
 */
export async function ensureStackSegmentation(
  viewportId: string,
  sourceImageIds: string[],
): Promise<string | null> {
  if (!sourceImageIds.length) return null;
  const stackKey = sourceImageIds.join("|");
  const existing = byViewport.get(viewportId);
  if (existing && existing.stackKey === stackKey) return existing.segmentationId;

  if (existing) {
    // スタックが変わった: 旧 representation を外す（segmentation state は残るが representation を更新）。
    try {
      csSeg.removeSegmentationRepresentations(viewportId, {});
    } catch {
      /* ignore */
    }
  }

  const segmentationId = `graphy-seg-${viewportId}-${stackKey.length}`;
  try {
    // 派生 labelmap は各スライスの `imagePlaneModule`（rows/cols）だけを要し、**source 画素は不要**。
    // backend 幾何を供給する segMetadata プロバイダが登録済みなら、画素ロードゼロで即時生成できる（§3.4）。
    // 幾何が未登録の imageId（レイアウト未取得の非空間シリーズ等）のみ、その 1 枚を遅延ロードして補う。
    const missing = sourceImageIds.filter((id) => !hasPlaneMetadata(id));
    if (missing.length) {
      await Promise.all(missing.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
    }
    const labelmaps = imageLoader.createAndCacheDerivedLabelmapImages(sourceImageIds);
    const labelmapImageIds = labelmaps.map((i) => i.imageId);
    csSeg.addSegmentations([
      {
        segmentationId,
        representation: { type: LABELMAP, data: { imageIds: labelmapImageIds } },
      },
    ]);
    csSeg.addLabelmapRepresentationToViewport(viewportId, [{ segmentationId, type: LABELMAP }]);
    csSeg.activeSegmentation.setActiveSegmentation(viewportId, segmentationId);
    csSeg.segmentIndex.setActiveSegmentIndex(segmentationId, 1);
    byViewport.set(viewportId, { segmentationId, stackKey });
    // 患者・シリーズ・C/T を紐付け（z="all"＝3D ボリュームマスク）。
    const ctx = getViewerContext(viewportId);
    if (ctx) {
      const sc = { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: "all" as const, c: ctx.c, t: ctx.t };
      setRoiMaskMeta(segmentationId, { patientKey: ctx.patientKey, seriesLabel: ctx.seriesLabel, scope: sc, origin: sc });
    }
    return segmentationId;
  } catch (e) {
    console.warn("[segmentation] ensureStackSegmentation failed", e);
    return null;
  }
}

/** ビューポート破棄時のクリーンアップ。 */
export function disposeViewportSegmentation(viewportId: string): void {
  byViewport.delete(viewportId);
  try {
    csSeg.removeSegmentationRepresentations(viewportId, {});
  } catch {
    /* ignore */
  }
}
