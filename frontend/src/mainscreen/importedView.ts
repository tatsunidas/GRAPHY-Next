/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { StudyFilters } from "../api";

/**
 * 一度に絞り込む検査の上限。UID（最長 64 文字）をカンマ区切りで URL に載せるので、
 * サーバーの要求行の上限（Tomcat の既定 8KB）に収まる数にする: 100 × 65 ≒ 6.5KB。
 */
export const MAX_IMPORTED_STUDIES = 100;

export interface ImportedView {
  filters: StudyFilters;
  shown: number;
  total: number;
}

/** 取り込んだ検査だけを出す一覧の条件。取り込んだ検査が無ければ null（今の検索条件のまま）。 */
export function importedStudiesView(uids: readonly string[] | null | undefined): ImportedView | null {
  const unique = Array.from(new Set((uids ?? []).filter((u) => u)));
  if (unique.length === 0) return null;
  const shown = unique.slice(0, MAX_IMPORTED_STUDIES);
  return { filters: { studyInstanceUid: shown.join(",") }, shown: shown.length, total: unique.length };
}
