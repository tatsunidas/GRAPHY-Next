/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 統計 → CSV。純関数（`fw/roi-stats-design.md` §6.2）。
 *
 * <p>`fw/roi-manager-design.md` §6 の「CSV / 統計」が未実装のまま残っていた枠を埋める。
 *
 * <h3>決めたこと</h3>
 * <ul>
 *   <li><b>単位は列名に入れる</b>（`mean[HU]`）。セルに単位を混ぜると表計算で数値にならない。</li>
 *   <li><b>列は固定</b>。ROI の種別で列を出し分けると、表計算で縦に並べたとき列がずれる。
 *       出せない値は<b>空セル</b>にする（`0` で埋めない＝「測っていない」と「0 だった」を区別する）。</li>
 *   <li><b>面積と使用画素数は別の列</b>。面積はメッシュ、統計はラスタ画素なので同じ量ではない
 *       （§4.2）。片方だけ出すと、読んだ人がもう片方を推測して間違える。</li>
 *   <li>BOM を付ける。付けないと Excel が UTF-8 の日本語ラベルを化けさせる。</li>
 * </ul>
 */
import type { RoiStatsResult } from "./roiStats";

export interface RoiStatsCsvRow {
  index: number;
  label: string;
  tool: string;
  stats: RoiStatsResult | undefined;
}

/** 値の単位（複数 ROI で混在し得るので、代表を 1 つ選んで列名に入れる）。 */
export function csvValueUnit(rows: ReadonlyArray<RoiStatsCsvRow>): string {
  const units = new Set<string>();
  for (const r of rows) if (r.stats?.values?.unit) units.add(r.stats.values.unit);
  if (units.size === 1) return [...units][0];
  // 混在（PET と CT を並べた等）なら列名では断定せず、単位列を別に立てる。
  return units.size === 0 ? "" : "mixed";
}

/** 1 セル分のエスケープ（RFC 4180）。 */
function cell(v: string | number | undefined | null): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  if (!/[",\n\r]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

const n = (v: number | undefined): string => (v === undefined || !Number.isFinite(v) ? "" : String(v));

/**
 * CSV 本文（BOM 無し）。行は渡された順。
 *
 * <p>長さの単位は「校正できていれば mm、できていなければ px」で ROI ごとに違い得るので、
 * `lengthUnit` 列で ROI ごとに示す（列名に埋めると嘘になる）。
 */
export function roiStatsToCsv(rows: ReadonlyArray<RoiStatsCsvRow>): string {
  const u = csvValueUnit(rows);
  const uSuffix = u && u !== "mixed" ? `[${u}]` : "";
  const header = [
    "#",
    "label",
    "tool",
    "kind",
    "area[mm2]",
    "area[px2]",
    "perimeter",
    "longAxis[mm]",
    "shortAxis[mm]",
    "lengthUnit",
    "samples",
    `mean${uSuffix}`,
    `sd${uSuffix}`,
    `min${uSuffix}`,
    `max${uSuffix}`,
    `median${uSuffix}`,
    `p5${uSuffix}`,
    `p95${uSuffix}`,
    `sum${uSuffix}`,
    "skewness",
    "kurtosis",
    "entropy",
    "valueUnit",
    "imageId",
    "warnings",
  ];
  const lines = [header.map(cell).join(",")];
  for (const r of rows) {
    const g = r.stats?.geometry;
    const v = r.stats?.values;
    lines.push(
      [
        r.index,
        r.label,
        r.tool,
        g?.kind ?? "",
        n(g?.areaMm2),
        n(g?.areaPx2),
        n(g?.perimeterMm ?? g?.perimeterPx),
        n(g?.longAxisMm),
        n(g?.shortAxisMm),
        g ? (g.spatiallyCalibrated ? "mm" : "px") : "",
        n(g?.sampleCount),
        n(v?.mean),
        n(v?.sd),
        n(v?.min),
        n(v?.max),
        n(v?.median),
        n(v?.p5),
        n(v?.p95),
        n(v?.sum),
        n(v?.skewness),
        n(v?.kurtosis),
        n(v?.entropy),
        v?.unit ?? "",
        r.stats?.imageId ?? "",
        (r.stats?.warnings ?? []).join(" "),
      ]
        .map(cell)
        .join(","),
    );
  }
  return lines.join("\r\n");
}

/** ダウンロード用（Excel が UTF-8 を化けさせないよう BOM を付ける）。 */
export function roiStatsCsvBlobText(rows: ReadonlyArray<RoiStatsCsvRow>): string {
  return `﻿${roiStatsToCsv(rows)}\r\n`;
}
