/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/** Raw データの型と 1 画素のバイト数（backend の RawSpec と同じ並び）。 */
export const RAW_TYPES = {
  uint8: 1,
  int8: 1,
  uint16: 2,
  int16: 2,
  uint32: 4,
  int32: 4,
  float32: 4,
  float64: 8,
} as const;

export type RawType = keyof typeof RAW_TYPES;

export interface RawDims {
  width: number;
  height: number;
  slices: number;
  phases: number;
  type: RawType;
  offset: number;
}

/** 画素を読むのに要るバイト数（読み飛ばし＋幅×高さ×枚数×時相×型の大きさ）。入力が正しくなければ null。 */
export function rawRequiredBytes(d: RawDims): number | null {
  const ints = [d.width, d.height, d.slices, d.phases, d.offset];
  if (!ints.every((v) => Number.isInteger(v))) return null;
  if (d.width < 1 || d.height < 1 || d.slices < 1 || d.phases < 1 || d.offset < 0) return null;
  const bytes = RAW_TYPES[d.type];
  if (!bytes) return null;
  const total = d.offset + d.width * d.height * d.slices * d.phases * bytes;
  return Number.isSafeInteger(total) ? total : null;
}

export type RawSizeStatus =
  | { kind: "exact" }
  | { kind: "short"; missing: number }
  | { kind: "trailing"; extra: number };

/** 必要なバイト数とファイルの大きさの比べ。short なら取り込めない。trailing は申告の誤りの手がかり。 */
export function rawSizeStatus(required: number, fileBytes: number): RawSizeStatus {
  if (required > fileBytes) return { kind: "short", missing: required - fileBytes };
  if (required < fileBytes) return { kind: "trailing", extra: fileBytes - required };
  return { kind: "exact" };
}
