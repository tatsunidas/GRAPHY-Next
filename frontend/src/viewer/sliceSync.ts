/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * シリーズ Sync — スライス位置同期 coordinator（グローバル）。
 *
 * Sync ON の SeriesViewer（SliderView）が {@link registerSliceSync} で参加し、
 * ユーザー操作でスライスが動いたら {@link publishSlice} を呼ぶ。coordinator が
 * モードに応じて各フォロワーの目標 Z を算出し `applyIndex` で移動させる。
 *
 * - 座標同期(coordinate): source の現在 IPP に 3D 距離最近傍の Z を選び、
 *   許容半径(marginMm) 以内なら移動。範囲外なら移動しない。
 * - 単純同期(simple): source の Δindex を各フォロワーへ同量適用（clamp）。初期オフセット保持。
 *
 * Cornerstone の native synchronizer は別系統（表示状態同期=presentation/VOI）で扱う。
 * スライスは単純同期/マージンを表現できないため自前 coordinator にする。
 */

export type SliceSyncMode = "coordinate" | "simple";

export interface SliceSyncState {
  /** 現在の Z インデックス。 */
  index: number;
  /** Z スタック枚数。 */
  nZ: number;
  /** Z ごとの IPP（無ければ null）。length=nZ。 */
  ipps: (readonly [number, number, number] | null)[];
}

interface Entry {
  id: string;
  getState: () => SliceSyncState;
  applyIndex: (z: number) => void;
}

const entries = new Map<string, Entry>();
/** 単純同期の Δ 算出用に各参加者の直近 index を保持。 */
const lastIndex = new Map<string, number>();

let mode: SliceSyncMode = "coordinate";
let marginMm = 2.5;

/** 設定（座標/単純・許容半径）を更新する。複数 Viewer から同値で呼ばれてよい。 */
export function setSliceSyncConfig(nextMode: SliceSyncMode, nextMarginMm: number): void {
  mode = nextMode;
  if (Number.isFinite(nextMarginMm) && nextMarginMm >= 0) marginMm = nextMarginMm;
}

/** 参加登録。返り値で解除する。 */
export function registerSliceSync(entry: Entry): () => void {
  entries.set(entry.id, entry);
  try {
    lastIndex.set(entry.id, entry.getState().index);
  } catch {
    lastIndex.set(entry.id, 0);
  }
  return () => {
    entries.delete(entry.id);
    lastIndex.delete(entry.id);
  };
}

function clampIndex(st: SliceSyncState, z: number): number {
  return Math.max(0, Math.min(st.nZ - 1, z));
}

/** 単純同期: source の Δ をフォロワーへ加算（clamp）。 */
function simpleTarget(st: SliceSyncState, delta: number): number {
  return clampIndex(st, st.index + delta);
}

/** 座標同期: source 位置 p に最近傍の Z（許容半径以内）。範囲外/IPP 無しは null。 */
function coordinateTarget(st: SliceSyncState, p: readonly [number, number, number]): number | null {
  let best = -1;
  let bestD = Infinity;
  for (let z = 0; z < st.ipps.length; z++) {
    const q = st.ipps[z];
    if (!q) continue;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  if (best < 0) return null; // フォロワーに IPP が無い
  return bestD <= marginMm ? best : -1; // -1=範囲外（移動しない）の番兵
}

/**
 * source のスライス変化を全フォロワーへ伝播する。
 * source 自身の index は呼び出し前に確定している前提（getState が最新を返す）。
 */
export function publishSlice(sourceId: string): void {
  const src = entries.get(sourceId);
  if (!src) return;
  let srcState: SliceSyncState;
  try {
    srcState = src.getState();
  } catch {
    return;
  }
  const prev = lastIndex.get(sourceId) ?? srcState.index;
  const delta = srcState.index - prev;
  lastIndex.set(sourceId, srcState.index);

  if (entries.size < 2) return; // 同期は 2 つ以上で成立

  const srcIpp = srcState.ipps[srcState.index] ?? null;

  for (const [id, e] of entries) {
    if (id === sourceId) continue;
    let st: SliceSyncState;
    try {
      st = e.getState();
    } catch {
      continue;
    }
    let target: number | null = null;
    if (mode === "coordinate" && srcIpp) {
      const r = coordinateTarget(st, srcIpp);
      if (r === null) {
        target = simpleTarget(st, delta); // フォロワーが非空間 → 単純へフォールバック
      } else if (r >= 0) {
        target = r;
      } else {
        target = null; // 範囲外 → 移動しない
      }
    } else {
      // 単純同期、または source が非空間 → 単純
      target = simpleTarget(st, delta);
    }
    if (target != null && target !== st.index) {
      lastIndex.set(id, target); // フォロワーが後に source になる際の Δ 基準を更新
      try {
        e.applyIndex(target);
      } catch {
        /* ビューポート破棄途中などは無視 */
      }
    }
  }
}
