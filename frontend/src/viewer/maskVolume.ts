/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 塗り（Mask）の体積を求める文脈をメタデータから作る（`fw/slice-depth-policy.md` §4）。
 * 計算そのものは純関数 `depthVolume.maskVolumeFromLabels`。
 */
import { cache, imageLoader, metaData } from "@cornerstonejs/core";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { resolveRoiStack } from "./roiBooleanOps";
import { sliceGeometry } from "./sliceGeometry";
import { sliceInfosOf } from "./sliceInfoMeta";
import { maskVolumeFromLabels, type MaskDepthContext, type MaskMeshVolume } from "./depthVolume";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/**
 * マスクの元画像から、奥行きの文脈を作る。labelmap が全スタックでも 1 枚だけでも、
 * 表示中のスタックが引ければそれで幅を決める（1 枚だけだと隣が分からず幅が決まらない）。
 * 元画像が 1 枚も引けなければ null。
 */
export function maskDepthContext(sourceIds: ReadonlyArray<string | undefined>): MaskDepthContext | null {
  const defined = sourceIds.filter((s): s is string => !!s);
  if (!defined.length) return null;
  const stack = resolveRoiStack(defined[0])?.sourceIds;
  const ids = stack && defined.every((d) => stack.includes(d)) ? stack : Array.from(new Set(defined));
  const geometry = sliceGeometry(sliceInfosOf(ids));
  const p: AnyObj = (metaData.get("imagePlaneModule", defined[0]) ?? {}) as AnyObj;
  const col = Number(p.columnPixelSpacing);
  const row = Number(p.rowPixelSpacing);
  const spacingKnown = Number.isFinite(col) && col > 0 && Number.isFinite(row) && row > 0;
  return {
    indexOfSource: new Map(ids.map((id, i) => [id, i])),
    geometry,
    colSp: spacingKnown ? col : 1,
    rowSp: spacingKnown ? row : 1,
    spacingKnown,
  };
}

/** スタックの IPP などのメタデータが揃っていなければ、読み込んで揃える（非同期の経路で使う）。 */
export async function ensureStackMetadata(sourceIds: ReadonlyArray<string | undefined>): Promise<void> {
  const defined = sourceIds.filter((s): s is string => !!s);
  if (!defined.length) return;
  const stack = resolveRoiStack(defined[0])?.sourceIds ?? defined;
  const missing = stack.filter((id) => !((metaData.get("imagePlaneModule", id) as AnyObj | undefined)?.imagePositionPatient));
  await Promise.all(missing.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
}

/**
 * segmentationId のマスクの体積を、labelmap を読んで求める（ウィンドウ間で渡す値用）。
 * 文脈が作れなければ null。
 */
export function maskMeshVolumeOf(segmentationId: string, segmentIndex?: number): MaskMeshVolume | null {
  let labelmapIds: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labelmapIds = (csSeg as any).getLabelmapImageIds(segmentationId) as string[];
  } catch {
    return null;
  }
  if (!labelmapIds?.length) return null;
  const sourceIds = labelmapIds.map((id) => (cache.getImage(id) as AnyObj | undefined)?.referencedImageId as string | undefined);
  const ctx = maskDepthContext(sourceIds);
  if (!ctx) return null;
  const slices: Array<{ sourceId: string; labels: ArrayLike<number>; width: number; height: number }> = [];
  for (let z = 0; z < labelmapIds.length; z++) {
    const lm = cache.getImage(labelmapIds[z]) as AnyObj | undefined;
    const vm = lm?.voxelManager;
    const sourceId = sourceIds[z];
    if (!vm || !sourceId) continue;
    const len = vm.getScalarDataLength() as number;
    const labels = new Int32Array(len);
    for (let i = 0; i < len; i++) labels[i] = vm.getAtIndex(i);
    const plane = (metaData.get("imagePlaneModule", sourceId) ?? {}) as AnyObj;
    slices.push({ sourceId, labels, width: Number(lm?.columns ?? lm?.width ?? plane.columns), height: Number(lm?.rows ?? lm?.height ?? plane.rows) });
  }
  return maskVolumeFromLabels(ctx, slices, segmentIndex);
}
