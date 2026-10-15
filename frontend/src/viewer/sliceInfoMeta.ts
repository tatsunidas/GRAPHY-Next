/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * imageId のメタデータから `sliceGeometry` の入力（SliceInfo）を作る。
 * 画像（メタデータ）がロード済みであること。wadouri の imagePlaneModule は SpacingBetweenSlices を持たないので、
 * キャッシュ済みデータセットから生で読む。読み方は `cornerstoneSetup` が登録する（ここで画像ローダを import すると、
 * テストでデコード用ワーカが立ち上がってしまう）。
 */
import { metaData } from "@cornerstonejs/core";
import type { SliceInfo } from "./sliceGeometry";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

let sbsReader: ((imageId: string) => number | undefined) | null = null;
/** SpacingBetweenSlices（符号付き）を生のデータセットから読む関数を登録する。 */
export function setSpacingBetweenSlicesReader(fn: (imageId: string) => number | undefined): void {
  sbsReader = fn;
}

const nums = (a: unknown): number[] | null =>
  Array.isArray(a) || ArrayBuffer.isView(a) ? Array.from(a as ArrayLike<number>, Number) : null;

export function sliceInfoOfImageId(id: string): SliceInfo {
  const p = (metaData.get("imagePlaneModule", id) ?? {}) as AnyObj;
  const sop = ((metaData.get("sopCommonModule", id) ?? {}) as AnyObj).sopInstanceUID as string | undefined;
  const st = Number(p.sliceThickness);
  return {
    id,
    sop: sop ?? null,
    ipp: nums(p.imagePositionPatient),
    iop: nums(p.imageOrientationPatient),
    sliceThickness: Number.isFinite(st) ? st : null,
    spacingBetweenSlices: p.spacingBetweenSlices ?? sbsReader?.(id) ?? null,
  };
}

export function sliceInfosOf(ids: ReadonlyArray<string>): SliceInfo[] {
  return ids.map(sliceInfoOfImageId);
}
