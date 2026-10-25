/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI のグループ化（Cornerstone に触れない純関数）。
 *
 * <p>グループは「同じ `groupId` を持つ ROI の集まり」。名前は所属 ROI が持つので、メンバーがいる間だけ
 * グループが存在する（保存形は {@link ./roiPersistence} の `groupId` / `groupName`）。
 * **グループは 1 人の患者の中だけ**: 保存先が患者単位の文書で、別の患者の ROI を 1 つの集まりに入れると
 * 統計・書き出しで患者が混ざる。
 */

/** グループ化の可否と、付ける鍵・名前。 */
export type GroupPlan =
  | { ok: true; groupId: string; name: string }
  | { ok: false; reason: "tooFew" | "crossPatient" };

/**
 * 選んだ ROI をグループにできるか。2 件未満、または複数の患者にまたがるなら不可。
 * 患者が分からない ROI は数えない（全部不明なら 1 人扱い）。
 */
export function planGroup(
  uids: readonly string[],
  patientOf: (uid: string) => string | undefined,
  newId: () => string,
  defaultName: string,
): GroupPlan {
  if (uids.length < 2) return { ok: false, reason: "tooFew" };
  const patients = new Set<string>();
  for (const u of uids) {
    const pk = patientOf(u);
    if (pk) patients.add(pk);
  }
  if (patients.size > 1) return { ok: false, reason: "crossPatient" };
  return { ok: true, groupId: newId(), name: defaultName };
}

/** 既定名「<prefix> <n>」の次の番号（既存の同形式の最大 + 1。無ければ 1）。 */
export function nextGroupNumber(existingNames: ReadonlyArray<string | undefined>, prefix: string): number {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped} (\\d+)$`);
  let max = 0;
  for (const n of existingNames) {
    const m = re.exec(n ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export interface PooledInput {
  /** 画素数。 */
  n: number;
  mean: number;
  /** 母標準偏差（`histogram.ts` は n で割る）。 */
  sd: number;
  unit: string;
}

export interface PooledStats {
  n: number;
  mean: number;
  sd: number;
  unit: string;
}

/**
 * 複数 ROI の画素を 1 つの集団とみなした平均と SD（純関数）。
 *
 * <p>各 ROI の (n, 平均, 母 SD) から厳密に出せる: 平均 M = Σnᵢmᵢ/N、
 * 分散 = Σnᵢ(σᵢ² + (mᵢ−M)²)/N（ROI 内のばらつき + ROI 間のばらつき）。
 * <b>単位が混ざる</b>（HU と SUV など）、空、n が 0 以下・非有限の値があるときは null
 * （合算すると意味のない数になるので出さない）。
 */
export function pooledValueStats(items: readonly PooledInput[]): PooledStats | null {
  if (items.length === 0) return null;
  const unit = items[0].unit;
  let total = 0;
  let sum = 0;
  for (const it of items) {
    if (it.unit !== unit) return null;
    if (!Number.isFinite(it.n) || it.n <= 0 || !Number.isFinite(it.mean) || !Number.isFinite(it.sd)) return null;
    total += it.n;
    sum += it.n * it.mean;
  }
  const mean = sum / total;
  let ss = 0;
  for (const it of items) ss += it.n * (it.sd * it.sd + (it.mean - mean) * (it.mean - mean));
  return { n: total, mean, sd: Math.sqrt(ss / total), unit };
}

/** 面積の合計。値が無い（画素間隔不明）ものは足さず、件数を返す（0 で埋めない）。 */
export function sumAreaMm2(areas: ReadonlyArray<number | undefined>): { sum: number; counted: number; missing: number } {
  let sum = 0;
  let counted = 0;
  for (const a of areas) {
    if (typeof a === "number" && Number.isFinite(a)) {
      sum += a;
      counted++;
    }
  }
  return { sum, counted, missing: areas.length - counted };
}
