/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 範囲つきで開いたシリーズから、MPR・3D・Slicer に渡すボリューム用の imageId 列を作る。
 *
 * <p>範囲の掛け方は 2D と同じ {@link restrictLayout}。imageId 列は範囲なしの経路
 * （(c,t) の cells を z 昇順に並べる）と同じ作り方で、範囲内の z だけを残す
 * （欠損の位置にブランクを挟むと、範囲なしのボリュームと違う奥行きになるため）。
 * レイアウトが取れない・範囲が合わないときは**失敗を返す**。全体を黙って組み直さない。
 */
import type { SeriesLayoutDto } from "../api";
import { buildLayoutFromDto } from "./seriesLayout";
import { imageIdForCell, type ViewerMode } from "./imageId";
import { restrictLayout, type RestrictFailure, type ZRange } from "./virtualLayout";

export type RangedStack =
  | { ok: true; imageIds: string[]; total: number }
  | { ok: false; reason: RestrictFailure };

export function rangedStackIds(
  dto: SeriesLayoutDto | null | undefined,
  mode: ViewerMode,
  studyUid: string,
  seriesUid: string,
  c: number,
  t: number,
  range: ZRange,
): RangedStack {
  const layout = buildLayoutFromDto(dto, mode, studyUid, seriesUid);
  if (!dto || !layout) return { ok: false, reason: "invalid" };
  const r = restrictLayout(layout, range);
  if (!r.ok) return { ok: false, reason: r.reason };
  const keep = new Set(r.keptZ);
  const imageIds = dto.cells
    .filter((cell) => cell.c === c && cell.t === t && keep.has(cell.z))
    .slice()
    .sort((a, b) => a.z - b.z)
    .map((cell) => imageIdForCell(mode, cell.sopInstanceUid, cell.frame, studyUid, seriesUid));
  return { ok: true, imageIds, total: r.total };
}
