/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// web の匿名化ジョブ（/api/anonymizer/jobs）まわりの純ロジック。画面（AnonymizerDialog.tsx は vitest の対象外）から切り離す。
import type { AnonJobOutput, AnonJobStatus, AnonMaskPolygon, AnonOption, AnonRequest, AnonSeriesMask } from "../api";
import { withFrameScope } from "../viewer/anonMaskExport";
import type { AnonRoiCandidate } from "./anonRoiCandidates";

/**
 * チェックした ROI をシリーズごとの多角形にまとめる。
 *
 * <p>候補が 1 件もチェックされていないシリーズも空配列で入る（standalone の「置き換え登録」では
 * 空にして外すため。web のジョブでは {@link roiMasksForJob} が空を落とす）。
 * 適用フレームの決め方は `withFrameScope` が正本。
 */
export function groupRoiPolygons(
  cands: readonly AnonRoiCandidate[],
  checked: ReadonlySet<string>,
  drawnFrameOnly: boolean,
): Map<string, AnonMaskPolygon[]> {
  const bySeries = new Map<string, AnonMaskPolygon[]>();
  for (const c of cands) {
    if (!bySeries.has(c.seriesUid)) bySeries.set(c.seriesUid, []);
    if (checked.has(c.roiUid)) {
      bySeries.get(c.seriesUid)!.push(withFrameScope(c.polygon, c.frame, drawnFrameOnly ? "drawnFrameOnly" : "wholeInstance"));
    }
  }
  return bySeries;
}

/** web のジョブに載せるマスク。サーバー側には登録せず、ジョブ要求ごとに渡す。 */
export function roiMasksForJob(
  cands: readonly AnonRoiCandidate[],
  checked: ReadonlySet<string>,
  drawnFrameOnly: boolean,
): AnonSeriesMask[] {
  const out: AnonSeriesMask[] = [];
  for (const [seriesUid, polygons] of groupRoiPolygons(cands, checked, drawnFrameOnly)) {
    if (polygons.length > 0) out.push({ seriesUid, frames: [], rects: [], polygons });
  }
  return out;
}

/** 元と同じ UID のまま PACS へ保存すると元のスタディと混ざる（backend も 400 で止める）。 */
export const stowBlockedByOptions = (options: ReadonlySet<AnonOption>): boolean => options.has("RetainUIDs");

/** ジョブ要求。standalone の `destination` は持たない。焼き込みは CleanPixelData が ON のときだけ。 */
export function buildJobRequest(base: AnonRequest, output: AnonJobOutput, masks: AnonSeriesMask[]): AnonRequest {
  const { destination: _destination, ...rest } = base;
  const burnIn = base.burnIn && base.options.includes("CleanPixelData");
  return { ...rest, burnIn, output, masks: burnIn ? masks : [] };
}

/** 終了したジョブの扱い。文言は画面が i18n で選ぶ。 */
export type JobOutcome =
  | { kind: "zipReady" }
  | { kind: "stowed"; stored: number }
  | { kind: "cancelled"; stored: number }
  | { kind: "failed"; error: string; stored: number };

export function jobOutcome(s: AnonJobStatus): JobOutcome {
  if (s.state === "DONE") return s.output === "stow" ? { kind: "stowed", stored: s.stored } : { kind: "zipReady" };
  if (s.state === "CANCELLED") return { kind: "cancelled", stored: s.stored };
  return { kind: "failed", error: s.error ?? "", stored: s.stored };
}

/** 完了後に必ず見せる注意（片方で上書きしない）。キーは i18n。 */
export function jobNotes(s: AnonJobStatus): { key: string; params: Record<string, string | number> }[] {
  const notes: { key: string; params: Record<string, string | number> }[] = [];
  if (s.notBurnedInstances > 0) notes.push({ key: "anon.burnIn.warn.unmasked", params: { count: s.notBurnedInstances } });
  // 一部フレームだけ塗ったものは「除去済み」と申告していない＝残っている。
  if (s.partiallyBurnedInstances > 0) notes.push({ key: "anon.burnIn.warn.partial", params: { count: s.partiallyBurnedInstances } });
  if (s.errorCount > 0) notes.push({ key: "anon.job.errors", params: { problems: s.errorCount } });
  return notes;
}
