/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import type { StudyFilters } from "../api";

/**
 * どのスタディにも一致しない UID。空のアルバムを表示するときの条件に使う。
 * `studyInstanceUid` を空にすると条件が捨てられて**全件が出てしまう**ので、空のままにしない。
 */
export const NO_MATCH_STUDY_UID = "0.0";

export interface AlbumView {
  id: number;
  name: string;
  /** アルバムのメンバー（重複なし） */
  uids: string[];
  /** 一覧に渡す条件。取り込み直後の一覧と同じく StudyInstanceUID の指定で絞る。 */
  filters: StudyFilters;
}

export function albumView(album: { id: number; name: string }, uids: readonly string[]): AlbumView {
  const unique = Array.from(new Set(uids.filter((u) => u)));
  return {
    id: album.id,
    name: album.name,
    uids: unique,
    filters: { studyInstanceUid: unique.length > 0 ? unique.join(",") : NO_MATCH_STUDY_UID },
  };
}

/**
 * アルバムのメンバーのうち、一覧に出てこなかった（見つからない）UID。
 * 一覧がまだ読み込み中（null）のときは判定しない（空配列）。
 */
export function missingUids(memberUids: readonly string[], loaded: readonly { studyInstanceUid: string }[] | null): string[] {
  if (loaded === null) return [];
  const have = new Set(loaded.map((s) => s.studyInstanceUid));
  return memberUids.filter((u) => !have.has(u));
}
