/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 台帳（窓内のレプリカ）の solid（パラメトリック 3D ROI）。`fw/roi-global-manager.md`。
 *
 * <p>この窓で扱うシリーズぶんの solid を持つ。保存は患者単位ドキュメントの `solids`
 * （`roiSaveStore.setSolidsForSeries`）で、ここは**利用者の編集が起きたことを通知する**だけ
 * （`subscribeRoi3dEdits`）。保存済みの読み込み（`hydrateRoi3d`）では通知しない（読んだだけで保存し直さない）。
 * 形の計算は `roi3dBox.ts`。購読の流儀は `sphere3dStore.ts` に合わせる。
 */
import type { Roi3dBox } from "./roi3dBox";

let boxes: Roi3dBox[] = [];
let selectedId: string | null = null;
let seriesCtx: { studyUid?: string; seriesUid?: string } = {};
const listeners = new Set<() => void>();
const editListeners = new Set<() => void>();

function emit(set: Set<() => void>): void {
  for (const l of [...set]) l();
}

/** 新しい solid を作る窓の、いまのシリーズ。作図で作る solid にこれを刻む。 */
export function setRoi3dContext(ctx: { studyUid?: string; seriesUid?: string }): void {
  seriesCtx = ctx;
}

/** 窓をまたいでも衝突しない id（連番は窓・起動ごとに同じ値から始まる）。 */
export function newRoi3dId(): string {
  return crypto.randomUUID();
}

/** 窓内の solid。`seriesUid` を渡すとそのシリーズのものだけ（2D 窓は複数シリーズを同時に持つ）。 */
export function listRoi3d(seriesUid?: string): Roi3dBox[] {
  return seriesUid === undefined ? boxes : boxes.filter((b) => b.seriesUid === seriesUid);
}
export function getRoi3d(id: string): Roi3dBox | undefined {
  return boxes.find((b) => b.id === id);
}
export function selectedRoi3dId(): string | null {
  return selectedId;
}

const stamp = (b: Roi3dBox): Roi3dBox => ({ ...b, updatedAt: new Date().toISOString() });

export function addRoi3d(b: Roi3dBox): void {
  boxes = [...boxes, stamp({ ...seriesCtx, ...b })];
  selectedId = b.id;
  emit(listeners);
  emit(editListeners);
}
export function updateRoi3d(b: Roi3dBox): void {
  if (!boxes.some((x) => x.id === b.id)) return;
  boxes = boxes.map((x) => (x.id === b.id ? stamp(b) : x));
  emit(listeners);
  emit(editListeners);
}
export function removeRoi3d(id: string): void {
  boxes = boxes.filter((x) => x.id !== id);
  if (selectedId === id) selectedId = null;
  emit(listeners);
  emit(editListeners);
}
export function selectRoi3d(id: string | null): void {
  if (selectedId === id) return;
  selectedId = id;
  emit(listeners);
}
/** 保存済みの solid を読み込む（編集ではないので保存を起こさない）。 */
export function hydrateRoi3d(solids: Roi3dBox[]): void {
  boxes = solids;
  selectedId = null;
  emit(listeners);
}
/** 保存済みの solid のうち、このシリーズ分だけを置き換える（他のシリーズ・編集通知は触らない）。 */
export function hydrateRoi3dSeries(seriesUid: string, solids: Roi3dBox[]): void {
  boxes = [...boxes.filter((b) => b.seriesUid !== seriesUid), ...solids];
  if (selectedId && !boxes.some((b) => b.id === selectedId)) selectedId = null;
  emit(listeners);
}
export function clearRoi3d(): void {
  boxes = [];
  selectedId = null;
  seriesCtx = {};
  emit(listeners);
}
export function subscribeRoi3d(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
/** 利用者の編集（追加・更新・削除）だけを聞く。保存の起点。 */
export function subscribeRoi3dEdits(l: () => void): () => void {
  editListeners.add(l);
  return () => {
    editListeners.delete(l);
  };
}
