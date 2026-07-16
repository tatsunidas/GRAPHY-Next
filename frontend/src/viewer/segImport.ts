/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM SEG 読込 → Cornerstone labelmap（Mask）復元。
 *
 * backend `/api/dicom/seg` が返すセグメント毎のマスク平面を、**表示中の source シリーズ**へ Mask
 * として復元する。RTSTRUCT インポート（`rtstructImport.ts`）が注釈（ROI）を復元するのに対し、こちらは
 * ラスタ（Mask）を直接復元するため、以後 3D Viewer の SceneObjectPanel / 中心線解析 / Volumetry から
 * 手動ラスタ化なしにそのまま利用できる（`fw/mask-driven-pipelines-gap-analysis.md` 課題#2/#3）。
 * 現在表示中スタディの SEG シリーズ（Modality=SEG）をまとめて取り込む。
 */
import { fetchSeries, readDicomSeg } from "../api";
import { getViewerContext } from "./viewerContext";
import { firstBaseViewport, importMaskFrames } from "./maskFrames";

/**
 * 表示中スタディの SEG シリーズをすべて読み、表示中 source シリーズへ Mask を復元する。
 * 復元したセグメント総数を返す（0 なら対象 SEG 無し or 解像度不一致等で復元不可）。
 * `onProgress`（0〜1）は SEG シリーズ数と各シリーズ内のセグメント処理数から進捗率を算出して通知する
 * （RoiManagerPanel の SEG⬆ ボタンの円形プログレス表示向け）。
 */
export async function importSegForCurrentView(onProgress?: (frac: number) => void): Promise<number> {
  const vp = firstBaseViewport();
  const ctx = vp ? getViewerContext(vp.id) : null;
  if (!vp || !ctx?.studyUid) return 0;
  const seriesList = await fetchSeries(ctx.studyUid).catch(() => []);
  const segSeries = seriesList.filter((s) => (s.modality ?? "").toUpperCase() === "SEG");
  if (!segSeries.length) return 0;

  let total = 0;
  const seriesCount = segSeries.length;
  for (const [i, s] of segSeries.entries()) {
    const result = await readDicomSeg(ctx.studyUid, s.seriesInstanceUid).catch(() => null);
    if (!result || !result.segments.length) {
      onProgress?.((i + 1) / seriesCount);
      continue;
    }
    const label = s.seriesDescription?.trim() || "SEG";
    const res = await importMaskFrames(vp, result, label, (segFrac) => onProgress?.((i + segFrac) / seriesCount));
    if (res) total += res.segmentCount;
    onProgress?.((i + 1) / seriesCount);
  }
  return total;
}
