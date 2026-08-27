/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * QCA の**入力の選び分け**（`fw/angio-design.md` §8.7）。純関数だけを置く。
 *
 * <h3>なぜ分けるのか（実機で踏んだ・2026-08-27）</h3>
 * 解析ダイアログの `Input` は画像上の **Length 計測**を並べるだけだったので、
 * **役割の違う 2 種類の線が同じ一覧に混ざっていた**:
 *
 * <ul>
 *   <li><b>空間校正</b> … カテーテルの<b>太さを横切る</b>短い線（6Fr = 2.0mm）</li>
 *   <li><b>QCA の解析区間</b> … 血管に<b>沿って</b>、狭窄を挟んで健常部から健常部まで（数十 mm）</li>
 * </ul>
 *
 * <p>実機では**カテーテル校正用に引いた 9.2px の線がそのまま解析区間として使われ**、
 * 10 点しか測れないまま `MLD 5.02mm > RVD 4.90mm`／`%DS 0.0%` という
 * **内部整合した無意味な結果**が出た。エラーは何も出ない。
 * 一覧が `#1 — 9.2 px` としか言わないので、利用者にも見分けようがなかった。
 *
 * <h3>決めたこと</h3>
 * <ul>
 *   <li><b>解析区間は開いた輪郭も許す</b>（長さ / ポリゴンライン / フリーライン）。
 *       曲がった血管を 2 点の直線で表すのが無理だった。</li>
 *   <li>🔴 <b>空間校正は Length に限る。</b> 既知の長さ（カテーテル径）は<b>直線距離</b>で、
 *       曲線の「長さ」は経路長なので意味が違う。フリーラインで校正すると
 *       <b>手ぶれのぶんだけ mm/px が小さく出て、以後のすべての計測が小さくなる</b>。</li>
 *   <li><b>閉じた輪郭は除く。</b> 中心線は閉じない。</li>
 * </ul>
 */
import { CONTOUR_TOOL_NAMES } from "./roiContourTools";

/** 解析区間として使える線の種類。 */
export type QcaSegmentKind = "line" | "polyline" | "freeline";

/**
 * ツール名 → 解析区間の種類。使えないツールは null。純関数。
 *
 * <p>**閉じた輪郭（ポリゴン・フリーハンド）は入れない**——中心線として意味を成さない。
 */
export function segmentKindOf(toolName: string | undefined | null): QcaSegmentKind | null {
  const t = (toolName ?? "").trim();
  if (t === "Length") return "line";
  if (t === CONTOUR_TOOL_NAMES.polyline) return "polyline";
  if (t === CONTOUR_TOOL_NAMES.freeLine) return "freeline";
  return null;
}

/** 空間校正に使えるか。🔴 **直線（Length）だけ**（上記の理由）。純関数。 */
export function canCalibrateWith(kind: QcaSegmentKind | null): boolean {
  return kind === "line";
}

/** 折れ線の経路長 [px]。直線なら 2 点間距離と一致する。純関数。 */
export function pathLengthPx(points: ReadonlyArray<readonly [number, number]>): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  return total;
}

/**
 * フリーラインの頂点を間引くときの既定間隔 [px]。
 *
 * <p>🔴 **全頂点を中間点として渡すと、中心線は「利用者の手描きそのもの」になる。**
 * 手ぶれが径プロファイルへ直接乗り、MLD が跳ねる。間引くと節の間は経路探索が画像に沿うので、
 * **手描きの意図は保ったまま滑らかになる**。
 *
 * <p>ポリゴンラインは頂点が元々まばら（利用者が 1 つずつ置いた点）なので**間引かない**。
 */
export const FREELINE_WAYPOINT_SPACING_PX = 12;

/** {@link toQcaKnots} の結果。`runQca` の `start` / `end` / `edits.waypoints` にそのまま渡す。 */
export interface QcaKnots {
  start: [number, number];
  end: [number, number];
  waypoints: [number, number][];
}

