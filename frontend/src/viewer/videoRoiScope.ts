/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * 動画 ROI の**帰属モード**（`fw/video-viewer-design.md` §12 の 2 モード）。
 *
 * <p>1. **フレーム指定 ROI** … 特定フレームに紐づく。そのフレームでのみ表示し、単一フレーム統計
 *    （面積・平均/最大/最小・SD・ヒストグラム）を出す。通常の 2D スライス ROI と同じ挙動。
 * <p>2. **グローバル ROI** … 全フレームに適用（時間非依存）。常に表示され、時系列解析の対象になる。
 *
 * <p>Cornerstone の annotation は video viewport では全フレームが同一 FrameOfReference を共有するが、
 * **表示は描いたフレームに固定される**。`AnnotationTool` は生成時に `viewport.getViewReference()` を
 * metadata に入れ、`VideoViewport.isReferenceViewable()` が `sliceIndex === 現在フレーム` を要求するためで、
 * 素の挙動は「全フレームに出る」ではなく「描いた 1 フレームだけに出る」（2026-07-30 の実機検証で判明。
 * それまでは逆だと想定しており、グローバル ROI が他フレームで表示されない不具合になっていた）。
 *
 * <p>そこで帰属を **uid → スコープの対応表**としてビューア側に持ち、表示は
 * {@link applyScopeToReference} で **annotation metadata の参照フレーム**へ反映する（＝Cornerstone の
 * 表示フィルタを味方につける）。併せて `annotation.visibility` も揃えるが、そちらは補助でしかない。
 * この対応表の操作はすべて純粋関数としてここに置く（DOM も Cornerstone も参照しないので vitest で直接検証できる）。
 *
 * <p>更新系（{@link assignScope} / {@link toggleScope} / {@link pruneScopes}）は**変化が無ければ同一参照を
 * 返す**。React state に入れるため、無変化で新オブジェクトを返すと再描画が無限に連鎖する。
 */

/** ROI の帰属。`frame` は 1-based。 */
export type RoiScope = { kind: "global" } | { kind: "frame"; frame: number };

/** 既定の帰属（未登録の uid はグローバル扱い）。 */
export const GLOBAL_SCOPE: RoiScope = Object.freeze({ kind: "global" }) as RoiScope;

/** uid → 帰属の対応表。 */
export type RoiScopeMap = Readonly<Record<string, RoiScope>>;

/** 指定フレームに紐づくスコープを作る（1 未満は 1 に丸める）。 */
export function frameScope(frame: number): RoiScope {
  return { kind: "frame", frame: Math.max(1, Math.round(frame)) };
}

/** 2 つのスコープが同一か。 */
export function sameScope(a: RoiScope, b: RoiScope): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  return a.kind === "global" || a.frame === (b as { frame: number }).frame;
}

/** uid の帰属を引く。未登録はグローバル。 */
export function scopeOf(map: RoiScopeMap, uid: string): RoiScope {
  return map[uid] ?? GLOBAL_SCOPE;
}

/** そのスコープの ROI を frame（1-based）で表示すべきか。 */
export function isVisibleOnFrame(scope: RoiScope, frame: number): boolean {
  return scope.kind === "global" || scope.frame === frame;
}

/** uid に帰属を割り当てた新しい対応表を返す（無変化なら同一参照）。 */
export function assignScope(map: RoiScopeMap, uid: string, scope: RoiScope): RoiScopeMap {
  if (sameScope(scopeOf(map, uid), scope)) {
    // グローバルは既定値なのでキー自体を持たない表現に正規化する。
    if (scope.kind === "global" && uid in map) {
      const next = { ...map };
      delete next[uid];
      return next;
    }
    return map;
  }
  if (scope.kind === "global") {
    if (!(uid in map)) {
      return map;
    }
    const next = { ...map };
    delete next[uid];
    return next;
  }
  return { ...map, [uid]: scope };
}

