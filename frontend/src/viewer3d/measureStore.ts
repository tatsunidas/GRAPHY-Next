/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 計測（ルーラー）の**メタデータ store**（`fw/3d-viewer-design.md` §15-#3）。旧 GRAPHY `Measurement3D*` に対応。
 *
 * 2 点（患者 LPS mm）＋距離 mm を保持する軽量リスト。追加/削除の Undo は `scene3d`（→`undoStore`）が調停する
 * （このストア自体は記録しない）。オーバーレイ（`Viewer3DMeasureOverlay`）が購読して線/端点/距離ラベルを再投影する。
 */
import { useSyncExternalStore } from "react";

type V3 = [number, number, number];

/** 3D 計測ライン（患者 LPS mm）。 */
export interface Measurement3D {
  id: string;
  a: V3;
  b: V3;
  distMm: number;
}

let measures: Measurement3D[] = [];
let selected: string | null = null;
const listeners = new Set<() => void>();
const selListeners = new Set<() => void>();
let seq = 0;

function notify(): void {
  measures = measures.slice();
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function nextMeasureId(): string {
  return `measure-${++seq}`;
}

export function getMeasurements(): Measurement3D[] {
  return measures;
}

/** 追加（記録なし。undo 調停は scene3d 側）。 */
export function addMeasurement(m: Measurement3D): void {
  measures = [...measures, m];
  notify();
}

/** 削除（記録なし）。 */
export function removeMeasurement(id: string): void {
  const next = measures.filter((m) => m.id !== id);
  if (next.length !== measures.length) {
    measures = next;
    notify();
    if (selected === id) setMeasureSelected(null);
  }
}

/** 端点を差し替えて距離を再計算（記録なし。ドラッグ中のライブ更新は scene3d 側で record する）。 */
export function updateMeasurement(id: string, a: V3, b: V3): void {
  const idx = measures.findIndex((m) => m.id === id);
  if (idx < 0) return;
  const distMm = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const next = measures.slice();
  next[idx] = { ...next[idx], a, b, distMm };
  measures = next;
  notify();
}

export function clearMeasurements(): void {
  if (!measures.length) return;
  measures = [];
  notify();
  setMeasureSelected(null);
}

/** 選択中の計測ライン id（ハイライト用。移動/端点ドラッグ開始時に設定）。 */
export function getMeasureSelected(): string | null {
  return selected;
}

export function setMeasureSelected(id: string | null): void {
  if (selected === id) return;
  selected = id;
  for (const l of [...selListeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function subscribeSel(l: () => void): () => void {
  selListeners.add(l);
  return () => {
    selListeners.delete(l);
  };
}

/** React フック: 計測一覧を購読。 */
export function useMeasurements(): Measurement3D[] {
  return useSyncExternalStore(subscribe, getMeasurements, getMeasurements);
}

/** React フック: 選択中の計測ライン id を購読。 */
export function useMeasureSelected(): string | null {
  return useSyncExternalStore(subscribeSel, getMeasureSelected, getMeasureSelected);
}
