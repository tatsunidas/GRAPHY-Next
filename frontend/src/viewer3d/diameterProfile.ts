/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 血管の 1 区間の「弧長 対 径」の組み立て（純関数）。径プロファイルの帯が使う。
 *
 * <p>弧長は点列の隣り合う点のユークリッド距離の累積（患者 LPS mm）。径は点ごと（`null` = 測れなかった点）。
 * 🔴 **測れなかった点（null・非有限）は線を切る。補間しない・0 で埋めない**——補間すると「測っていない所に径がある」ように
 * 見え、0 で埋めると「そこで血管が閉じている」ように見える。値の意味（狭窄率・正常範囲）は解釈しない。
 */
export interface ProfilePoint {
  arcMm: number;
  d: number;
}

export interface DiameterProfile {
  /** 点ごとの弧長（0 始まり）。 */
  arcMm: number[];
  /** 連続して測れた点の並び。測れなかった点で分かれる（線を引く単位）。 */
  runs: ProfilePoint[][];
  /** 有効点の最小（同値は最初の点）。有効点が無ければ null。 */
  min: (ProfilePoint & { index: number }) | null;
  /** 有効点の最大（軸の範囲用）。有効点が無ければ null。 */
  max: number | null;
  lengthMm: number;
  nValid: number;
}

const valid = (d: number | null | undefined): d is number => typeof d === "number" && Number.isFinite(d);

/** 点列と径の長さが違う・点が 2 つ未満・点に非有限が混ざるときは null（描かない。黙って揃えない）。 */
export function diameterProfile(
  points: readonly (readonly number[])[],
  diameterMm: readonly (number | null)[],
): DiameterProfile | null {
  if (points.length < 2 || points.length !== diameterMm.length) return null;
  if (!points.every((p) => p.length >= 3 && p.slice(0, 3).every((c) => Number.isFinite(c)))) return null;
  const arcMm: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    arcMm.push(arcMm[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  const runs: ProfilePoint[][] = [];
  let cur: ProfilePoint[] = [];
  let min: DiameterProfile["min"] = null;
  let max: number | null = null;
  let nValid = 0;
  diameterMm.forEach((d, i) => {
    if (!valid(d)) {
      if (cur.length) runs.push(cur);
      cur = [];
      return;
    }
    cur.push({ arcMm: arcMm[i], d });
    nValid++;
    if (min === null || d < min.d) min = { index: i, arcMm: arcMm[i], d };
    if (max === null || d > max) max = d;
  });
  if (cur.length) runs.push(cur);
  return { arcMm, runs, min, max, lengthMm: arcMm[arcMm.length - 1], nValid };
}

/** 弧長 x に最も近い点の添字（点が無ければ -1）。 */
export function nearestIndex(arcMm: readonly number[], x: number): number {
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < arcMm.length; i++) {
    const d = Math.abs(arcMm[i] - x);
    if (d < bd) {
      bd = d;
      best = i;
    }
  }
  return best;
}
