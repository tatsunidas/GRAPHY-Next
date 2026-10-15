/**
 * タイルの単独表示（ヘッダのダブルクリックで 1 枚だけ領域いっぱいに出す）の状態遷移。
 * 状態は「単独にしているタイルの ID（無ければ null）」だけで、行×列やタイルの順序は一切書き換えない。
 */

/** ダブルクリックでの切替。タイルが 1 枚以下なら何も変えない。 */
export function toggleSolo(current: string | null, tileId: string, tileCount: number): string | null {
  if (tileCount <= 1) return current;
  return current === tileId ? null : tileId;
}

/** 単独のタイルが一覧に無ければ（消された・置き換えられた）通常表示に戻す。 */
export function reconcileSolo(current: string | null | undefined, tileIds: readonly string[]): string | null {
  if (!current) return null;
  return tileIds.includes(current) ? current : null;
}
