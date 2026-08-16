/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QVA（末梢・脳血管の定量解析）の**純ロジック**（`fw/angio-design.md` §9.1 / A5a）。
 *
 * <h3>QCA との違いは 2 つだけ</h3>
 * 1. **参照径の決め方**。冠動脈は「区間の大半が健常」を前提にできるが、末梢では
 *    **紡錘状の瘤が区間の大半を占める**ことがある。そうなると瘤自身が参照径を押し上げ、
 *    「参照径に対する拡張」という量が測れなくなる。QVA は**区間の両端**を健常と見なす
 *    （`qca.ts` の `referenceFromEnds`）。
 * 2. **指標**。狭窄（MLD/%DS）に加えて**拡張（瘤）**を測る。中心線・エッジ抽出は QCA の
 *    ものをそのまま使う ——「同じ画像から違う中心線が出る」ほうが害が大きい。
 *
 * <h3>🚨 プラグインの Aneurysm Detector とは別物</h3>
 * あちらは **3D-RA のボリューム**から瘤を検出する（`fw/plugin-explainer.md`）。こちらは
 * **2D 投影**の径プロファイルを測るだけで、検出はしない（人が区間を指定する）。
 * UI の文言でも必ず区別する ——同じ「動脈瘤」でも、出せる主張がまるで違う。
 *
 * <h3>限界（画面と保存物の両方に出す）</h3>
 * <ul>
 *   <li>投影 1 方向の計測なので、**瘤の最大径が投影面内にあるとは限らない**
 *       （見えている向きでの最大径であって、瘤の最大径ではない）。</li>
 *   <li>偏心度は**ネックとネックを結ぶ直線**を血管軸と見なして測る。曲がった血管の瘤では
 *       この直線が実際の軸から外れるので、**蛇行が強いほど偏心度は過大に出る**。</li>
 *   <li>径の絶対値には半値法の系統誤差（約 13% 過小・§16.4）がそのまま乗る。
 *       比ではおおむね打ち消されるが、**係数が径に依存する**ので数 % 残る
 *       （ファントム実測: 3mm で 0.870、6mm で 0.908 ——比は +4〜6% 過大に出た）。</li>
 * </ul>
 */

import { dilationBounds, type QcaResult } from "./qca";

/** 「動脈瘤」と呼ぶ比（参照径の 1.5 倍以上）。**基準そのものを必ず一緒に表示する。** */
export const ANEURYSM_RATIO = 1.5;
/** 「拡張（ectasia）」と呼ぶ比。瘤に至らない拡張を黙って瘤にしない。 */
export const ECTASIA_RATIO = 1.2;

/** 拡張（瘤）の計測結果。単位は元の {@link QcaResult} と同じ（mm / px）。 */
export interface QvaDilation {
  /** 最大径。 */
  maxDiameter: number;
  /** 最大径の計測点インデックス。 */
  maxIndex: number;
  /** 最大径の位置（区間始点からの距離）。 */
  maxPosition: number;
  /** 最大径の位置での参照径。 */
  referenceAtMax: number;
  /** 参照径に対する比（最大径 / 参照径）。**系統誤差が打ち消される量**。 */
  ratio: number;
  /** 拡張率 [%]（比 − 1）。 */
  percentDilation: number;
  /** 参照径を上回る連続区間の長さ。 */
  length: number;
  /** その区間の近位端・遠位端の径（ネック）。 */
  proximalNeck: number;
  distalNeck: number;
  /** 偏心度 0..1（0 = 全周性＝紡錘状、1 に近いほど片側だけ＝嚢状）。測れなければ null。 */
  eccentricity: number | null;
  /** 参照径の 1.5 倍以上か。 */
  aneurysmal: boolean;
  /** 参照径の 1.2 倍以上か（瘤に至らない拡張）。 */
  ectatic: boolean;
}

/**
 * 径プロファイルから拡張（瘤）を測る。拡張が無ければ null。
 *
 * <p>⚠️ 「拡張が無い」は**参照径を上回る点が 1 つも無い**ことではなく、
 * {@link dilationBounds} が 1 点の区間しか返さない ——つまり**幅を持たない**ことで判定する。
 * 参照径のすぐ上を揺れているだけのプロファイルで「長さ 0 の瘤」を報告しない。
 */
