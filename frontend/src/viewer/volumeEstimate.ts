/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 径から体積を見積もる（球・楕円体）。ROI 統計ダイアログの「体積の見積り」の計算部分。
//
// 🔴 これは**見積り**で、マスクから数えた体積ではない。球・回転楕円体という**仮定**に依存するので、
//   値と仮定を必ず並べて出す（describeEstimate）。式はこのプロジェクトの定義:
//     球       V = π d³ / 6
//     楕円体   V = π a b c / 6     （a・b・c は 3 つの径＝直径。半径ではない）
//   mm³ → mL は ÷1000。径が有限の正数でなければ null（0・負・非数を黙って 0 にしない）。

const MM3_PER_ML = 1000;

function valid(...d: number[]): boolean {
  return d.every((x) => typeof x === "number" && Number.isFinite(x) && x > 0);
}

/** 球の体積（mL）。径 d は mm。 */
export function sphereVolumeMl(dMm: number): number | null {
  return valid(dMm) ? (Math.PI * dMm ** 3) / 6 / MM3_PER_ML : null;
}

/** 楕円体の体積（mL）。3 つの径 a・b・c は mm。 */
export function ellipsoidVolumeMl(aMm: number, bMm: number, cMm: number): number | null {
  return valid(aMm, bMm, cMm) ? (Math.PI * aMm * bMm * cMm) / 6 / MM3_PER_ML : null;
}

export type EstimateKind = "sphere" | "ellipsoid";

export interface EstimateResult {
  kind: EstimateKind;
  volumeMl: number;
  /** 使った径（mm）。球は 1 つ、楕円体は 3 つ。 */
  diametersMm: number[];
}

/** 径の入力から見積りを作る。径が不正・不足なら null。 */
export function estimate(kind: EstimateKind, diametersMm: number[]): EstimateResult | null {
  const v = kind === "sphere"
    ? (diametersMm.length === 1 ? sphereVolumeMl(diametersMm[0]) : null)
    : (diametersMm.length === 3 ? ellipsoidVolumeMl(diametersMm[0], diametersMm[1], diametersMm[2]) : null);
  return v === null ? null : { kind, volumeMl: v, diametersMm: [...diametersMm] };
}

const fmt = (v: number, digits: number): string => {
  const s = v.toFixed(digits);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
};

/** 画面・ROI の属性に出す 1 行。値と仮定を並べる（仮定を省かない）。 */
export function describeEstimate(r: EstimateResult, lang: "ja" | "en" = "ja"): string {
  const vol = fmt(r.volumeMl, 2);
  // 径は 2 桁で出す: 表示した径から手計算した体積が、表示した体積と食い違わないようにする。
  const d = r.diametersMm.map((x) => fmt(x, 2));
  if (lang === "en") {
    return r.kind === "sphere"
      ? `≈ ${vol} mL (assuming a sphere: φ${d[0]} mm)`
      : `≈ ${vol} mL (assuming an ellipsoid: ${d.join(" × ")} mm)`;
  }
  return r.kind === "sphere"
    ? `≈ ${vol} mL（球の仮定: φ${d[0]} mm）`
    : `≈ ${vol} mL（楕円体の仮定: ${d.join(" × ")} mm）`;
}
