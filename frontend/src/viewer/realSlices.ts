/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * T/C ごとに実画像のある Z だけを巡るための純関数。
 *
 * <p>`layout.zStack(c, t)` は、その (c, t) に無い Z をブランク画像で埋めて長さ nZ を保つ（「同じ Z の番号 = 同じ
 * 物理断面」を T/C 間で保つため）。刻みの違う 2 つの造影相が 1 シリーズに入っていると、片方の相では実画像と
 * ブランクが交互に並び、スライス送りや再生でちらつく。`zStack` と nZ は変えず、送りだけ実画像を巡る。
 */
import type { SeriesLayout } from "./seriesLayout";

/**
 * (c, t) に実画像のある Z の昇順一覧。欠損が無い・欠損の有無が分からない（`hasImage` が無い）・実画像が 1 枚も
 * 無いときは `null`（= 全 Z を従来どおり巡る）。
 */
export function realZs(
  layout: Pick<SeriesLayout, "nZ" | "hasImage">,
  c: number,
  t: number,
): number[] | null {
  const has = layout.hasImage;
  if (!has) return null;
  const out: number[] = [];
  for (let z = 0; z < layout.nZ; z++) if (has(c, t, z)) out.push(z);
  return out.length === 0 || out.length === layout.nZ ? null : out;
}

/** 一覧上で d 枚進んだ Z（端で止まる）。現在の Z が一覧に無ければ、進む向きの側で最も近い実画像を 1 枚目と数える。 */
export function stepReal(list: readonly number[], z: number, d: number): number {
  const last = list.length - 1;
  const i = list.indexOf(z);
  if (i >= 0) return list[Math.max(0, Math.min(last, i + d))];
  if (d > 0) {
    const k = list.findIndex((x) => x > z);
    return k < 0 ? list[last] : list[Math.min(last, k + d - 1)];
  }
  let k = -1;
  for (let j = 0; j <= last; j++) if (list[j] < z) k = j;
  return k < 0 ? list[0] : list[Math.max(0, k + d + 1)];
}

/** 一覧上で 1 枚進んだ Z（末尾の次は先頭に戻る。再生用）。 */
export function nextRealLoop(list: readonly number[], z: number): number {
  const k = list.findIndex((x) => x > z);
  return k < 0 ? list[0] : list[k];
}

/**
 * Z が一覧に無いとき、物理位置（法線方向の mm）が最も近い実画像の Z。同じ距離なら小さい Z。
 * IPP か法線が無い・取れない Z があるときは、Z の番号が最も近いもの。
 */
export function nearestReal(
  list: readonly number[],
  z: number,
  ippAt?: (z: number) => [number, number, number] | null,
  normal?: [number, number, number] | null,
): number {
  if (list.includes(z)) return z;
  const pos = (zz: number): number | null => {
    const p = ippAt?.(zz);
    return p && normal ? p[0] * normal[0] + p[1] * normal[1] + p[2] * normal[2] : null;
  };
  // 物理位置は、現在の Z と一覧の全部で取れるときだけ使う（単位を混ぜない）。
  const here = pos(z);
  const physical = here !== null && list.every((zz) => pos(zz) !== null);
  const dist = (zz: number): number => (physical ? Math.abs((pos(zz) as number) - (here as number)) : Math.abs(zz - z));
  let best = list[0];
  for (const zz of list) if (dist(zz) < dist(best)) best = zz;
  return best;
}
