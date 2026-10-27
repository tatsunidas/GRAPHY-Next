/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";

export interface Album {
  id: number;
  name: string;
  createdAt: string;
  /** 所属の数。スタディが削除されて宙ぶらりんになったものも数える。 */
  count: number;
}

export const fetchAlbums = () => httpGet<Album[]>("/api/albums");

export const createAlbum = (name: string) => httpSend<Album>("/api/albums", "POST", { name });

export const renameAlbum = (id: number, name: string) => httpSend<Album>(`/api/albums/${id}`, "PUT", { name });

/** アルバムだけを消す。スタディ本体（画像・索引）は消えない。 */
export const deleteAlbum = (id: number) => httpSend(`/api/albums/${id}`, "DELETE");

/** 所属の StudyInstanceUID（追加順）。存在しないスタディの UID も含む。 */
export const fetchAlbumStudies = (id: number) => httpGet<string[]>(`/api/albums/${id}/studies`);

export const addToAlbum = (id: number, studyUids: string[]) =>
  httpSend<{ added: number; alreadyIn: number }>(`/api/albums/${id}/studies`, "POST", { studyUids });

/** 所属から外す。スタディ本体は消えない。 */
export const removeFromAlbum = (id: number, studyUids: string[]) =>
  httpSend<{ removed: number }>(`/api/albums/${id}/studies/remove`, "POST", { studyUids });

/** API の 1 回あたりの上限（backend の `AlbumService.UIDS_MAX`）。これを超える要求は分けて送る。 */
export const ALBUM_UIDS_PER_REQUEST = 1000;

export function chunkUids(uids: readonly string[], size = ALBUM_UIDS_PER_REQUEST): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < uids.length; i += size) out.push(uids.slice(i, i + size));
  return out;
}
