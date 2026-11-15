/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// メイン一覧の自動更新の判定（純関数。画面から切り離してテストする）。
//
// backend の保管庫の変更の通し番号（`GET /api/studies/version`）が、一覧を最後に読み込んだ時の番号より進んだら、
// 新しい検査が届いたか、検査が消えたことになる。一覧を読み込み直すと、選択・ページ・アルバム用のチェックが
// 初期化されるので、待機中（何も選んでいない・1 ページ目・チェックなし）のときだけ自動で読み直し、
// 操作中は状態バーの通知にとどめる。転送の途中は番号が動き続けるので、前回の問い合わせから番号が動かなく
// なる（落ち着く）のを待ってから読み直す（検査 1 件ごとに何度も読み直さない）。

export interface StoreVersionSnapshot {
  version: number;
  changedAt: number;
}

export interface StoreRefreshState {
  /** 一覧を最後に読み込んだ時点の番号（まだ分からなければ null）。 */
  baseline: number | null;
  /** 前回の問い合わせで見た番号。 */
  lastSeen: number | null;
}

export type StoreRefreshAction = "none" | "auto" | "notify";

export const INITIAL_STATE: StoreRefreshState = { baseline: null, lastSeen: null };

/**
 * 問い合わせの結果を 1 回ぶん進める。
 *
 * - 最初の応答は基準にする（開く前に届いていた分では促さない）。
 * - 番号が基準より小さい（backend の再起動・DB の切り替え）ときは、基準を引き直す。
 * - 基準より進んでいて、待機中なら、落ち着いたとき `auto`（まだ動いていれば `none`）。操作中なら `notify`。
 */
export function step(state: StoreRefreshState, latest: number, idle: boolean): { state: StoreRefreshState; action: StoreRefreshAction } {
  if (state.baseline === null || latest < state.baseline) {
    return { state: { baseline: latest, lastSeen: latest }, action: "none" };
  }
  const settled = state.lastSeen === latest;
  const next: StoreRefreshState = { baseline: state.baseline, lastSeen: latest };
  if (latest === state.baseline) return { state: next, action: "none" };
  if (!idle) return { state: next, action: "notify" };
  return { state: next, action: settled ? "auto" : "none" };
}

/** 一覧を読み込み直したので、いま見えている番号を基準にする。 */
export function acknowledge(state: StoreRefreshState): StoreRefreshState {
  return { baseline: state.lastSeen ?? state.baseline, lastSeen: state.lastSeen };
}

/** 待機中か: 検査を選んでいない・1 ページ目・アルバム用のチェックなし。 */
export function isIdle(args: { selected: boolean; listBusy: boolean }): boolean {
  return !args.selected && !args.listBusy;
}
