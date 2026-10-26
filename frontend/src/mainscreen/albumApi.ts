/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { httpGet, httpSend } from "../http";

/** backend の AlbumDto。 */
export interface Album {
  id: number;
  name: string;
  createdAt: string;
  count: number;
}

export interface AddResult {
  added: number;
  alreadyIn: number;
}

/** 1 回の追加・削除で送れる UID の上限（backend の AlbumService と同じ）。 */
export const ALBUM_UIDS_PER_REQUEST = 1000;

export function splitUids(uids: readonly string[], size = ALBUM_UIDS_PER_REQUEST): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < uids.length; i += size) out.push(uids.slice(i, i + size));
  return out;
}

export const listAlbums = () => httpGet<Album[]>("/api/albums");
export const createAlbum = (name: string) => httpSend<Album>("/api/albums", "POST", { name });
export const renameAlbum = (id: number, name: string) => httpSend<Album>(`/api/albums/${id}`, "PUT", { name });
export const deleteAlbum = (id: number) => httpSend(`/api/albums/${id}`, "DELETE");
export const albumStudyUids = (id: number) => httpGet<string[]>(`/api/albums/${id}/studies`);

export async function addToAlbum(id: number, uids: readonly string[]): Promise<AddResult> {
  const total: AddResult = { added: 0, alreadyIn: 0 };
  for (const chunk of splitUids(Array.from(new Set(uids)))) {
    const r = await httpSend<AddResult>(`/api/albums/${id}/studies`, "POST", { studyUids: chunk });
    total.added += r.added;
    total.alreadyIn += r.alreadyIn;
  }
  return total;
}

export async function removeFromAlbum(id: number, uids: readonly string[]): Promise<number> {
  let removed = 0;
  for (const chunk of splitUids(Array.from(new Set(uids)))) {
    const r = await httpSend<{ removed: number }>(`/api/albums/${id}/studies/remove`, "POST", { studyUids: chunk });
    removed += r.removed;
  }
  return removed;
}
