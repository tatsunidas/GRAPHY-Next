/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * パラメトリック 3D 球 ROI（GRAPHY SphereRoi3D 相当）のストア＋断面幾何。
 *
 * 中心(world IPP) + 半径(mm) + C/T scope を**パラメトリックに保持**し、各スライスへ球の断面円
 * （半径 √(r²−d²)、d=球中心〜スライス平面の法線距離）を**ライブプレビュー**する。ラスタ化（Mask 化）は
 * `roi3d.rasterizeSphereToMask` で焼き込む（非破壊のまま保持し、必要時に Mask 化）。
 * 設計: `fw/roi-manager-design.md` 第5章。
 */
import { metaData, type Types } from "@cornerstonejs/core";
import type { DimScope } from "./roiMaskStore";

export interface Sphere3D {
  id: string;
  studyUid: string;
  seriesUid: string;
  /** 作成スライスの imageId（Mask 焼き込み時のスタック解決に使う）。 */
  refImageId: string;
  center: [number, number, number]; // world (IPP mm)
  radiusMm: number;
  c: DimScope;
  t: DimScope;
  patientKey: string;
  seriesLabel?: string;
  label?: string;
  color: string;
  visible: boolean;
}

const byId = new Map<string, Sphere3D>();
const listeners = new Set<() => void>();
let seq = 0;

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function addSphere3D(s: Omit<Sphere3D, "id">): string {
  const id = `sphere3d-${++seq}`;
  byId.set(id, { ...s, id });
  notify();
  return id;
}
export function getSphere3D(id: string): Sphere3D | undefined {
  return byId.get(id);
}
export function listSpheres3D(): Sphere3D[] {
  return [...byId.values()];
}
export function updateSphere3D(id: string, patch: Partial<Sphere3D>): void {
  const cur = byId.get(id);
  if (!cur) return;
  byId.set(id, { ...cur, ...patch });
  notify();
}
export function deleteSphere3D(id: string): void {
  if (byId.delete(id)) notify();
}
export function subscribeSphere3D(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

type V3 = [number, number, number];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

/** SVG 描画用の断面円（キャンバス CSS px、reference lines と同座標系）。 */
export interface SphereCanvasCircle {
  cx: number;
  cy: number;
  r: number;
  color: string;
  label: string;
}

/**
 * 現在スライスにおける球の断面円をキャンバス座標で返す（交差しない/対象外なら null）。
 * worldToCanvas で zoom/pan/回転に追従。
 */
export function sphereCanvasCircle(
  viewport: Types.IStackViewport,
  s: Sphere3D,
  curC: number,
  curT: number,
): SphereCanvasCircle | null {
  if (!s.visible) return null;
  if (s.c !== "all" && s.c !== curC) return null;
  if (s.t !== "all" && s.t !== curT) return null;
  const imageId = viewport.getCurrentImageId?.();
  if (!imageId) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = metaData.get("imagePlaneModule", imageId) as any;
  if (!m?.imagePositionPatient || !m.rowCosines || !m.columnCosines) return null;
  const ipp = m.imagePositionPatient as V3;
  const rowCos = m.rowCosines as V3;
  const normal = norm(cross(rowCos, m.columnCosines as V3));
  const d = dot(sub(s.center, ipp), normal); // 球中心〜スライス平面の法線距離
  if (Math.abs(d) > s.radiusMm) return null;
  const crossR = Math.sqrt(Math.max(0, s.radiusMm * s.radiusMm - d * d));
  const c = viewport.worldToCanvas(s.center);
  // 断面円上の 1 点（in-plane rowCos 方向）をキャンバス投影して半径を得る。
  const edge = viewport.worldToCanvas([
    s.center[0] + crossR * rowCos[0],
    s.center[1] + crossR * rowCos[1],
    s.center[2] + crossR * rowCos[2],
  ]);
  const r = Math.hypot(edge[0] - c[0], edge[1] - c[1]);
  return { cx: c[0], cy: c[1], r, color: s.color, label: s.label ?? "" };
}
