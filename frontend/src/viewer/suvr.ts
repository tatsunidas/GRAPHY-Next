/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * SUVR（参照領域比）の純関数。
 *
 * <p>SUVR = 画素値 ÷ 参照領域の平均。SUV 校正の単一入口（suvStore）に乗数として載せるので、
 * 参照の平均は**今の校正込みの値**（統計エンジンが返す値）を受け、`scale = 今の乗数 ÷ 参照の平均` を返す。
 * SUV を先に掛けてあっても、乗数が打ち消し合って同じ SUVR になる。
 */
import { pooledValueStats, type PooledInput } from "./roiGroups";
import type { PaintedRoiRow, RoiPanelModel, ShapeRoiRow } from "./roiRows";

export interface SuvrScaleError {
  error: "refNotPositive";
}

/** 参照の平均（今の校正込み）と今の乗数（無ければ 1）から SUVR の乗数を作る。 */
export function suvrScale(refMean: number, currentScale?: number): { scale: number } | SuvrScaleError {
  if (!Number.isFinite(refMean) || !(refMean > 0)) return { error: "refNotPositive" };
  const cur = currentScale !== undefined && currentScale > 0 ? currentScale : 1;
  return { scale: cur / refMean };
}

/** 参照にできる ROI の 1 件（面の形・塗り ROI の segment）。 */
export interface RefMember {
  key: string;
  label: string;
  kind: "shape" | "painted";
  /** shape: 注釈 UID。painted: マスク ID と segment（単一 segment なら undefined＝マスク全体）。 */
  uid?: string;
  maskId?: string;
  segmentIndex?: number;
}

/** 参照の候補。1 件、または ROI グループ（メンバーの画素を 1 つの集団とみなす）。 */
export interface RefCandidate {
  key: string;
  label: string;
  members: RefMember[];
  group: boolean;
}

/**
 * この PET シリーズに属する ROI／VOI／グループを候補にする。
 * 別シリーズ・線・点・計測・球（画素を持たない）は入れない。
 * @param labelOf 形の ROI の表示名（ROI マネージャと同じ名前）。
 */
export function referenceCandidates(
  model: RoiPanelModel,
  seriesUid: string,
  labelOf: (shapeUid: string) => string,
): RefCandidate[] {
  const members: Array<{ m: RefMember; groupId?: string; groupName?: string }> = [];
  for (const r of model.rois) {
    if (r.rowKind === "shape") {
      const s = r as ShapeRoiRow;
      if (s.kind !== "area" || s.seriesUid !== seriesUid) continue;
      members.push({ m: { key: s.uid, label: labelOf(s.uid) || s.tool, kind: "shape", uid: s.uid }, groupId: s.groupId, groupName: s.groupName });
    } else if (r.rowKind === "painted") {
      const p = r as PaintedRoiRow;
      if (p.seriesUid !== seriesUid) continue;
      members.push({
        m: { key: p.key, label: p.name, kind: "painted", maskId: p.maskId, segmentIndex: p.single ? undefined : p.segIndex },
        groupId: p.groupId,
        groupName: p.groupName,
      });
    }
  }
  const out: RefCandidate[] = members.map(({ m }) => ({ key: m.key, label: m.label, members: [m], group: false }));
  const byGroup = new Map<string, { name: string; ms: RefMember[] }>();
  for (const { m, groupId, groupName } of members) {
    if (!groupId) continue;
    const g = byGroup.get(groupId) ?? { name: groupName || groupId, ms: [] };
    g.ms.push(m);
    byGroup.set(groupId, g);
  }
  for (const [id, g] of byGroup) out.push({ key: `g:${id}`, label: g.name, members: g.ms, group: true });
  return out;
}

/** メンバー 1 件ぶんの読み出し結果。値なしの理由を持つ（0 で埋めない）。 */
export type MemberValues = PooledInput | { missing: "refNoPixels" };

export interface RefMeasure {
  key: string;
  label: string;
  group: boolean;
  /** 適用に使う値（今の校正込み）。理由があるときは無い。 */
  mean?: number;
  n?: number;
  unit?: string;
  reason?: "refNoPixels" | "refMixedUnits" | "refNotPositive";
}

/** 候補の参照値を決める。読めないメンバーがあれば出さない（体積と別の母集団にしない）。 */
export function measureCandidate(c: RefCandidate, valuesOf: (memberKey: string) => MemberValues | undefined): RefMeasure {
  const base = { key: c.key, label: c.label, group: c.group };
  const vals: PooledInput[] = [];
  for (const m of c.members) {
    const v = valuesOf(m.key);
    if (!v || "missing" in v) return { ...base, reason: "refNoPixels" };
    vals.push(v);
  }
  const pooled = pooledValueStats(vals);
  if (!pooled) return { ...base, reason: "refMixedUnits" };
  if (!(pooled.mean > 0)) return { ...base, reason: "refNotPositive", mean: pooled.mean, n: pooled.n, unit: pooled.unit };
  return { ...base, mean: pooled.mean, n: pooled.n, unit: pooled.unit };
}
