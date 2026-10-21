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
import { addMeasure3d, clearMeasure3d, getMeasure3d, listMeasure3d, newRoi3dId, removeMeasure3d, subscribeMeasure3d, updateMeasure3d } from "../viewer/roiLedger";
import { measureDistanceMm, type Measure3d } from "../viewer/roiMeasure3d";

type V3 = [number, number, number];

/** 3D 計測ライン（患者 LPS mm）。台帳（`viewer/roiLedger`）の定規に、端点から導いた距離を添えたもの。 */
export type Measurement3D = Measure3d & { distMm: number };

let selected: string | null = null;
const selListeners = new Set<() => void>();

// 台帳の配列が同じ間は同じ配列を返す（useSyncExternalStore が毎回再描画しないように）。
let cacheSrc: Measure3d[] | null = null;
let cacheOut: Measurement3D[] = [];

export function nextMeasureId(): string {
  return newRoi3dId();
}

export function getMeasurements(): Measurement3D[] {
  const src = listMeasure3d();
  if (src !== cacheSrc) {
    cacheSrc = src;
    cacheOut = src.map((m) => ({ ...m, distMm: measureDistanceMm(m) }));
  }
  return cacheOut;
}

/** 追加（記録なし。undo 調停は scene3d 側）。 */
export function addMeasurement(m: Measure3d): void {
  addMeasure3d({ id: m.id, a: m.a, b: m.b, ...(m.label ? { label: m.label } : {}), ...(m.color ? { color: m.color } : {}), ...(m.visible === false ? { visible: false } : {}) });
}

/** 削除（記録なし）。 */
export function removeMeasurement(id: string): void {
  removeMeasure3d(id);
  if (selected === id) setMeasureSelected(null);
}

/** 端点を差し替える（記録なし。ドラッグ中のライブ更新は scene3d 側で record する）。距離は端点から導く。 */
export function updateMeasurement(id: string, a: V3, b: V3): void {
  const cur = getMeasure3d(id);
  if (cur) updateMeasure3d({ ...cur, a, b });
}

/** シーンの再読込で手放す。**削除ではない**（保存・墓標を起こさない。開き直せば保存済みが戻る）。 */
export function clearMeasurements(): void {
  clearMeasure3d();
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

const subscribe = subscribeMeasure3d;

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
