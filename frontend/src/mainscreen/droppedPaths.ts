/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/** OS からのファイル・フォルダのドラッグか（画面の中の文字列などのドラッグと区別する）。 */
export function hasDroppedFiles(types: readonly string[] | DOMStringList | null | undefined): boolean {
  if (!types) return false;
  return Array.from(types as ArrayLike<string>).includes("Files");
}

/** Electron がドロップされた File に付ける絶対パス（`path`）を取り出す。空と重複は除く。 */
export function droppedPaths(files: ArrayLike<File> | null | undefined): string[] {
  const out: string[] = [];
  for (const f of Array.from(files ?? [])) {
    const p = (f as File & { path?: string }).path;
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}
