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
  /** スライス法線（IOP 外積・正規化）。座標同期で IPP をテーブル位置(mm)へ投影するのに使う。 */
  normal: readonly [number, number, number] | null;
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

function dot3(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** 法線がほぼ平行（同一オリエンテーション）か。 */
function parallelNormals(a: readonly [number, number, number], b: readonly [number, number, number]): boolean {
  return Math.abs(dot3(a, b)) > 0.999;
}

/**
 * 座標同期: source のスライス位置(テーブル位置 mm = IPP·法線)に最も近い Z を返す。
 * 面内原点(x,y)の違いに影響されないよう **法線へ投影したスカラ**で比較する。
 * - フォロワーが非空間 / source と非共平面（向きが違う）→ null（呼び出し側で Δ 送り）。
 * - 共平面なら常に最近傍 Z を返す。`within` はマージン(marginMm)内で位置一致したかの目安
 *   （マージン外＝カバレッジ外などで最近傍エッジへクランプした状態。将来の位置ロック表示用）。
 */
function coordinateTarget(
  st: SliceSyncState,
  srcPos: number,
  srcNormal: readonly [number, number, number],
): { z: number; within: boolean } | null {
  if (!st.normal || !parallelNormals(st.normal, srcNormal)) {
    return null; // 非共平面（AX×SAG 等）→ 投影比較不可
  }
  let best = -1;
  let bestD = Infinity;
  for (let z = 0; z < st.ipps.length; z++) {
    const q = st.ipps[z];
    if (!q) continue;
    const d = Math.abs(dot3(q, srcNormal) - srcPos); // source 法線で投影して比較
    if (d < bestD) {
      bestD = d;
      best = z;
    }
  }
  if (best < 0) return null; // 空間情報なし → 呼び出し側で Δ 送り
  return { z: best, within: bestD <= marginMm };
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

  // source の現在スライス位置（テーブル位置 mm = IPP·法線）。
  const srcIpp = srcState.ipps[srcState.index] ?? null;
  const srcNormal = srcState.normal;
  const srcPos = srcIpp && srcNormal ? dot3(srcIpp, srcNormal) : null;

  for (const [id, e] of entries) {
    if (id === sourceId) continue;
    let st: SliceSyncState;
    try {
      st = e.getState();
    } catch {
      continue;
    }
    let target: number | null = null;
    if (mode === "coordinate" && srcPos != null && srcNormal) {
      const r = coordinateTarget(st, srcPos, srcNormal);
      if (r != null) {
        // 共平面なら常に世界座標の最近傍スライスへスナップする。
        // マージン内=位置一致、マージン外=最近傍エッジへクランプ（例: 一部Zしか持たない
        // 派生シリーズ Radiomicsマップ↔CT で、CTをマップのカバレッジ外へスクロールした場合）。
        // ここで枚数差(Δ)送りにフォールバックすると、共平面・同一フレームでも index 送りが
        // 混ざってスクロールのたびにオフセットが累積し、位置がドリフトする（旧実装のバグ）。
        target = r.z;
      } else {
        // 非空間 / 非共平面(向き違い) のみ枚数差(Δ)送りにフォールバック。
        target = simpleTarget(st, delta);
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
