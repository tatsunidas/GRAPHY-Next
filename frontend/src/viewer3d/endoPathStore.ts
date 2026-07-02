/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 手動内視鏡経路の**編集ストア**（`fw/3d-viewer-design.md` §15-#6）。旧 GRAPHY `endo/{EndoPath3D,EndoCommands}` に対応。
 *
 * ユーザが 3D 上でクリック追加/ドラッグ移動/削除する経路制御点（患者 LPS mm）を順序付きで保持する。
 * 追加/移動/削除の Undo は `scene3d`（→`undoStore`）が全配列スナップショットで調停する（このストアは記録しない）。
 * オーバーレイ（`Viewer3DEndoPathOverlay`）が購読して、点列を再投影しポリライン/マーカーを描く。
 * 確定すると `Centerline3D`（中心線オブジェクト）へ変換し、既存の fly-through/CPR にそのまま乗る。
 */
import { useSyncExternalStore } from "react";

type V3 = [number, number, number];

interface EndoPathState {
  points: V3[];
  /** 選択中の制御点 index（削除対象・ハイライト用）。 */
  selected: number | null;
}

let points: V3[] = [];
let selected: number | null = null;
let snapshot: EndoPathState = { points, selected };
const listeners = new Set<() => void>();

function notify(): void {
  snapshot = { points, selected };
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function getEndoPath(): V3[] {
  return points;
}

export function getEndoPathState(): EndoPathState {
  return snapshot;
}

/** 点列を差し替える（記録なし。undo 調停は scene3d 側）。 */
export function setEndoPath(next: V3[]): void {
  points = next.map((p) => [p[0], p[1], p[2]] as V3);
  if (selected != null && selected >= points.length) selected = points.length ? points.length - 1 : null;
  notify();
}

export function setEndoSelected(i: number | null): void {
  selected = i != null && i >= 0 && i < points.length ? i : null;
  notify();
}

export function clearEndoPath(): void {
  if (!points.length && selected == null) return;
  points = [];
  selected = null;
  notify();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React フック: 経路点列＋選択を購読。 */
export function useEndoPath(): EndoPathState {
  return useSyncExternalStore(subscribe, getEndoPathState, getEndoPathState);
}
