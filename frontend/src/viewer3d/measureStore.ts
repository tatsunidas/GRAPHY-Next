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
const listeners = new Set<() => void>();
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
  }
}

export function clearMeasurements(): void {
  if (!measures.length) return;
  measures = [];
  notify();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React フック: 計測一覧を購読。 */
export function useMeasurements(): Measurement3D[] {
  return useSyncExternalStore(subscribe, getMeasurements, getMeasurements);
}
