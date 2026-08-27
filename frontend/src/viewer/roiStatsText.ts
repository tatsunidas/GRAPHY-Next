/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 統計 → 表示文字列。**純関数**（テスト対象）。
 *
 * <p>ROI 脇の textBox（Cornerstone）と、ビューポート右下の一覧、計測結果ダイアログが
 * **同じ整形を通る**ようにするためのモジュール。整形が分かれると「脇の値とダイアログの値が
 * 違う」という、最も信用を落とす種類の食い違いになる。
 *
 * <h3>単位の扱い</h3>
 * <ul>
 *   <li>長さ・面積は**画素間隔があるときだけ mm / mm²**。無ければ `px` / `px²` と明示する
 *       （mm を捏造しない ＝ `roiRead.ts` と同じ方針）。</li>
 *   <li>画素値の単位は {@link ./pixelCalibration.resolveValueUnit} が決めた文字列をそのまま。
 *       `"raw"` は**未校正**の印なので、数字だけを出さず「未校正」と分かる表記にする。</li>
 * </ul>
 */
import type { TFn } from "../i18n/i18n";
import type { RoiStatsDetail } from "./roiStatsDisplay";
import type { RoiStatsResult, RoiValueStats } from "./roiStats";

/** 有効数字を保ちつつ短く。大きい値は桁を落とし、小さい値は潰さない。 */
export function formatNumber(v: number, maxDigits = 2): string {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1000) return v.toFixed(0);
  if (a >= 1) return trimZeros(v.toFixed(maxDigits));
  // 1 未満は有効数字 3 桁（SUV 0.0421 のような値を 0.04 に潰さない）。
  return trimZeros(v.toPrecision(3));
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/** 画素値の単位表示。未校正（"raw"）と単位不明（""）を区別する。 */
export function valueUnitLabel(unit: string, t: TFn): string {
  if (unit === "raw") return t("roiStats.unit.raw");
  return unit;
}

/** `43.2 HU` / `43.2（未校正）`。 */
export function formatValue(v: number, unit: string, t: TFn): string {
  const u = valueUnitLabel(unit, t);
  return u ? `${formatNumber(v)} ${u}` : formatNumber(v);
}

/** `43.2 ± 11.8 HU`。 */
export function formatMeanSd(s: RoiValueStats, t: TFn): string {
  const u = valueUnitLabel(s.unit, t);
  const body = `${formatNumber(s.mean)} ± ${formatNumber(s.sd)}`;
  return u ? `${body} ${u}` : body;
}

/** 面積の表示（mm² が無ければ px²）。出せなければ null。 */
export function formatArea(r: RoiStatsResult): string | null {
  if (r.geometry.areaMm2 !== undefined) return `${formatNumber(r.geometry.areaMm2)} mm²`;
  if (r.geometry.areaPx2 !== undefined) return `${formatNumber(r.geometry.areaPx2)} px²`;
  return null;
}

/** 長さ（閉なら周囲長・開なら線長）の表示。出せなければ null。 */
export function formatLength(r: RoiStatsResult): string | null {
  if (r.geometry.perimeterMm !== undefined) return `${formatNumber(r.geometry.perimeterMm)} mm`;
  if (r.geometry.perimeterPx !== undefined) return `${formatNumber(r.geometry.perimeterPx)} px`;
  return null;
}

/** mm 値の表示（無ければ null）。 */
function mm(v: number | undefined): string | null {
  return v === undefined ? null : `${formatNumber(v)} mm`;
}

/**
 * ROI 脇 / 隅一覧に出す行。純関数。
 *
 * <p>`compact` は**2〜3 行**に抑える（画像の上に載るので、増やすと画像が読めなくなる）。
 * `full` は全項目。値が取れていない項目は**行ごと落とす**（"—" を並べない）。
 */
export function roiStatsTextLines(
  r: RoiStatsResult | undefined,
  detail: RoiStatsDetail,
  t: TFn,
): string[] {
  if (!r || r.geometry.kind === "none") return [];
  const lines: string[] = [];
  const g = r.geometry;
  const v = r.values;

  if (g.kind === "area") {
    const a = formatArea(r);
    if (a) lines.push(`${t("roiStats.area")}: ${a}`);
  } else if (g.kind === "line") {
    const l = formatLength(r);
    if (l) lines.push(`${t("roiStats.length")}: ${l}`);
  }

  if (v) {
    if (g.kind === "point") {
      lines.push(formatValue(v.mean, v.unit, t));
    } else {
      lines.push(`${t("roiStats.mean")}: ${formatMeanSd(v, t)}`);
    }
  }

  if (detail === "compact") return lines;

  if (v && g.kind !== "point") {
    lines.push(`${t("roiStats.min")}: ${formatValue(v.min, v.unit, t)}`);
    lines.push(`${t("roiStats.max")}: ${formatValue(v.max, v.unit, t)}`);
    lines.push(`${t("roiStats.median")}: ${formatValue(v.median, v.unit, t)}`);
    lines.push(`${t("roiStats.n")}: ${v.n}`);
  }
  if (g.kind === "area") {
    const l = formatLength(r);
    if (l) lines.push(`${t("roiStats.perimeter")}: ${l}`);
  }
  const lon = mm(g.longAxisMm);
  const sho = mm(g.shortAxisMm);
  if (lon && sho) lines.push(`${t("roiStats.axes")}: ${lon} × ${sho}`);
  return lines;
}

/** 隅一覧の 1 行（`#3 ラベル  12.4 mm²  43.2 ± 11.8 HU`）に使う短い要約。純関数。 */
export function roiStatsSummary(r: RoiStatsResult | undefined, t: TFn): string {
  if (!r || r.geometry.kind === "none") return "";
  const parts: string[] = [];
  const size = r.geometry.kind === "area" ? formatArea(r) : formatLength(r);
  if (size) parts.push(size);
  if (r.values) {
    parts.push(r.geometry.kind === "point" ? formatValue(r.values.mean, r.values.unit, t) : formatMeanSd(r.values, t));
  }
  return parts.join("  ");
}
