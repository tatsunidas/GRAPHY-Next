/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API `roiTimeSeries`: ROI の形を 4D シリーズの**全時相**に同じ画素領域で当て、
 * 時相ごとの平均・SD・画素数・経過秒を返す。
 *
 * <p>統計は本体の統計エンジン（{@link computeRoiStatsFrom}）に委譲する。プラグインが画素の内外判定を
 * 再実装すると、画面の ROI 統計と数値が食い違う。
 *
 * <p>🔴 **欠損は欠損のまま返す。** 読めない時相・領域に画素が無い時相は `mean/sd = null`・`n = 0`
 * とし、0 や隣の時相の値で埋めない（埋めた値は「増強が無い」という所見に化ける）。
 * 経過秒が不明なら `timeSec = null`（秒を作らない）。
 *
 * <p>⚠ **動き補正はしない。** 同じ画素領域を全時相に当てるだけなので、呼吸・体動で病変が動く
 * 検査では領域内の組織が時相ごとに変わる。
 */
import { fetchSeriesLayout } from "../api";
import { buildLayoutFromDto, type SeriesLayout } from "../viewer/seriesLayout";
import { readModalitySlice, resolveValueUnit, type ModalitySlice } from "../viewer/pixelCalibration";
import { computeRoiStatsFrom, pickSampleKind } from "../viewer/roiStats";
import type { ViewerTileRoi } from "../viewer/viewerCommands";

export interface PluginRoiTimePoint {
  /** 0 始まりの時相番号。 */
  t: number;
  /** 先頭の取得からの経過秒。時刻が無いシリーズでは null。 */
  timeSec: number | null;
  /** 領域内の平均。読めない・画素が無い時相は null。 */
  mean: number | null;
  sd: number | null;
  /** 領域内の画素数。欠損の時相は 0。 */
  n: number;
}

export interface PluginRoiTimeSeries {
  roiUid: string;
  tileId: string;
  c: number;
  /** ROI が乗っているスライス（0 始まり）。 */
  z: number;
  /** 値の単位（"HU" / "raw" 等）。 */
  unit: string;
  /** 経過秒の出所（"AcquisitionTime" / "TriggerTime"）。無ければ null。 */
  timeSource: string | null;
  points: PluginRoiTimePoint[];
  /** 例: `unreadable@3`, `no-pixels@3`, `roi-exceeds-image@3`。 */
  warnings: string[];
}

export type PluginRoiTimeSeriesResult =
  | ({ ok: true } & PluginRoiTimeSeries)
  | { ok: false; error: string };

type SliceReader = (imageId: string) => Promise<ModalitySlice | null>;

export interface RoiTimeSeriesInput {
  roi: Pick<ViewerTileRoi, "roiUid" | "tileId" | "tool" | "points" | "spacing" | "sliceIndex" | "zScope" | "c">;
  /** 輪郭が閉じているか（`data.contour.closed`）。不明なら undefined。 */
  closed?: boolean;
  layout: Pick<SeriesLayout, "nT" | "zStack" | "timeSecAt" | "timeSource" | "stackAxis">;
  readSlice: SliceReader;
  /** 単位の解決（読み込み後の imageId を渡す）。 */
  unitOf: (imageId: string) => string;
}