/**
 * グローバル ⇔ フレーム指定を反転する。グローバル → フレーム指定は `currentFrame` に紐づける。
 *
 * <p>既にフレーム指定のものは、現在フレームと一致するかに関わらず**グローバルへ戻す**。別フレームの ROI を
 * 黙って現在フレームへ付け替えると、一覧から操作した利用者にとって「別の ROI が動いた」ように見えるため。
 */
export function toggleScope(map: RoiScopeMap, uid: string, currentFrame: number): RoiScopeMap {
  const cur = scopeOf(map, uid);
  return assignScope(map, uid, cur.kind === "global" ? frameScope(currentFrame) : GLOBAL_SCOPE);
}

/** 生存している uid 以外のエントリを落とす（無変化なら同一参照）。 */
export function pruneScopes(map: RoiScopeMap, aliveUids: readonly string[]): RoiScopeMap {
  const alive = new Set(aliveUids);
  const keys = Object.keys(map);
  if (keys.every((k) => alive.has(k))) {
    return map;
  }
  const next: Record<string, RoiScope> = {};
  for (const k of keys) {
    if (alive.has(k)) {
      next[k] = map[k];
    }
  }
  return next;
}

/**
 * Cornerstone の annotation metadata のうち、video viewport の表示フィルタが見る部分。
 * （`@cornerstonejs/core` の `ViewReference` の部分型。ここでは型依存を持たないため自前で宣言する）
 */
export interface RoiAnnotationReference {
  /** 0-based の参照フレーム。**undefined なら全フレームで表示**される。 */
  sliceIndex?: number;
  /** 範囲参照（再生中に作られることがある）。フレーム固定の邪魔になるので帰属反映時に落とす。 */
  multiSliceReference?: unknown;
}

/**
 * 帰属を annotation metadata に反映する（**表示フィルタの実体はこれ**。`visibility` ではない）。
 *
 * <p>`VideoViewport.isReferenceViewable()` は `sliceIndex` があればそのフレームだけを可視とし、
 * 無ければ（かつ referencedImageId にフレーム番号が無ければ）全フレームで可視とする。よって
 * グローバル ROI は `sliceIndex` を**消す**のが正しい。
 *
 * @returns 変更が生じたか（呼び側が再描画の要否を判断できるように）
 */
export function applyScopeToReference(ref: RoiAnnotationReference, scope: RoiScope): boolean {
  if (scope.kind === "global") {
    const changed = ref.sliceIndex !== undefined || ref.multiSliceReference !== undefined;
    delete ref.sliceIndex;
    delete ref.multiSliceReference;
    return changed;
  }
  const sliceIndex = Math.max(0, Math.round(scope.frame) - 1);
  const changed = ref.sliceIndex !== sliceIndex || ref.multiSliceReference !== undefined;
  ref.sliceIndex = sliceIndex;
  delete ref.multiSliceReference;
  return changed;
}

/** frame（1-based）で表示すべき uid だけを、渡された順序のまま返す。 */
export function visibleUids(
  map: RoiScopeMap,
  uids: readonly string[],
  frame: number,
): string[] {
  return uids.filter((uid) => isVisibleOnFrame(scopeOf(map, uid), frame));
}

/** 帰属の内訳（UI の要約表示用）。 */
export interface RoiScopeCounts {
  global: number;
  thisFrame: number;
  otherFrame: number;
}

/** frame（1-based）から見た内訳を数える。 */
export function scopeCounts(
  map: RoiScopeMap,
  uids: readonly string[],
  frame: number,
): RoiScopeCounts {
  const out: RoiScopeCounts = { global: 0, thisFrame: 0, otherFrame: 0 };
  for (const uid of uids) {
    const s = scopeOf(map, uid);
    if (s.kind === "global") {
      out.global++;
    } else if (s.frame === frame) {
      out.thisFrame++;
    } else {
      out.otherFrame++;
    }
  }
  return out;
}
