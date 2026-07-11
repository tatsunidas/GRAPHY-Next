/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Level Sets のセッション状態。`wandStore.ts` と同型のパターン。
 *
 * クリックした点を **シード** として記憶し、ダイアログでパラメータを変えると同じシード/初期輪郭から
 * 再実行して**結果を置換（追加ではなく Update）**する。実際の Worker 呼び出し・labelmap 書込は
 * `levelSetsTool.ts`（`runLevelSet`）。ダイアログは `LevelSetsDialog.tsx`。
 *
 * `fastMarching`（点シード・非反復）と `activeContours`（領域シード・反復 narrow-band level set）は
 * 独立したチェックボックスで有効化する（fw/level-sets-design.md §1.1、Fiji の Use Fast Marching /
 * Use Level Sets に対応）。両方 ON なら Fast Marching の結果を Active Contours の初期輪郭として使う。
 */
import type { RegionExpandsTo } from "./levelSetsCore";

export interface FastMarchingParams {
  enabled: boolean;
  greyValueThreshold: number;
  distanceThreshold: number;
}

export type LevelSetMethod = "activeContours" | "geodesicActiveContours";

export interface ActiveContoursParams {
  enabled: boolean;
  method: LevelSetMethod;
  advection: number;
  curvature: number;
  grayscaleTolerance: number; // Active Contours のみで使用
  propagation: number; // Geodesic Active Contours のみ有効（fw/level-sets-design.md §1.2、Fiji 原文どおり）
  edgeSigma: number; // Geodesic Active Contours のみ使用（Fiji には無い本実装独自の追加）
  convergence: number;
  regionExpandsTo: RegionExpandsTo;
  narrowBand: number;
}

export interface LevelSetSession {
  viewportId: string;
  segId: string;
  segIndex: number;
  sourceImageIds: string[]; // 対象スタック（source imageId 群、z 昇順）
  cols: number;
  rows: number;
  seedZ: number; // シードのスライス index（stack 内）
  seedX: number; // 列（Fast Marching のクリックシード時のみ意味を持つ）
  seedY: number; // 行
  seedValue: number; // シード画素の輝度（raw）
  fastMarching: FastMarchingParams;
  activeContours: ActiveContoursParams;
  status: "running" | "done" | "error" | "noInitContour";
  reachedCount: number;
  iterations?: number; // Active Contours 実行時の反復数
  lastChange?: number; // Active Contours 実行時の収束指標（平均 |Δφ|）
  /**
   * Fast Marching 無効時、Active Contours の初期輪郭として使う「セッション開始時点の既存マスク」の
   * スナップショット。再実行（スライダー調整）のたびに直前の実行結果から進化させると値がドリフトし続けて
   * 挙動が予測不能になるため、常にこの固定スナップショットを起点に評価する（`levelSetsTool.ts`）。
   */
  initMaskSnapshot?: Uint8Array;
}

let session: LevelSetSession | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      /* ignore */
    }
  }
}

export function getLevelSetSession(): LevelSetSession | null {
  return session;
}

export function openLevelSetSession(s: LevelSetSession): void {
  session = s;
  notify();
}

export function updateLevelSetSession(patch: Partial<LevelSetSession>): void {
  if (!session) return;
  session = { ...session, ...patch };
  notify();
}

export function clearLevelSetSession(): void {
  if (!session) return;
  session = null;
  notify();
}

export function subscribeLevelSet(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
