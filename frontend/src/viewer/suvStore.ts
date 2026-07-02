/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * SUV 校正のセッション内レジストリ。
 *
 * <p>SeriesInstanceUID をキーに「SUV 乗数・単位・タイプ」を保持する。
 * 本家 GRAPHY の {@code Praparat.setSUVFactor}（同一シリーズの全スライドへ伝搬）に相当し、
 * ここに登録すると {@link ./pixelCalibration} の単一入口を通じて
 * カーソル値・ROI 統計・ヒストグラム・MPR が自動的に SUV 値へ切り替わる。
 *
 * <p>本家同様セッション内のみ（永続化しない）。変更は {@link subscribeSuvStore} で購読して
 * ビューアが即時反映する。
 */
import { metaData } from "@cornerstonejs/core";
import type { SuvType } from "./suv";

/** シリーズに適用中の SUV 校正。 */
export interface SuvCalibration {
  /** SUV = modalityValue × scale。 */
  scale: number;
  /** 表示単位（"SUVbw" 等）。 */
  unit: string;
  type: SuvType;
}

const store = new Map<string, SuvCalibration>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* 購読側の例外は無視 */
    }
  }
}

/** 変更通知を購読。返り値で解除。 */
export function subscribeSuvStore(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** SeriesInstanceUID の SUV 校正を取得（未設定なら undefined）。 */
export function getSuv(seriesUid: string | undefined): SuvCalibration | undefined {
  return seriesUid ? store.get(seriesUid) : undefined;
}

/** SUV 校正を設定（null/undefined で解除）。変化があれば通知。 */
export function setSuv(seriesUid: string, cal: SuvCalibration | null): void {
  if (!seriesUid) return;
  if (cal) store.set(seriesUid, cal);
  else store.delete(seriesUid);
  notify();
}

/** imageId から SeriesInstanceUID を解決する。 */
export function seriesUidOf(imageId: string | undefined): string | undefined {
  if (!imageId) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gsm: any = metaData.get("generalSeriesModule", imageId);
  return gsm?.seriesInstanceUID;
}

/** imageId が属するシリーズの SUV 校正（未設定なら undefined）。 */
export function suvForImageId(imageId: string | undefined): SuvCalibration | undefined {
  return getSuv(seriesUidOf(imageId));
}
