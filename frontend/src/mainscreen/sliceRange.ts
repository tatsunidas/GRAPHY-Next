/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * スライス範囲の入力（`"1-5, 8, 10"`）のパース。旧 GRAPHY の `MaskRoiPanel` の
 * カスタム範囲入力（`txtCustomRange`）と同じ操作体系。
 *
 * <p>🔴 **入力は 1 origin、返すのは 0 origin。** 利用者が見ているスライス番号は 1 始まりだが、
 * DICOM のフレーム index と backend の `frames` は 0 始まり。ここで必ず変換する。
 *
 * <p>⚠ 純関数として切り出してあるのは、vitest の include が `.ts` だけで **`.tsx` を見ない**ため。
 * ダイアログの中に書くとテストできない。
 */

/** パース結果。`invalid` は読めなかった断片（利用者に見せて直させる）。 */
export interface SliceRangeParse {
  /** 0 origin・昇順・重複なし。 */
  indices: number[];
  invalid: string[];
}

/**
 * `"1-5, 8, 10"` を 0 origin の index 配列へ。
 *
 * @param max 上限（1 origin の入力に対する最大スライス番号）。超える指定は捨てる。
 *            渡さなければ上限なし。
 */
export function parseSliceRange(input: string, max?: number): SliceRangeParse {
  const set = new Set<number>();
  const invalid: string[] = [];
  if (!input || !input.trim()) {
    return { indices: [], invalid };
  }
  for (const rawPart of input.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!isValidOneBased(from) || !isValidOneBased(to)) {
        invalid.push(part);
        continue;
      }
      // "5-1" のような逆順も素直に受ける（利用者の打ち間違いで黙って 0 件にしない）。
      const lo = Math.min(from, to);
      const hi = Math.max(from, to);
      let added = false;
      for (let n = lo; n <= hi; n++) {
        if (max !== undefined && n > max) break;
        set.add(n - 1);
        added = true;
      }
      if (!added) invalid.push(part);
      continue;
    }

    const single = /^\d+$/.exec(part);
    if (single) {
      const n = Number(part);
      if (!isValidOneBased(n) || (max !== undefined && n > max)) {
        invalid.push(part);
        continue;
      }
      set.add(n - 1);
      continue;
    }

    invalid.push(part);
  }
  return { indices: [...set].sort((a, b) => a - b), invalid };
}

/** 0 origin の index 配列を `"1-5, 8, 10"` の表示へ戻す（連続は範囲に畳む）。 */
export function formatSliceRange(indices: readonly number[]): string {
  const sorted = [...new Set(indices)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const from = sorted[i] + 1;
    const to = sorted[j] + 1;
    parts.push(from === to ? String(from) : `${from}-${to}`);
    i = j + 1;
  }
  return parts.join(", ");
}

function isValidOneBased(n: number): boolean {
  return Number.isInteger(n) && n >= 1;
}
