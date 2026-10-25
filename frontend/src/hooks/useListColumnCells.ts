/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** 一覧に足したタグ列の値の取得フック（表示中の行のぶんだけ。設定・行・再読込キーが変わったら取り直す）。 */
import { fetchSeriesColumns, fetchStudyColumns, type ColumnCells } from "../api";
import { toRequestColumns, type ListColumn } from "../mainscreen/listColumns";
import { useAsyncData } from "./useAsyncData";

export interface UseListColumnCellsResult {
  /** スタディ UID（シリーズ一覧ではシリーズ UID）→ 列 id → セル。未取得は null。 */
  cells: ColumnCells | null;
  error: string | null;
}

/** スタディ一覧用: 表示中のスタディごとのセル。列が無い・行が無いときは取得しない。 */
export function useStudyColumnCells(
  studyUids: readonly string[],
  columns: readonly ListColumn[],
  reloadKey?: number,
): UseListColumnCellsResult {
  const key = columns.length === 0 || studyUids.length === 0
    ? null
    : JSON.stringify([studyUids, toRequestColumns(columns), reloadKey ?? 0]);
  const { data, error } = useAsyncData(key, () => fetchStudyColumns([...studyUids], toRequestColumns(columns)));
  return { cells: data, error };
}

/** シリーズ一覧用: 1 スタディのシリーズごとのセル。 */
export function useSeriesColumnCells(
  studyUid: string,
  columns: readonly ListColumn[],
  reloadKey?: number,
): UseListColumnCellsResult {
  const key = columns.length === 0 ? null : JSON.stringify([studyUid, toRequestColumns(columns), reloadKey ?? 0]);
  const { data, error } = useAsyncData(key, () => fetchSeriesColumns(studyUid, toRequestColumns(columns)));
  return { cells: data, error };
}
