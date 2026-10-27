/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API の **XA シリーズ読み出し**（H42）。
 *
 * <p>2 方向のアンギオ（A・B）を 1 つのプラグイン窓で同時に扱うには、片方が開いていないシリーズでも
 * 幾何と任意フレームの画素が要る。`getPixelData` は開いているタイルだけ、`loadVolume` は
 * IPP の無い XA シネには使えない（1 フレーム分しか見積もれず null になる＝実機で確認）。
 *
 * <p>新規に計算を書いていない: 幾何は `readXaViewGeometry`（幾何の単一入口）、画素は
 * `readModalitySlice`（校正の単一入口）、imageId は `imageIdForXaFrame` に委譲する。
 *
 * <p>⚠️ 対象は**シリーズの先頭インスタンス**（XA のシネは 1 インスタンス＝マルチフレーム）。複数インスタンスの
 * シリーズは `instanceCount` で分かるようにし、黙って他を混ぜない。DSA（差分）は掛けない＝ネイティブのフレーム。
 */
import { fetchInstances } from "../api";
import { imageIdForXaFrame, xaSourceUrlOf, type ViewerMode } from "../viewer/imageId";
import { readModalitySlice } from "../viewer/pixelCalibration";
import { prewarmXaDataset, xaDataSetOf } from "../viewer/xaCine";
import { readXaViewGeometry, type XaViewGeometryResult } from "../viewer/xaViewGeometryProvider";
import type { PluginSeriesRef } from "./pluginTypes";

type StudyResolver = (seriesUid: string) => string | undefined;

export interface PluginXaSeriesInfo extends XaViewGeometryResult {
  seriesUid: string;
  studyUid: string;
  sopInstanceUid: string;
  /** シリーズのインスタンス数。1 より大きいとき、ここで扱うのは先頭だけ。 */
  instanceCount: number;
  /** 先頭インスタンスのフレーム数。タグから読めなければ null（1 で埋めない）。 */
  frameCount: number | null;
  rows: number | null;
  cols: number | null;
}

export interface PluginXaSeriesFrame {
  seriesUid: string;
  frameIndex: number;
  rows: number;
  cols: number;
  /** 校正済みの画素（行優先）。表示 W/L は掛かっていない。 */
  data: Float32Array;
  unit: string;
}

function resolveStudy(ref: PluginSeriesRef, resolver: StudyResolver): string | null {
  return ref.studyUid ?? resolver(ref.seriesUid) ?? null;
}

function toNum(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** シリーズの先頭インスタンスの幾何・フレーム数・画像サイズ。読めない部分は null（理由は `missing`）。 */
export async function readXaSeriesInfo(
  mode: ViewerMode,
  resolver: StudyResolver,
  ref: PluginSeriesRef,
): Promise<PluginXaSeriesInfo | null> {
  const studyUid = resolveStudy(ref, resolver);
  if (!studyUid) return null;
  const instances = await fetchInstances(studyUid, ref.seriesUid);
  if (!instances.length) return null;
  const sop = instances[0].sopInstanceUid;
  const imageId0 = imageIdForXaFrame(mode, sop, 0, studyUid, ref.seriesUid);
  try {
    await prewarmXaDataset(imageId0);
  } catch {
    /* 取れなければ missing: "noDataSet" として返す（下の幾何） */
  }
  const geo = readXaViewGeometry(imageId0, 0);
  const ds = xaDataSetOf(imageId0);
  const nf = ds ? toNum(ds.intString("x00280008")) : null;
  const rows = ds ? toNum(ds.uint16("x00280010")) : null;
  const cols = ds ? toNum(ds.uint16("x00280011")) : null;
  return {
    ...geo,
    seriesUid: ref.seriesUid,
    studyUid,
    sopInstanceUid: sop,
    instanceCount: instances.length,
    frameCount: nf != null && nf > 0 ? nf : null,
    rows,
    cols,
  };
}

/** シリーズの先頭インスタンスの `frameIndex`（0 origin）フレームの校正済み画素。範囲外・取得不能は null。 */
export async function readXaSeriesFrame(
  mode: ViewerMode,
  resolver: StudyResolver,
  ref: PluginSeriesRef,
  frameIndex: number,
): Promise<PluginXaSeriesFrame | null> {
  if (!Number.isInteger(frameIndex) || frameIndex < 0) return null;
  const info = await readXaSeriesInfo(mode, resolver, ref);
  if (!info) return null;
  // フレーム数が分かっていて範囲外なら、黙って別フレームにせず拒否する。
  if (info.frameCount != null && frameIndex >= info.frameCount) return null;
  const imageId = imageIdForXaFrame(mode, info.sopInstanceUid, frameIndex, info.studyUid, ref.seriesUid);
  if (!xaSourceUrlOf(imageId)) return null;
  const slice = await readModalitySlice(imageId);
  if (!slice) return null;
  return {
    seriesUid: ref.seriesUid,
    frameIndex,
    rows: slice.height,
    cols: slice.width,
    data: slice.values,
    unit: slice.unit,
  };
}