/** 純関数ではないが Cornerstone に触れない（読み出しは注入）。 */
export async function computeRoiTimeSeries(input: RoiTimeSeriesInput): Promise<PluginRoiTimeSeriesResult> {
  const { roi, layout } = input;
  if (layout.stackAxis === "t") return { ok: false, error: "cine series (frame axis) is not supported" };
  if (layout.nT <= 1) return { ok: false, error: "series has a single time point" };
  if (roi.zScope === "all") {
    return { ok: false, error: "global ROI (all slices) has no definite slice position" };
  }
  if (pickSampleKind(roi.tool, input.closed) !== "area") {
    return { ok: false, error: "only area ROIs are supported" };
  }
  const z = roi.sliceIndex;
  const c = roi.c;
  const warnings: string[] = [];
  const points: PluginRoiTimePoint[] = [];
  let unit = "";
  for (let t = 0; t < layout.nT; t++) {
    const timeSec = layout.timeSecAt?.(c, z, t) ?? null;
    const imageId = layout.zStack(c, t)[z];
    const slice = imageId ? await input.readSlice(imageId) : null;
    if (!imageId || !slice) {
      warnings.push(`unreadable@${t}`);
      points.push({ t, timeSec, mean: null, sd: null, n: 0 });
      continue;
    }
    if (!unit) unit = input.unitOf(imageId);
    if (roi.points.some(([x, y]) => x < 0 || y < 0 || x > slice.width - 1 || y > slice.height - 1)) {
      warnings.push(`roi-exceeds-image@${t}`);
    }
    // 画像と全く重ならない ROI は欠損にする。統計エンジンは「1 画素も入らない小さな ROI」を
    // 最寄り画素で代表させ、画像の外は端へ丸めるので、そのまま渡すと端の画素の値が返ってしまう。
    const xs = roi.points.map((p) => p[0]);
    const ys = roi.points.map((p) => p[1]);
    if (Math.max(...xs) < 0 || Math.min(...xs) > slice.width || Math.max(...ys) < 0 || Math.min(...ys) > slice.height) {
      warnings.push(`no-pixels@${t}`);
      points.push({ t, timeSec, mean: null, sd: null, n: 0 });
      continue;
    }
    const stats = computeRoiStatsFrom({
      roiUid: roi.roiUid,
      tool: roi.tool,
      imageId,
      pointsPx: roi.points,
      closed: input.closed,
      slice,
      unit: slice.unit,
      spacingX: roi.spacing[0],
      spacingY: roi.spacing[1],
    });
    if (!stats.values) {
      warnings.push(`no-pixels@${t}`);
      points.push({ t, timeSec, mean: null, sd: null, n: 0 });
      continue;
    }
    points.push({ t, timeSec, mean: stats.values.mean, sd: stats.values.sd, n: stats.values.n });
  }
  return {
    ok: true,
    roiUid: roi.roiUid,
    tileId: roi.tileId,
    c,
    z,
    unit,
    timeSource: layout.timeSource ?? null,
    points,
    warnings,
  };
}

export interface RoiTimeSeriesDeps {
  mode: "standalone" | "web";
  getRois: (tileId?: string) => ViewerTileRoi[];
  /** ROI の輪郭が閉じているか（annotation から）。 */
  closedOf: (roiUid: string) => boolean | undefined;
  /** シリーズ UID → スタディ UID（開いているタイルから）。 */
  studyUidOfSeries: (seriesUid: string) => string | undefined;
}

/** host の実体: ROI を探し、シリーズのレイアウトを組み、画素を読んで {@link computeRoiTimeSeries} へ。 */
export async function roiTimeSeries(
  deps: RoiTimeSeriesDeps,
  tileId: string | undefined,
  roiUid: string,
): Promise<PluginRoiTimeSeriesResult> {
  const roi = deps.getRois(tileId).find((r) => r.roiUid === roiUid);
  if (!roi) return { ok: false, error: "ROI not found" };
  const studyUid = roi.studyUid || deps.studyUidOfSeries(roi.seriesUid);
  if (!studyUid) return { ok: false, error: "study of the ROI's series is not open" };
  let layout: SeriesLayout | null = null;
  try {
    layout = buildLayoutFromDto(await fetchSeriesLayout(studyUid, roi.seriesUid), deps.mode, studyUid, roi.seriesUid);
  } catch {
    layout = null;
  }
  if (!layout) return { ok: false, error: "series layout is not available" };
  return computeRoiTimeSeries({
    roi,
    closed: deps.closedOf(roiUid),
    layout,
    readSlice: readModalitySlice,
    unitOf: resolveValueUnit,
  });
}
