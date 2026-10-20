/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * しきい値ダイアログのセッション（モジュールスコープ＋subscribe。`wandStore.ts` と同型）。
 * セッションがあるあいだだけダイアログを表示する。
 */
export type ThresholdScope = "slice" | "all";

export interface ThresholdSession {
  viewportId: string;
  segId: string;
  segIndex: number;
  sourceImageIds: string[];
  cols: number;
  rows: number;
  /** 開いた時点の表示スライス（0 始まり）。範囲が「現在スライス」のときの対象。 */
  sliceZ: number;
  scope: ThresholdScope;
  lower: number;
  upper: number;
  /** 表示スライスの判定値の最小・最大（スライダー範囲。初期の下限・上限でもある）。 */
  rangeMin: number;
  rangeMax: number;
  unit: string;
  valueKind: "calibrated" | "stored" | "luminance";
  /** 入力に触れたか（触れるまでは何も書かない）。 */
  touched: boolean;
  count?: number;
  /** 下限 > 上限などで塗れない。 */
  invalid?: boolean;
}

let session: ThresholdSession | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function getThresholdSession(): ThresholdSession | null {
  return session;
}

export function openThresholdSession(s: ThresholdSession): void {
  session = s;
  notify();
}

export function updateThresholdSession(patch: Partial<ThresholdSession>): void {
  if (!session) return;
  session = { ...session, ...patch };
  notify();
}

export function clearThresholdSession(): void {
  if (!session) return;
  session = null;
  notify();
}

export function subscribeThreshold(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