export function analyzeDilation(result: QcaResult): QvaDilation | null {
  const { diameters, reference } = result;
  const n = diameters.length;
  if (n < 3 || reference.length !== n) return null;

  // 🔴 **解析区間の端に接する拡張は測らない**（実測で踏んだ）。
  //    区間の端は径が太く出る（357 点中の端 6 点が 2.61 → 2.82mm。§10.2.8 と同じ現象）ので、
  //    そのまま最大径を採ると**拡張の無い血管に「瘤」が生える**。それだけでなく、
  //    端に接する膨らみは**ネックが区間の外にある**ので、瘤長もネック径も定義できない。
  //    端に当たった候補は除外して、内側の次の候補を探す。
  const excluded = new Array<boolean>(n).fill(false);
  for (;;) {
    let maxIndex = -1;
    for (let i = 0; i < n; i++) {
      if (excluded[i]) continue;
      if (maxIndex < 0 || diameters[i] > diameters[maxIndex]) maxIndex = i;
    }
    if (maxIndex < 0) return null;
    const referenceAtMax = reference[maxIndex];
    const maxDiameter = diameters[maxIndex];
    if (!(referenceAtMax > 0) || !(maxDiameter > referenceAtMax)) return null;

    const bounds = dilationBounds(diameters, reference, maxIndex);
    if (bounds.lo === 0 || bounds.hi === n - 1 || bounds.hi <= bounds.lo) {
      // この候補は端に接している（または幅を持たない）。区間ごと除外して次を探す。
      for (let i = bounds.lo; i <= bounds.hi; i++) excluded[i] = true;
      continue;
    }
    return describe(result, maxIndex, bounds.lo, bounds.hi);
  }
}

function describe(result: QcaResult, maxIndex: number, lo: number, hi: number): QvaDilation {
  const { diameters, reference, positions } = result;
  const maxDiameter = diameters[maxIndex];
  const referenceAtMax = reference[maxIndex];
  const ratio = maxDiameter / referenceAtMax;
  return {
    maxDiameter,
    maxIndex,
    maxPosition: positions[maxIndex] ?? 0,
    referenceAtMax,
    ratio,
    percentDilation: (ratio - 1) * 100,
    length: Math.abs((positions[hi] ?? 0) - (positions[lo] ?? 0)),
    proximalNeck: diameters[lo],
    distalNeck: diameters[hi],
    eccentricity: eccentricityOf(result, maxIndex, lo, hi),
    aneurysmal: ratio >= ANEURYSM_RATIO,
    ectatic: ratio >= ECTASIA_RATIO,
  };
}

/**
 * 偏心度 = |内腔中心の軸からのずれ| / (半径の増分)。0 = 全周性（紡錘状）、1 = 片側だけ（嚢状）。
 *
 * <h3>🔴 「左右の張り出しを比べる」では測れない（2026-08-16 に実測で分かった）</h3>
 * 最初は**追跡した中心線からの左右の張り出し**を比べていた。合成の箱型ファントムでは
 * 嚢状で 0.5 以上になったのに、**実ファントム（ビール則の円柱）では 0.05〜0.10 しか出ず、
 * 紡錘状と区別できなかった**。原因は中心線の引き方で、経路探索は**最も暗い筋**＝内腔の中心を
 * 通るので、瘤が片側に膨らむと**中心線ごと瘤の中へ移動する**。中心線を基準にする限り、
 * 内腔はいつでも左右対称に見える。
 *
 * <p>そこで**ネックとネックを結ぶ直線**（＝瘤の外側の血管軸）を基準にし、
 * **内腔中心がその軸からどれだけ離れたか**を測る。片側だけの膨らみでは
 * 内腔中心が半径の増分とちょうど同じだけ動くので比は 1、全周性なら動かないので 0 になる。
 *
 * <p>⚠️ 曲がった血管ではネック間の直線が実際の軸から外れるので、**蛇行が強いほど過大**に出る。
 */
function eccentricityOf(result: QcaResult, maxIndex: number, lo: number, hi: number): number | null {
  const offsets = result.edgeOffsets;
  const line = result.centerline;
  const normals = result.normals;
  if (!offsets || !line || !normals) return null;
  if (offsets.length !== result.diameters.length || line.length !== offsets.length) return null;

  const o = offsets[maxIndex];
  const span = o.right - o.left;
  if (!(span > 0)) return null;
  // px → mm（{@link QcaResult} は換算係数を持たないので径から復元する）。
  const scale = result.diameters[maxIndex] / span;
  const growth = (result.diameters[maxIndex] - result.reference[maxIndex]) / 2;
  if (!(growth > 0)) return null;

  // ネック間の直線（画像 px）。
  const ax = line[lo][0];
  const ay = line[lo][1];
  const bx = line[hi][0];
  const by = line[hi][1];
  const len = Math.hypot(bx - ax, by - ay);
  if (!(len > 0)) return null;

  // 最大径の点での内腔中心（中心線から法線方向に (left+right)/2 だけずれた点）。
  const cx = line[maxIndex][0] + normals[maxIndex][0] * ((o.left + o.right) / 2);
  const cy = line[maxIndex][1] + normals[maxIndex][1] * ((o.left + o.right) / 2);
  // 直線からの垂直距離 [px] → mm。
  const distPx = Math.abs((bx - ax) * (ay - cy) - (ax - cx) * (by - ay)) / len;
  const e = (distPx * scale) / growth;
  return Math.max(0, Math.min(1, e));
}
