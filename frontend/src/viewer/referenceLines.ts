/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * リファレンスライン — グローバル登録＋幾何計算。
 *
 * 表示中の各シリーズ（base SliderView ビューポート）が source として登録し、
 * 各ビューポートは「他 source の現在スライス平面が自分の表示面と交差する線」を描く。
 * これにより「現在表示中シリーズが他シリーズの画像空間でどこか」を示す（ZCT 対応＝
 * 現在表示中の imageId の平面を使うため、Z/C/T を変えると線も追従する）。
 *
 * Cornerstone3D の `ReferenceLinesTool` は単一 source→他全部・共有 toolGroup 前提のため、
 * 個別 toolGroup（タイル毎に W/L 等を独立バインド）の本アプリでは all-to-all に使えない。
 * そこで core の幾何ユーティリティ（{@link getViewportImageCornersInWorld} /
 * `planar.planeEquation` / `planar.linePlaneIntersection`）のみ流用し、DOM/SVG オーバーレイで描画する。
 */
import { utilities, type Types } from "@cornerstonejs/core";

const EPSILON = 1e-3;

interface RefEntry {
  id: string;
  label: string;
  /** 現在の source ビューポート（破棄後は null）。 */
  getViewport: () => Types.IStackViewport | null;
}

/** 描画用の線分（target キャンバス CSS px）。 */
export interface RefSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
  label: string;
}

const entries = new Map<string, RefEntry>();
const listeners = new Set<() => void>();

// source ごとの安定色。
const PALETTE = ["#ff5252", "#40c4ff", "#69f0ae", "#ffd740", "#e040fb", "#ff6e40", "#18ffff", "#b2ff59"];
const colorById = new Map<string, string>();
let colorSeq = 0;
function colorFor(id: string): string {
  let c = colorById.get(id);
  if (!c) {
    c = PALETTE[colorSeq++ % PALETTE.length];
    colorById.set(id, c);
  }
  return c;
}

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* リスナ例外は無視 */
    }
  }
}

/** source 登録。返り値で解除。 */
export function registerReferenceSource(e: RefEntry): () => void {
  entries.set(e.id, e);
  colorFor(e.id);
  notify();
  return () => {
    entries.delete(e.id);
    notify();
  };
}

/** source の平面（スライス/カメラ）が変わったことを全 target に通知。 */
export function bumpReference(): void {
  notify();
}

/** target が再描画するための購読。 */
export function subscribeReference(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

function isParallel(a: Types.Point3, b: Types.Point3): boolean {
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) > 1 - EPSILON;
}
function isPerpendicular(a: Types.Point3, b: Types.Point3): boolean {
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) < EPSILON;
}
function sub(a: Types.Point3, b: Types.Point3): Types.Point3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function normalize(v: Types.Point3): Types.Point3 {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
function cross(a: Types.Point3, b: Types.Point3): Types.Point3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function frameOfRef(vp: Types.IStackViewport): string | undefined {
  try {
    return vp.getFrameOfReferenceUID();
  } catch {
    return undefined;
  }
}

/**
 * target ビューポートに描く、他 source の参照線分を計算する。
 * Cornerstone `ReferenceLinesTool.renderAnnotation` と同じ幾何:
 * source 画像矩形の左右辺と target 平面の交点 2 点を結ぶ（source FOV に収まる弦）。
 */
export function computeReferenceSegments(targetId: string, targetVp: Types.IStackViewport): RefSegment[] {
  const out: RefSegment[] = [];
  const tCam = targetVp.getCamera();
  const tNormal = tCam.viewPlaneNormal as Types.Point3 | undefined;
  const tFocal = tCam.focalPoint as Types.Point3 | undefined;
  if (!tNormal || !tFocal) return out;
  const targetFoR = frameOfRef(targetVp);
  const targetPlane = utilities.planar.planeEquation(tNormal, tFocal);

  for (const e of entries.values()) {
    if (e.id === targetId) continue;
    const sv = e.getViewport();
    if (!sv) continue;
    // 同一 FrameOfReference のみ（実座標が一致しないシリーズ間は描かない）。
    if (frameOfRef(sv) !== targetFoR) continue;
    const sNormal = sv.getCamera().viewPlaneNormal as Types.Point3 | undefined;
    if (!sNormal) continue;
    if (isParallel(sNormal, tNormal)) continue; // 同一/平行面 → 交線なし

    let corners: Types.Point3[];
    try {
      corners = utilities.getViewportImageCornersInWorld(sv) as Types.Point3[];
    } catch {
      continue;
    }
    if (!corners || corners.length < 4) continue;
    // getViewportImageCornersInWorld の順序 = [topLeft, topRight, bottomLeft, bottomRight]。
    const [topLeft, topRight, bottomLeft, bottomRight] = corners;

    // 既定 pointSet（左辺/右辺）。上下ベクトルが target 法線に垂直なら上辺/下辺に切替。
    let ps: [Types.Point3, Types.Point3, Types.Point3, Types.Point3] = [topLeft, bottomLeft, topRight, bottomRight];
    const topBottomVec = normalize(sub(ps[0], ps[1]));
    const topRightVec = normalize(sub(ps[2], ps[0]));
    const newNormal = cross(topBottomVec, topRightVec);
    if (isParallel(newNormal, tNormal)) continue;
    if (isPerpendicular(topBottomVec, tNormal)) {
      ps = [topLeft, topRight, bottomLeft, bottomRight];
    }

    let startW: Types.Point3, endW: Types.Point3;
    try {
      startW = utilities.planar.linePlaneIntersection(ps[0], ps[1], targetPlane);
      endW = utilities.planar.linePlaneIntersection(ps[2], ps[3], targetPlane);
    } catch {
      continue;
    }
    if (!startW || !endW) continue;

    let c1: Types.Point2, c2: Types.Point2;
    try {
      c1 = targetVp.worldToCanvas(startW);
      c2 = targetVp.worldToCanvas(endW);
    } catch {
      continue;
    }
    if (!Number.isFinite(c1[0]) || !Number.isFinite(c1[1]) || !Number.isFinite(c2[0]) || !Number.isFinite(c2[1])) {
      continue;
    }
    out.push({ x1: c1[0], y1: c1[1], x2: c2[0], y2: c2[1], color: colorFor(e.id), label: e.label });
  }
  return out;
}
