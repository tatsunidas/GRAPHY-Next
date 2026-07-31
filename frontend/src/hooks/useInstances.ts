/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/** シリーズ配下のインスタンス一覧の取得フック（`fw/mobile-ui-design.md` §3.5）。 */
import { fetchInstances, type Instance } from "../api";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export interface UseInstancesResult extends Omit<AsyncData<Instance[]>, "data"> {
  /** null は未取得（UID が揃っていない、または読み込み中）。 */
  instances: Instance[] | null;
}

/** @param studyUid / seriesUid どちらかが無ければ取得しない。 */
export function useInstances(
  studyUid: string | null | undefined,
  seriesUid: string | null | undefined,
): UseInstancesResult {
  // UID に `|` は現れない（DICOM UID は数字とドットのみ）ので、単純連結で一意なキーになる。
  const key = studyUid && seriesUid ? `${studyUid}|${seriesUid}` : null;
  const { data, error, loading, reload } = useAsyncData(key, () =>
    fetchInstances(studyUid!, seriesUid!),
  );
  return { instances: data, error, loading, reload };
}
