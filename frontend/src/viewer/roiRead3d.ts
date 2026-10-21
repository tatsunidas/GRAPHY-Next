/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { Roi3dBox } from "./roi3dBox";
import { volumeMl } from "./roi3dBox";
import type { Measure3d } from "./roiMeasure3d";
import { measureDistanceMm } from "./roiMeasure3d";
import { listRoi3d, listMeasure3d, subscribeRoi3d, subscribeMeasure3d } from "./roiLedger";

/**
 * プラグインへ渡す 3D ROI（台帳の solid と 3D 定規）。座標はすべて患者 LPS の mm。
 *
 * <p>`getRois()`（2D 注釈・画素座標）とは別系統で、`id` は `roiUid` と別物。
 * 台帳の型は直接渡さず、ここで契約の形に写す（内部表現を変えても契約が動かない）。
 * `patientKey` は台帳の項目に無ければ null（推測で埋めない）。
 */
export type PluginRoi3d = PluginSolidRoi3d | PluginRulerRoi3d;

interface PluginRoi3dBase {
  id: string;
  label: string | null;
  visible: boolean;
  studyUid: string | null;
  seriesUid: string | null;
  patientKey: string | null;
}

export interface PluginSolidRoi3d extends PluginRoi3dBase {
  kind: "solid";
  shape: "box" | "ellipsoid";
  /** 中心 [x,y,z] mm（LPS）。 */
  center: [number, number, number];
  /** X,Y,Z の全長 mm（半径ではない）。 */
  size: [number, number, number];
  volumeMl: number;
}

export interface PluginRulerRoi3d extends PluginRoi3dBase {
  kind: "ruler3d";
  a: [number, number, number];
  b: [number, number, number];
  /** 端点から導いた値（保存値ではない）。 */
  distanceMm: number;
}

const base = (i: { id: string; label?: string; visible?: boolean; studyUid?: string; seriesUid?: string; patientKey?: string }): PluginRoi3dBase => ({
  id: i.id,
  label: i.label ?? null,
  visible: i.visible !== false,
  studyUid: i.studyUid ?? null,
  seriesUid: i.seriesUid ?? null,
  patientKey: i.patientKey ?? null,
});

export function toPluginRois3d(solids: Roi3dBox[], measures: Measure3d[]): PluginRoi3d[] {
  return [
    ...solids.map((s): PluginSolidRoi3d => ({
      ...base(s),
      kind: "solid",
      shape: s.shape,
      center: [...s.center],
      size: [...s.size],
      volumeMl: volumeMl(s),
    })),
    ...measures.map((m): PluginRulerRoi3d => ({
      ...base(m),
      kind: "ruler3d",
      a: [...m.a],
      b: [...m.b],
      distanceMm: measureDistanceMm(m),
    })),
  ];
}

/** 呼ぶたびに台帳の現在値を読む。 */
export function readRois3d(): PluginRoi3d[] {
  return toPluginRois3d(listRoi3d(), listMeasure3d());
}

/** solid・定規どちらの変化でも発火。差分は渡さない。リスナーの例外は握る。 */
export function subscribeRois3d(listener: () => void): () => void {
  const fire = () => {
    try {
      listener();
    } catch {
      /* プラグインの例外で本体を巻き込まない */
    }
  };
  const u1 = subscribeRoi3d(fire);
  const u2 = subscribeMeasure3d(fire);
  return () => {
    u1();
    u2();
  };
}
