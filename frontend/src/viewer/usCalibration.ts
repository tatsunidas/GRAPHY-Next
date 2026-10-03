/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 超音波の空間校正（px → mm）。**Sequence of Ultrasound Regions (0018,6011)** から解く。
 *
 * <h3>なぜ要るのか</h3>
 * US Image Storage は `PixelSpacing` を持たないのが普通で、画素の物理寸法は
 * 領域ごとの `PhysicalDeltaX/Y`（単位は `PhysicalUnitsX/YDirection`、3 = cm）にしか無い。
 * ローダの `imagePlaneModule` は `PixelSpacing` しか見ないので、これを読まないと
 * スケールバーも ROI の面積も **px のまま**になる（v0.3.1 までの挙動）。
 *
 * <h3>何を採るか（保守的な規則）</h3>
 * <ul>
 *   <li>採るのは **2-D の空間領域**（RegionSpatialFormat = 1）で、X/Y とも単位が cm のものだけ。
 *       M モード・スペクトル・波形の領域は「距離」ではないので採らない。</li>
 *   <li>そういう領域が 1 つ、または複数でも PhysicalDelta が一致するなら、その値を画像全体に適用する。</li>
 *   <li>複数あって値が違うなら、どれか 1 つを選ぶ根拠が無いので **未校正（px）** にし、
 *       警告 `usRegionsDiffer` を出す。カーソル位置の領域を選ぶ挙動は実装していない。</li>
 * </ul>
 * 結果は XA と同じ {@link XaCalibration} の形で返し、注入と表示は
 * `xaCalibrationProvider` の同じ経路に乗せる（mm を欲しがる側の入口を増やさない）。
 */
import type { XaCalibration } from "./xaCalibration";

/** 1 つの超音波領域（必要な属性だけ）。 */
export interface UsRegion {
  /** RegionSpatialFormat (0018,6012): 1 = 2-D, 2 = M-mode, 3 = spectral, 4 = waveform … */
  spatialFormat: number | null;
  /** RegionDataType (0018,6014): 1 = tissue, 2 = color flow … */
  dataType: number | null;
  minX0: number | null;
  minY0: number | null;
  maxX1: number | null;
  maxY1: number | null;
  /** PhysicalUnitsXDirection (0018,6024): 3 = cm。 */
  unitsX: number | null;
  unitsY: number | null;
  /** PhysicalDeltaX (0018,602C) [単位/px]。 */
  deltaX: number | null;
  deltaY: number | null;
}

const CM = 3;
const EQUAL_REL_EPS = 1e-6;

function isSpatial2d(r: UsRegion): boolean {
  return (
    r.spatialFormat === 1 &&
    r.unitsX === CM &&
    r.unitsY === CM &&
    typeof r.deltaX === "number" &&
    typeof r.deltaY === "number" &&
    Math.abs(r.deltaX) > 0 &&
    Math.abs(r.deltaY) > 0
  );
}

function same(a: number, b: number): boolean {
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 || Math.abs(a - b) / m < EQUAL_REL_EPS;
}

/** 領域の並びから空間校正を解決する。純関数。 */
export function resolveUsCalibration(regions: readonly UsRegion[]): XaCalibration {
  const spatial = regions.filter(isSpatial2d);
  const base = { confidence: "none" as const, plane: "unknown" as const, warnings: [] as XaCalibration["warnings"] };
  if (spatial.length === 0) {
    return {
      ...base,
      mmPerPxRow: null,
      mmPerPxCol: null,
      source: "none",
      tier: "uncalibrated",
      provenance:
        regions.length === 0
          ? "no ultrasound region"
          : "no 2-D spatial ultrasound region in cm",
    };
  }
  const dx = Math.abs(spatial[0].deltaX as number);
  const dy = Math.abs(spatial[0].deltaY as number);
  const allSame = spatial.every((r) => same(Math.abs(r.deltaX as number), dx) && same(Math.abs(r.deltaY as number), dy));
  if (!allSame) {
    return {
      ...base,
      mmPerPxRow: null,
      mmPerPxCol: null,
      source: "none",
      tier: "uncalibrated",
      provenance: `${spatial.length} 2-D ultrasound regions with different PhysicalDelta`,
      warnings: ["usRegionsDiffer"],
    };
  }
  const warnings: XaCalibration["warnings"] = same(dx, dy) ? [] : ["anisotropic"];
  return {
    mmPerPxRow: dy * 10,
    mmPerPxCol: dx * 10,
    source: "us-region",
    confidence: "high",
    plane: "us-region",
    tier: "calibrated",
    provenance:
      `Ultrasound region${spatial.length > 1 ? `s (${spatial.length}, equal spacing)` : ""}: ` +
      `PhysicalDeltaX ${dx} cm, PhysicalDeltaY ${dy} cm`,
    warnings,
  };
}

/** dicom-parser の dataSet から領域を読む（無ければ空配列）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function readUsRegions(ds: any): UsRegion[] {
  const seq = ds?.elements?.x00186011;
  const items: unknown[] = seq?.items ?? [];
  const out: UsRegion[] = [];
  for (const it of items) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = (it as any)?.dataSet;
    if (!d) continue;
    const u16 = (tag: string): number | null => (d.elements?.[tag] ? (d.uint16(tag) as number) : null);
    const u32 = (tag: string): number | null => (d.elements?.[tag] ? (d.uint32(tag) as number) : null);
    const f64 = (tag: string): number | null => (d.elements?.[tag] ? (d.double(tag) as number) : null);
    out.push({
      spatialFormat: u16("x00186012"),
      dataType: u16("x00186014"),
      minX0: u32("x00186018"),
      minY0: u32("x0018601a"),
      maxX1: u32("x0018601c"),
      maxY1: u32("x0018601e"),
      unitsX: u16("x00186024"),
      unitsY: u16("x00186026"),
      deltaX: f64("x0018602c"),
      deltaY: f64("x0018602e"),
    });
  }
  return out;
}
