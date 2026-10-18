/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * しきい値（範囲）塗り。ダイアログ駆動で、判定値が [下限, 上限] に入る画素をアクティブ (mask, segment) に塗る。
 * Cornerstone の `thresholdSegmentationByRange` は同サイズ分岐が書かない（3.33.5）ので使わない。
 *
 * Wand と同じ流儀: 入力を変えるたびに、前回書いた画素を**元値へ戻してから**書き直す（置換）。
 * 「適用」で確定、「取消」で元に戻す。判定値は Wand と同じ（{@link valueReaderOf}）。
 */
import { cache, getEnabledElementByViewportId, imageLoader } from "@cornerstonejs/core";
import { segmentation as csSeg } from "@cornerstonejs/tools";
import { getSegEditTarget } from "./roiMaskStore";
import { ensureStackSegmentation, getLastSegViewport } from "./segmentation";
import { getModalityCalibration, resolveValueUnit } from "./pixelCalibration";
import { valueReaderOf } from "./wandTool";
import { selectInRange } from "./thresholdLogic";
import {
  openThresholdSession,
  updateThresholdSession,
  clearThresholdSession,
  getThresholdSession,
  type ThresholdSession,
} from "./thresholdStore";
import { emitToast } from "./toast";
import { tOutsideReact } from "../i18n/i18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

/** 前回書いたボクセルの元値（globalIndex=z*sliceLen+idx → priorValue）。 */
let tracked: Map<number, number> | null = null;
/** 非同期（全スライスの読み込み待ち）の追い越しを防ぐ。最新の実行だけが書く。 */
let runSeq = 0;

function labelmapIdsOf(segId: string): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return ((csSeg as any).getLabelmapImageIds?.(segId) as string[] | undefined) ?? [];
}

function restoreTracked(labelmapIds: string[], sliceLen: number): Set<number> {
  const slices = new Set<number>();
  if (!tracked) return slices;
  for (const [gi, prior] of tracked) {
    const z = Math.floor(gi / sliceLen);
    const vm = (cache.getImage(labelmapIds[z]) as AnyObj | undefined)?.voxelManager;
    if (vm) {
      vm.setAtIndex(gi - z * sliceLen, prior);
      slices.add(z);
    }
  }
  tracked = null;
  return slices;
}

function notifyModified(s: ThresholdSession, slices: Iterable<number>): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csSeg as any).triggerSegmentationEvents.triggerSegmentationDataModified(s.segId, [...slices], s.segIndex);
  } catch {
    /* ignore */
  }
}

/** 現在の入力で塗り直す（前回結果は置換）。入力に触れる前と、下限 > 上限のときは何も書かない。 */
export async function runThreshold(s: ThresholdSession): Promise<void> {
  const seq = ++runSeq;
  const labelmapIds = labelmapIdsOf(s.segId);
  if (!labelmapIds.length) return;
  const sliceLen = s.cols * s.rows;
  if (s.scope === "all") {
    await Promise.all(s.sourceImageIds.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
    if (seq !== runSeq) return;
  }
  const modified = restoreTracked(labelmapIds, sliceLen);
  const invalid = !(s.lower <= s.upper);
  if (!s.touched || invalid) {
    updateThresholdSession({ count: 0, invalid: s.touched && invalid });
    notifyModified(s, modified);
    return;
  }
  const next = new Map<number, number>();
  let count = 0;
  const zs = s.scope === "all" ? s.sourceImageIds.map((_, z) => z) : [s.sliceZ];
  for (const z of zs) {
    const img = cache.getImage(s.sourceImageIds[z]) as AnyObj | undefined;
    const vm = (cache.getImage(labelmapIds[z]) as AnyObj | undefined)?.voxelManager;
    if (!img || !vm) continue;
    const idxs = selectInRange(valueReaderOf(img, s.sourceImageIds[z]), sliceLen, s.lower, s.upper);
    for (const idx of idxs) {
      const gi = z * sliceLen + idx;
      if (!next.has(gi)) next.set(gi, vm.getAtIndex(idx));
      vm.setAtIndex(idx, s.segIndex);
    }
    if (idxs.length) modified.add(z);
    count += idxs.length;
  }
  tracked = next;
  updateThresholdSession({ count, invalid: false });
  notifyModified(s, modified);
}

/** 現在の結果を確定してダイアログを閉じる。 */
export function commitThreshold(): void {
  runSeq++;
  tracked = null;
  clearThresholdSession();
}

/** 現在の結果を取り消して（元値へ復元）ダイアログを閉じる。 */
export function cancelThreshold(): void {
  runSeq++;
  const s = getThresholdSession();
  if (s) {
    const labelmapIds = labelmapIdsOf(s.segId);
    if (labelmapIds.length) notifyModified(s, restoreTracked(labelmapIds, s.cols * s.rows));
  }
  tracked = null;
  clearThresholdSession();
}

/** 直近に操作したセグメンテーション対象タイルの、いま表示中のスライスを対象にダイアログを開く。 */
export async function openThreshold(): Promise<void> {
  commitThreshold(); // 開いたままのものは確定してから開き直す
  const last = getLastSegViewport();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const viewport = last ? (getEnabledElementByViewportId(last.viewportId)?.viewport as any) : undefined;
  const refImageId: string | undefined = viewport?.getCurrentImageId?.();
  if (!last || !viewport || !refImageId) {
    emitToast(tOutsideReact("roiMgr.needSegViewport"));
    return;
  }
  const stack = last.imageIds;
  const sliceZ = stack.indexOf(refImageId);
  const src = cache.getImage(refImageId) as AnyObj | undefined;
  if (sliceZ < 0 || !src) return;
  const segId = await ensureStackSegmentation(last.viewportId, stack);
  if (!segId) return;
  const cols = Number(src.columns ?? src.width);
  const rows = Number(src.rows ?? src.height);
  const px = src.getPixelData() as ArrayLike<number>;
  const comps = Math.max(1, Math.round(px.length / (cols * rows)));
  const read = valueReaderOf(src, refImageId);
  let rangeMin = read(0);
  let rangeMax = rangeMin;
  for (let i = 1; i < cols * rows; i++) {
    const v = read(i);
    if (v < rangeMin) rangeMin = v;
    if (v > rangeMax) rangeMax = v;
  }
  const calUnit = getModalityCalibration(src, refImageId).unit;
  const valueKind = comps >= 3 ? "luminance" : calUnit === "raw" ? "stored" : "calibrated";
  openThresholdSession({
    viewportId: last.viewportId,
    segId,
    segIndex: getSegEditTarget().segmentIndex || 1,
    sourceImageIds: stack,
    cols,
    rows,
    sliceZ,
    scope: "slice",
    lower: rangeMin,
    upper: rangeMax,
    rangeMin,
    rangeMax,
    unit: valueKind === "calibrated" ? resolveValueUnit(refImageId) : "",
    valueKind,
    touched: false,
  });
}
