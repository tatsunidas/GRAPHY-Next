/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * スタディ検索の取得フック（`fw/mobile-ui-design.md` §3.5）。
 *
 * <p>元は `StudyList.tsx` にコンポーネント内直書きだったもの。デスクトップの 3 階層入れ子
 * （`StudyList` → `SeriesNavigator` → `InstanceList`）のままではモバイルの単画面ナビゲーションから
 * 使えないため、取得だけを切り出して両方から使う。
 *
 * <p>HTTP 層（`api.ts` / `http.ts` / `apiBase.ts`）は既に完全分離されていて、
 * **web / standalone の差は backend が吸収している**ので、モード差の再実装は不要。
 */
import { fetchReportStudyCounts, fetchStudies, type Study, type StudyFilters, type StudyReportCount } from "../api";
import { useAsyncData } from "./useAsyncData";
import { useEffect, useState } from "react";

export interface UseStudiesResult {
  /** 検索結果。**null は「まだ検索していない」**（0 件とは区別する）。 */
  studies: Study[] | null;
  error: string | null;
  loading: boolean;
  /** `withReportCounts` を指定したときのみ埋まる。取得失敗時は空のまま（補助情報なので握り潰す）。 */
  reportCounts: Record<string, StudyReportCount>;
  reload: () => void;
}

/**
 * @param filters `null` / `undefined` は「まだ検索していない」＝取得しない。
 * @param opts.reloadKey        値が変わると再取得する（DB 変更通知など外部要因の再読込用）。
 * @param opts.withReportCounts レポート有無の ●/○ 表示用カウントも取る。
 */
export function useStudies(
  filters: StudyFilters | null | undefined,
  opts?: { reloadKey?: number; withReportCounts?: boolean },
): UseStudiesResult {
  const reloadKey = opts?.reloadKey ?? 0;
  const key = filters == null ? null : `${JSON.stringify(filters)}|${reloadKey}`;
  const { data, error, loading, reload } = useAsyncData(key, () => fetchStudies(filters!));

  const [reportCounts, setReportCounts] = useState<Record<string, StudyReportCount>>({});
  const withCounts = opts?.withReportCounts === true;
  useEffect(() => {
    setReportCounts({});
    if (!withCounts || !data || data.length === 0) return;
    let cancelled = false;
    // レポート有無は補助情報。取得に失敗してもスタディ一覧自体は表示する。
    fetchReportStudyCounts(data.map((s) => s.studyInstanceUid))
      .then((counts) => {
        if (cancelled) return;
        const map: Record<string, StudyReportCount> = {};
        for (const c of counts) map[c.studyInstanceUid] = c;
        setReportCounts(map);
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [data, withCounts]);

  return { studies: data, error, loading, reportCounts, reload };
}
