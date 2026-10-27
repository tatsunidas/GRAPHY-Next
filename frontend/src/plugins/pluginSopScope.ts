/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H37 `saveAngioReport` の参照 SOP が「同じ検査（スタディ）に実在するか」の検査。
 *
 * <p>書き手（backend）は参照インスタンスから患者・スタディを継承するので、他患者・他検査の SOP を
 * 渡されると**その検査にレポートが生える**。守るのはそこで、「いま開いているタイル」である必要はない
 * （3D QCA の方向 B は別シリーズ＝未表示のことがある）。
 *
 * <p>🔴 読めなかったとき（通信失敗）は**通さない**（読めない ≠ 同じ検査）。
 */
export interface SopScopeSource {
  listSeriesUids: (studyUid: string) => Promise<string[]>;
  listSopUids: (studyUid: string, seriesUid: string) => Promise<string[]>;
}

/** 同じスタディに無い（空・null を含む）最初の SOP。全部あれば null。 */
export async function firstSopOutsideStudy(
  refs: (string | null | undefined)[],
  studyUid: string,
  src: SopScopeSource,
): Promise<string | null> {
  if (refs.some((r) => !r)) return "(none)";
  const wanted = new Set(refs as string[]);
  if (wanted.size === 0) return null;
  const found = new Set<string>();
  for (const seriesUid of await src.listSeriesUids(studyUid)) {
    for (const sop of await src.listSopUids(studyUid, seriesUid)) found.add(sop);
    if ([...wanted].every((w) => found.has(w))) return null;
  }
  return [...wanted].find((w) => !found.has(w)) ?? null;
}
