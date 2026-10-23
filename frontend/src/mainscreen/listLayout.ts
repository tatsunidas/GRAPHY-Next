/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * メイン画面のデータ一覧の表示形式と、保存値の扱い。判定は純関数にしてある（vitest が見るのは `.ts` だけ）。
 *
 * - `table`: 検査の表の末尾にシリーズ一覧を置く（従来の表示）。
 * - `split`: 検査の表の下に、シリーズ一覧を独立したペインで常に見せる（上下 2 ペイン）。
 * - `side`: 検査の表の右に、シリーズ一覧を独立したペインで常に見せる（左右 2 ペイン）。
 * - `tree`: 選んだ検査の行の直下に、シリーズを子ノードとして開く。
 */
export type ListLayout = "table" | "split" | "side" | "tree";

/** 切り替えの並び順。 */
export const LIST_LAYOUTS: readonly ListLayout[] = ["table", "split", "side", "tree"];

/** シリーズ一覧を独立したペインに描く形式。 */
export const isPaneLayout = (l: ListLayout): boolean => l === "split" || l === "side";

export const LIST_LAYOUT_STORAGE_KEY = "graphy.mainListLayout";

/** localStorage の値を読む。未保存・壊れた値・未知の値は従来の表示（table）。 */
export function parseListLayout(raw: string | null | undefined): ListLayout {
  return LIST_LAYOUTS.find((l) => l === raw) ?? "table";
}

/** ツリー形式で、選んだ検査の行の直下にシリーズを開くか。選んだ検査が今のページに無いときは行が無いので false。 */
export function isTreeOpen(layout: ListLayout, selectedUid: string | null | undefined, pageUids: readonly string[]): boolean {
  return layout === "tree" && !!selectedUid && pageUids.includes(selectedUid);
}

/** 画像として開けないことが modality から分かるシリーズ（自動選択の対象から外す）。 */
const NON_IMAGE_MODALITIES = new Set(["SR", "PR", "KO", "RTSTRUCT", "RTPLAN"]);

/** 検査を選んだとき最初に開くシリーズ。画像でないものを除いた先頭。無ければ null（選ばない）。 */
export function pickFirstImageSeries<T extends { modality?: string | null }>(series: readonly T[]): T | null {
  return series.find((s) => !NON_IMAGE_MODALITIES.has((s.modality ?? "").toUpperCase())) ?? null;
}
