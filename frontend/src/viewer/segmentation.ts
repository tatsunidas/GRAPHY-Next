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
 * D2（モードレス化）: どのマスク/segment に塗るかは **アクティブ編集対象**（`roiMaskStore` の SegEditTarget）で決まる。
 * D3（多セグメント）: 1 マスク（labelmap）に複数 segment index を持てる。
 * D1（軽量ルート）: 3D ツールはライブラリが on-demand で volume 化して動く（VolumeViewport 不要）。
 *
 * 設計: `fw/roi-mask-model.md` / `fw/segmentation-tools-design.md`。
 */
import { imageLoader } from "@cornerstonejs/core";
import { segmentation as csSeg, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { getViewerContext } from "./viewerContext";
import {
  setRoiMaskMeta,
  getSegEditTarget,
  setActiveSegmentationId,
  setActiveSegmentIndexStore,
  getMaskSegments,
  addMaskSegment,
} from "./roiMaskStore";
import { hasPlaneMetadata } from "./segMetadata";

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;

interface StackEntry {
  stackKey: string;
  segIds: string[]; // この viewport+stack に登録済みのマスク（作成順）
}

const byViewport = new Map<string, StackEntry>();
let seq = 0;

/** 直近でセグメンテーション操作/フォーカスしたビューポート（パネルの「＋新規マスク」用）。 */
let lastSegViewport: { viewportId: string; imageIds: string[] } | null = null;
export function getLastSegViewport(): { viewportId: string; imageIds: string[] } | null {
  return lastSegViewport;
}
/** フォーカス中タイルを記録（base ビューポートの pointerdown で呼ぶ）。新規マスクの対象になる。 */
export function noteSegViewport(viewportId: string, imageIds: string[]): void {
  if (imageIds.length) lastSegViewport = { viewportId, imageIds };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const segState = csSeg.state as any;

function segExists(segmentationId: string): boolean {
  try {
    return !!segState.getSegmentation?.(segmentationId);
  } catch {
    return false;
  }
}

function viewportIdsOf(segmentationId: string): string[] {
  try {
    return (segState.getViewportIdsWithSegmentation?.(segmentationId) as string[] | undefined) ?? [];
  } catch {
    return [];
  }
}

/** アクティブ segment index を Cornerstone とストア双方へ設定。 */
function applyActiveSegmentIndex(segmentationId: string, index: number): void {
  try {
    csSeg.segmentIndex.setActiveSegmentIndex(segmentationId, index);
  } catch {
    /* ignore */
  }
  setActiveSegmentIndexStore(index);
}

/**
 * 指定マスクをアクティブ（編集対象）にする。CS の active segmentation ＋ストアを同期。
 * `viewportId` を渡すと、作りたてで `getViewportIdsWithSegmentation` がまだ空を返す場合でも
 * その既知ビューポートに確実に active segmentation を設定する（+新規マスク直後の塗り先ズレ防止）。
 */
export function activateMask(segmentationId: string, segmentIndex?: number, viewportId?: string): void {
  const vps = new Set(viewportIdsOf(segmentationId));
  if (viewportId) vps.add(viewportId);
  for (const vp of vps) {
    try {
      csSeg.activeSegmentation.setActiveSegmentation(vp, segmentationId);
    } catch {
      /* ignore */
    }
  }
  setActiveSegmentationId(segmentationId);
  const idx = segmentIndex ?? getMaskSegments(segmentationId)[0] ?? 1;
  applyActiveSegmentIndex(segmentationId, idx);
}

/** 現在 Z スタックに対応する新規 labelmap マスクを生成・登録し、segmentationId を返す（画素プリロード不要）。 */
async function createStackSeg(viewportId: string, sourceImageIds: string[], stackKey: string): Promise<string | null> {
  const segmentationId = `graphy-seg-${viewportId}-${stackKey.length}-${seq++}`;
  // 派生 labelmap は各スライスの `imagePlaneModule`（rows/cols）だけを要し、**source 画素は不要**。
  // 幾何が未登録の imageId（レイアウト未取得の非空間シリーズ等）のみ、その 1 枚を遅延ロードして補う。
  const missing = sourceImageIds.filter((id) => !hasPlaneMetadata(id));
  if (missing.length) {
    await Promise.all(missing.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
  }
  const labelmaps = imageLoader.createAndCacheDerivedLabelmapImages(sourceImageIds);
  const labelmapImageIds = labelmaps.map((i) => i.imageId);
  csSeg.addSegmentations([
    { segmentationId, representation: { type: LABELMAP, data: { imageIds: labelmapImageIds } } },
  ]);
  csSeg.addLabelmapRepresentationToViewport(viewportId, [{ segmentationId, type: LABELMAP }]);
  // 患者・シリーズ・C/T を紐付け（z="all"＝3D ボリュームマスク）。segment #1 を既定。
  const ctx = getViewerContext(viewportId);
  const meta: Parameters<typeof setRoiMaskMeta>[1] = { segments: [1] };
  if (ctx) {
    const sc = { studyUid: ctx.studyUid, seriesUid: ctx.seriesUid, z: "all" as const, c: ctx.c, t: ctx.t };
    Object.assign(meta, { patientKey: ctx.patientKey, seriesLabel: ctx.seriesLabel, scope: sc, origin: sc });
  }
  setRoiMaskMeta(segmentationId, meta);
  const entry = byViewport.get(viewportId);
  if (entry && entry.stackKey === stackKey) entry.segIds.push(segmentationId);
  else byViewport.set(viewportId, { stackKey, segIds: [segmentationId] });
  return segmentationId;
}

/**
 * 塗りツール起動時に呼ぶ。**アクティブ編集対象**を現在スタックに対して保証し、segmentationId を返す。
 * - アクティブマスクが既にこのビューポート＋スタックに存在 → それをアクティブ化して返す。
 * - このスタックにマスクがあれば先頭を、無ければ新規作成してアクティブ化。
 */
export async function ensureStackSegmentation(
  viewportId: string,
  sourceImageIds: string[],
): Promise<string | null> {
  if (!sourceImageIds.length) return null;
  const stackKey = sourceImageIds.join("|");
  lastSegViewport = { viewportId, imageIds: sourceImageIds };

  const existing = byViewport.get(viewportId);
  if (existing && existing.stackKey !== stackKey) {
    // スタックが変わった: 旧 representation を外す。segIds はリセット（別スタックの labelmap は非対応）。
    try {
      csSeg.removeSegmentationRepresentations(viewportId, {});
    } catch {
      /* ignore */
    }
    byViewport.delete(viewportId);
  }

  const entry = byViewport.get(viewportId);
  const target = getSegEditTarget();

  // アクティブ対象がこの viewport に属する（representation を持つ or byViewport 登録済み）なら、それを使う。
  // ※ byViewport 管理下に限定しない（Split/ブール演算/ROI→Mask の結果マスクは createResultSeg 経由で
  //   byViewport 未登録だが、パネル ◉ でアクティブ化される）。逆に「+新規マスク」直後は getViewportIds が
  //   まだ空でも byViewport には登録済みなので、そちらでも拾う（アクティブが旧マスクへズレるのを防ぐ）。
  if (
    target.segmentationId &&
    segExists(target.segmentationId) &&
    (viewportIdsOf(target.segmentationId).includes(viewportId) || !!entry?.segIds.includes(target.segmentationId))
  ) {
    activateMask(target.segmentationId, target.segmentIndex, viewportId);
    return target.segmentationId;
  }

  // このスタックに既存マスクがあれば先頭をアクティブ化、無ければ新規作成。
  try {
    const reuse = entry?.segIds.find((id) => segExists(id));
    if (reuse) {
      activateMask(reuse, undefined, viewportId);
      return reuse;
    }
    const created = await createStackSeg(viewportId, sourceImageIds, stackKey);
    if (created) activateMask(created, 1, viewportId);
    return created;
  } catch (e) {
    console.warn("[segmentation] ensureStackSegmentation failed", e);
    return null;
  }
}

/** 明示的に新規マスクを作成してアクティブ化（パネルの「＋新規マスク」）。 */
export async function createNewMask(viewportId: string, sourceImageIds: string[]): Promise<string | null> {
  if (!sourceImageIds.length) return null;
  const stackKey = sourceImageIds.join("|");
  lastSegViewport = { viewportId, imageIds: sourceImageIds };
  try {
    const created = await createStackSeg(viewportId, sourceImageIds, stackKey);
    if (created) activateMask(created, 1, viewportId);
    return created;
  } catch (e) {
    console.warn("[segmentation] createNewMask failed", e);
    return null;
  }
}

/** アクティブマスクに次の segment index を追加してアクティブ segment にする（「＋セグメント」）。 */
export function addSegmentToActiveMask(): number | null {
  const target = getSegEditTarget();
  if (!target.segmentationId) return null;
  const segs = getMaskSegments(target.segmentationId);
  const next = (segs[segs.length - 1] ?? 0) + 1;
  addMaskSegment(target.segmentationId, next);
  applyActiveSegmentIndex(target.segmentationId, next);
  return next;
}

/** ビューポート破棄時のクリーンアップ。 */
export function disposeViewportSegmentation(viewportId: string): void {
  byViewport.delete(viewportId);
  if (lastSegViewport?.viewportId === viewportId) lastSegViewport = null;
  try {
    csSeg.removeSegmentationRepresentations(viewportId, {});
  } catch {
    /* ignore */
  }
}
