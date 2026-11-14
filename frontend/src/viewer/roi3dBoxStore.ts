/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR の 3D ROI のストア（メモリのみ・保存しない）。MPR ウィンドウを閉じると消える。
 * 形の計算は `roi3dBox.ts`。購読の流儀は `sphere3dStore.ts` に合わせる。
 */
import type { Roi3dBox } from "./roi3dBox";

let boxes: Roi3dBox[] = [];
let selectedId: string | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) l();
}

export function nextRoi3dId(): string {
  return `roi3d-${++seq}`;
}
export function listRoi3d(): Roi3dBox[] {
  return boxes;
}
export function selectedRoi3dId(): string | null {
  return selectedId;
}
export function addRoi3d(b: Roi3dBox): void {
  boxes = [...boxes, b];
  selectedId = b.id;
  notify();
}
export function updateRoi3d(b: Roi3dBox): void {
  if (!boxes.some((x) => x.id === b.id)) return;
  boxes = boxes.map((x) => (x.id === b.id ? b : x));
  notify();
}
export function removeRoi3d(id: string): void {
  boxes = boxes.filter((x) => x.id !== id);
  if (selectedId === id) selectedId = null;
  notify();
}
export function selectRoi3d(id: string | null): void {
  if (selectedId === id) return;
  selectedId = id;
  notify();
}
export function clearRoi3d(): void {
  boxes = [];
  selectedId = null;
  notify();
}
export function subscribeRoi3d(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
