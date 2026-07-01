/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Wand（対話型リージョングロー）のセッション状態。
 *
 * クリックした点を **シード（制御点）** として記憶し、ダイアログの Threshold（シード輝度からの許容差）・
 * Connectivity を変えると、同じシードから再度フラッドして**結果を置換（追加ではなく Update）**する。
 * 実際のフラッド/labelmap 書込は `wandTool.ts`（`runWand`）。ダイアログは `WandDialog.tsx`。
 */
export type WandMode = "2d" | "3d";

export interface WandSession {
  mode: WandMode;
  viewportId: string;
  segId: string;
  segIndex: number;
  sourceImageIds: string[]; // 対象スタック（source imageId 群、z 昇順）
  cols: number;
  rows: number;
  seedZ: number; // シードのスライス index（stack 内）
  seedX: number; // 列
  seedY: number; // 行
  seedValue: number; // シード画素の輝度（raw）
  threshold: number; // 許容差（|value - seedValue| <= threshold）
  connectivity: number; // 2D: 4/8, 3D: 6/8/12/26
  rangeMin: number; // シードスライスの輝度 min（スライダー範囲）
  rangeMax: number; // シードスライスの輝度 max
}

let session: WandSession | null = null;
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

export function getWandSession(): WandSession | null {
  return session;
}

export function openWandSession(s: WandSession): void {
  session = s;
  notify();
}

export function updateWandSession(patch: Partial<WandSession>): void {
  if (!session) return;
  session = { ...session, ...patch };
  notify();
}

export function clearWandSession(): void {
  if (!session) return;
  session = null;
  notify();
}

export function subscribeWand(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
