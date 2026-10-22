/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Fusion の重ね方が差分・乗算のあいだ、「ROI 計測は背景画像の画素を読んでいる」ことを計測側へ伝えるレジストリ。
 *
 * <p>差分・乗算は表示上の合成（`fusionBlend.ts`）で、合成後の画素値は存在しない。ROI の統計・画素ダンプは
 * ROI が載っている背景画像だけを読む。画面は合成後の見た目なので、「Fusion 画像の平均を測ったつもりが
 * 背景の統計だった」という取り違えが起こり得る。計測の対象は切り替えず、**何を測ったかを結果と出力に残す**。
 *
 * <p>キーはタイル ID。`Viewer2DScreen` のタイルが Fusion の状態に合わせて登録・解除する。
 */
import { useSyncExternalStore } from "react";
import type { FusionBlend } from "./fusionBlend";

/** 計測の取り違えが起こる重ね方（通常のブレンドは対象外）。 */
export type FusionCalcBlend = Extract<FusionBlend, "difference" | "multiply">;

export function isFusionCalcBlend(blend: string | undefined | null): blend is FusionCalcBlend {
  return blend === "difference" || blend === "multiply";
}

export interface FusionMeasureInfo {
  /** 計測が読んでいる背景画像のシリーズ。 */
  backgroundSeriesUid: string;
  /** 前景シリーズの表示名。 */
  foregroundLabel: string;
  blend: FusionCalcBlend;
}

const store = new Map<string, FusionMeasureInfo>();
let snapshot: readonly FusionMeasureInfo[] = [];
const listeners = new Set<() => void>();

function publish(): void {
  snapshot = [...store.values()];
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 購読側の例外は無視 */
    }
  }
}

/** タイルの Fusion 状態を登録する。`null` で解除。変化が無ければ通知しない。 */
export function setFusionMeasure(tileId: string, info: FusionMeasureInfo | null): void {
  const cur = store.get(tileId);
  if (!info) {
    if (store.delete(tileId)) publish();
    return;
  }
  if (cur && cur.backgroundSeriesUid === info.backgroundSeriesUid && cur.foregroundLabel === info.foregroundLabel && cur.blend === info.blend) return;
  store.set(tileId, info);
  publish();
}

/** 登録中の Fusion（差分・乗算）の一覧。 */
export function listFusionMeasure(): readonly FusionMeasureInfo[] {
  return snapshot;
}

/** この背景シリーズを読む計測が、差分・乗算の Fusion の背景になっているか。 */
export function fusionMeasureForSeries(seriesUid: string | undefined): FusionMeasureInfo | undefined {
  if (!seriesUid) return undefined;
  return snapshot.find((f) => f.backgroundSeriesUid === seriesUid);
}

export function subscribeFusionMeasure(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useFusionMeasure(): readonly FusionMeasureInfo[] {
  return useSyncExternalStore(subscribeFusionMeasure, listFusionMeasure, listFusionMeasure);
}

/** CSV に残す 3 列（Fusion が無い行は空セル）。 */
export const FUSION_CSV_HEADER = ["measuredOn", "fusionBlend", "fusionForeground"] as const;

export function fusionCsvCells(info: FusionMeasureInfo | undefined): string[] {
  return info ? ["background", info.blend, info.foregroundLabel] : ["", "", ""];
}
