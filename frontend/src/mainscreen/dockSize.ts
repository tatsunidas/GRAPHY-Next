/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * メイン画面の下部プレビュー（ドック）の大きさと、保存値の扱い。
 * 判定は純関数にしてある（vitest が見るのは `.ts` だけで、コンポーネントの中に書くと検査できない）。
 */

/** ドック本体の最小の高さ（px）。これより小さいと画像が見えない。 */
export const DOCK_MIN_HEIGHT = 160;
/** 一覧に最低限残す高さ（px）。ドックを引き上げても一覧が潰れないようにする。 */
export const LIST_KEEP_HEIGHT = 120;
/** 既定の高さの、領域の高さに対する割合。 */
export const DOCK_DEFAULT_RATIO = 0.4;
export const DOCK_STORAGE_KEY = "graphy.mainPreviewDock";

/** ドックの高さを範囲内に収める。高さが数でなければ既定値。領域が小さいときは最小を優先する。 */
export function clampDockHeight(height: number, containerHeight: number): number {
  const max = Math.max(DOCK_MIN_HEIGHT, containerHeight - LIST_KEEP_HEIGHT);
  const h = Number.isFinite(height) ? height : containerHeight * DOCK_DEFAULT_RATIO;
  return Math.round(Math.min(Math.max(h, DOCK_MIN_HEIGHT), max));
}

export interface DockState {
  open: boolean;
  /** null は未保存（既定の高さを使う）。 */
  height: number | null;
}

/** localStorage の値を読む。壊れていたら既定（表示・高さ未保存）に戻す。 */
export function parseDockState(raw: string | null | undefined): DockState {
  const fallback: DockState = { open: true, height: null };
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as { open?: unknown; height?: unknown };
    return {
      open: typeof v.open === "boolean" ? v.open : true,
      height: typeof v.height === "number" && Number.isFinite(v.height) && v.height > 0 ? v.height : null,
    };
  } catch {
    return fallback;
  }
}
