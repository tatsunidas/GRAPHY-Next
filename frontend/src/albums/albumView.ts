/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { StudyFilters } from "../api";

/** 一覧に表示中のアルバム。 */
export interface AlbumView {
  id: number;
  name: string;
  /** 所属の StudyInstanceUID。存在しないスタディの UID も含む。 */
  uids: string[];
}

/**
 * 空のアルバムが何も当たらないようにするための UID。
 * `studyInstanceUid` を空文字にすると条件ごと捨てられて**全スタディが出てしまう**（`fetchStudies` は空の値を送らない）。
 * 実在しない UID（先頭が 0 の 1 桁）を渡して、確実に 0 件にする。
 */
export const EMPTY_ALBUM_UID = "0";

/** アルバムのスタディだけを出す一覧の条件。検索条件（検査日など）は使わない。 */
export function albumFilters(uids: readonly string[]): StudyFilters {
  const unique = Array.from(new Set(uids.filter((u) => u)));
  return { studyInstanceUid: unique.length > 0 ? unique.join(",") : EMPTY_ALBUM_UID };
}

/** アルバムにあるのに、一覧に出てこなかった（スタディが削除された）UID。アルバムでの並びを保つ。 */
export function missingUids(uids: readonly string[], studies: readonly { studyInstanceUid: string }[]): string[] {
  const found = new Set(studies.map((s) => s.studyInstanceUid));
  return Array.from(new Set(uids)).filter((u) => !found.has(u));
}
