/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D シーンオブジェクト（メッシュ / 3D ROI）の**メタデータ store**（`fw/3d-viewer-design.md` §8.6）。
 *
 * 旧 GRAPHY `SceneObjectTableModel` に対応。ここには UI 再描画に必要な軽量メタ（名前・色・透明度・可視・計測サマリ）
 * のみを保持する。重い vtk データ（`vtkPolyData` / `LabelVolume` / `vtkActor`）は `scene3d.ts`（コントローラ）が
 * 非リアクティブな Map で管理し、レンダラのライフサイクルに紐付ける（React 再描画で巨大配列をコピーしない）。
 */
import { useSyncExternalStore } from "react";

export type SceneObjKind = "mesh" | "roi" | "centerline";

/**
 * 表示モード（旧 GRAPHY `OrthoRoiMode` の Float/Embedded に対応）。
 * - `float`: ソース（ボリューム）がクリップされても**自分はカットされない**（浮き立たせ）。
 * - `embedded`: ボリュームのクリップ箱と**一緒にカットされる**（埋め込み）。
 */
export type SceneDisplayMode = "float" | "embedded";

/** 取り込み元（2D ビューアの ROI / サーバの SEG・RTSTRUCT）への参照。重複取り込みの判定に使う。 */
export interface SceneObjectSource {
  seriesUid?: string;
  c?: number | "all";
  t?: number | "all";
  segmentationId?: string;
  segmentIndex?: number;
  sphereId?: string;
  origin: "2d" | "server";
}

/** 同じ元かを比べるキー。`maskBridgeCore.announceKey` と同じ規則（2D 由来のみ。server は null）。 */
export function sceneSourceKey(s: SceneObjectSource | undefined): string | null {
  if (!s || s.origin !== "2d") return null;
  if (s.sphereId) return `sphere:${s.sphereId}`;
  if (s.segmentationId != null && s.segmentIndex != null) return `painted:${s.segmentationId}#${s.segmentIndex}`;
  return null;
}

/** シーンオブジェクトのメタデータ（描画データは持たない）。 */
export interface SceneObject {
  id: string;
  kind: SceneObjKind;
  name: string;
  /** RGB 0..1。 */
  color: [number, number, number];
  /** 0..1。 */
  opacity: number;
  visible: boolean;
  selected?: boolean;
  /** ボリュームのクリップ箱と一緒にカットされるか（埋め込み）/されないか（浮き立たせ）。既定 float。 */
  displayMode: SceneDisplayMode;
  /** 取り込み元（2D の ROI 等）。メッシュ単体などは持たない。 */
  source?: SceneObjectSource;
  // ── 計測サマリ（患者 LPS mm）──
  volumeMm3?: number;
  /** 表示をなめらかにするか（ROI のみ。体積は平滑化前の形で求める）。既定 false（階段状）。 */
  smooth?: boolean;
  volumeMl?: number;
  surfaceAreaMm2?: number;
  /** 主径 [long, mid, short] mm。 */
  diameters?: [number, number, number];
  /** ROI: 前景ボクセル数。 */
  voxels?: number;
  /** ROI: 体積の奥行きの出どころ。"thickness" は推定。 */
  volumeDepthSource?: "ipp" | "sbs" | "thickness" | "unknown";
  numTriangles?: number;
  /** 中心線: 全長 mm。 */
  lengthMm?: number;
  /** 予備（未使用）。 */
  lengthMl?: number;
}

let objects: SceneObject[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function notify(): void {
  // useSyncExternalStore 用に配列参照を差し替える。
  objects = objects.slice();
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function nextSceneId(prefix: string): string {
  return `${prefix}-${++seq}`;
}

export function getSceneObjects(): SceneObject[] {
  return objects;
}

export function getSceneObject(id: string): SceneObject | undefined {
  return objects.find((o) => o.id === id);
}

export function addSceneObject(obj: SceneObject): void {
  objects = [...objects, obj];
  notify();
}

export function updateSceneObject(id: string, patch: Partial<SceneObject>): void {
  let changed = false;
  objects = objects.map((o) => {
    if (o.id !== id) return o;
    changed = true;
    return { ...o, ...patch };
  });
  if (changed) notify();
}

export function removeSceneObject(id: string): void {
  const next = objects.filter((o) => o.id !== id);
  if (next.length !== objects.length) {
    objects = next;
    notify();
  }
}

/** 単一選択（selected を排他更新）。 */
export function selectSceneObject(id: string | null): void {
  objects = objects.map((o) => ({ ...o, selected: o.id === id }));
  notify();
}

export function clearSceneObjects(): void {
  if (!objects.length) return;
  objects = [];
  notify();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** React フック: シーンオブジェクト一覧を購読。 */
export function useSceneObjects(): SceneObject[] {
  return useSyncExternalStore(subscribe, getSceneObjects, getSceneObjects);
}
