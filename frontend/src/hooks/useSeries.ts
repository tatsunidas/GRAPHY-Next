/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** スタディ配下のシリーズ一覧の取得フック（`fw/mobile-ui-design.md` §3.5）。 */
import { fetchSeries, type Series } from "../api";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export interface UseSeriesResult extends Omit<AsyncData<Series[]>, "data"> {
  /** null は未取得（`studyUid` が無い、または読み込み中）。 */
  series: Series[] | null;
}

/** @param studyUid `null` / `undefined` なら取得しない（スタディ未選択）。 */
export function useSeries(studyUid: string | null | undefined): UseSeriesResult {
  const key = studyUid ?? null;
  const { data, error, loading, reload } = useAsyncData(key, () => fetchSeries(studyUid!));
  return { series: data, error, loading, reload };
}