/**
 * 線の頂点列を `runQca` の節（始点・中間点・終点）へ落とす。純関数。
 *
 * <p>`runQca` は節ごとに最小経路を引くので、**中間点は「経路探索への制約」**であって
 * 中心線そのものではない。だから密に渡しすぎてはいけない（{@link FREELINE_WAYPOINT_SPACING_PX}）。
 *
 * @param spacingPx フリーラインの間引き間隔。0 以下なら間引かない
 */
export function toQcaKnots(
  points: ReadonlyArray<readonly [number, number]>,
  kind: QcaSegmentKind,
  spacingPx = FREELINE_WAYPOINT_SPACING_PX,
): QcaKnots | null {
  if (points.length < 2) return null;
  const start: [number, number] = [points[0][0], points[0][1]];
  const last = points[points.length - 1];
  const end: [number, number] = [last[0], last[1]];
  if (kind === "line" || points.length === 2) return { start, end, waypoints: [] };

  const inner = points.slice(1, -1);
  // ポリゴンラインは利用者が置いた点そのものなので、1 つも落とさない。
  if (kind === "polyline") return { start, end, waypoints: inner.map((p) => [p[0], p[1]]) };

  // フリーラインは弧長で間引く（頂点数ではなく**距離**で切る。描く速さで頂点密度が変わるため）。
  const waypoints: [number, number][] = [];
  if (!(spacingPx > 0)) return { start, end, waypoints: inner.map((p) => [p[0], p[1]]) };
  let acc = 0;
  let prev = points[0];
  for (const p of inner) {
    acc += Math.hypot(p[0] - prev[0], p[1] - prev[1]);
    prev = p;
    if (acc >= spacingPx) {
      waypoints.push([p[0], p[1]]);
      acc = 0;
    }
  }
  return { start, end, waypoints };
}

/**
 * 解析区間として短すぎないか。純関数。
 *
 * <p>プロファイルは法線方向へ ±`profileRadiusPx` 取るので、**区間長がそれ以下だと
 * 幾何として成立しない**（実機では 9.2px の区間で 10 点しか測れず、
 * `MLD > RVD` の無意味な結果が出た）。余裕を見て**半径の 3 倍**を下限にする。
 */
export function minSegmentPx(profileRadiusPx = 20): number {
  return profileRadiusPx * 3;
}

/** 解析区間が短すぎるか。純関数。 */
export function segmentTooShort(lengthPx: number, profileRadiusPx = 20): boolean {
  return !(lengthPx >= minSegmentPx(profileRadiusPx));
}

/** 結果が信用できない理由（{@link suspiciousQcaReasons} の戻り値）。 */
export type QcaSuspicion = "mldNotBelowRvd" | "tooFewSamples" | "noLesion";

/** 「信用できない」と言うためのサンプル点数の下限。 */
export const MIN_SAMPLE_POINTS = 20;

/**
 * **単独では正常値に見えるが、組み合わせは異常**という結果を拾う。純関数。
 *
 * <p>QCA の中心線はコスト最小経路なので、血管から外れていても「それらしい」経路を必ず引く
 * （`QcaEditor` の冒頭に既述）。したがって**失敗より、もっともらしく間違うほうが危険**。
 * 実機で出たのは `MLD 5.02 > RVD 4.90` / `sample 10` / `lesion 0.00` の組み合わせで、
 * どれも単体では「あり得る値」に見える。
 */
export function suspiciousQcaReasons(r: {
  mld: number;
  rvd: number;
  lesionLength: number;
  diameters: readonly number[];
}): QcaSuspicion[] {
  const out: QcaSuspicion[] = [];
  // 狭窄を測っているのに最小径が参照径以上 ＝ 参照径の当てはめか中心線が破綻している。
  if (r.mld >= r.rvd) out.push("mldNotBelowRvd");
  if (r.diameters.length < MIN_SAMPLE_POINTS) out.push("tooFewSamples");
  // 病変長 0 は「狭窄が無い」ではなく「参照径を下回る点が 1 つも無い」＝当てはめの破綻。
  if (!(r.lesionLength > 0)) out.push("noLesion");
  return out;
}
