/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ある 1 点（患者座標 LPS mm）の時間方向の値を、各時相の画像の幾何で読む（純関数・cornerstone を import しない）。
 *
 * <p>点は患者座標で持ち、各時相の画像の IOP/IPP/PixelSpacing で画素へ戻して双一次で読む。
 * 時相の画像が点の断面から面外に外れていたら NaN にし、別の断面の値で埋めない。
 * 画素・スライス番号の計算は、この入出力の薄い層だけに置く。
 */
import type { Vec3 } from "./regTransform";

/** 1 枚の画像の幾何。画素 (x=列, y=行) の world = ipp + x·pixelSpacingCol·iop[0..2] + y·pixelSpacingRow·iop[3..5]。 */
export interface PlaneMeta {
  iop: [number, number, number, number, number, number];
  ipp: Vec3;
  pixelSpacingCol: number;
  pixelSpacingRow: number;
  cols: number;
  rows: number;
}

export interface PlaneSlice {
  plane: PlaneMeta;
  /** 校正済みの値（行優先、cols×rows）。 */
  values: ArrayLike<number>;
}

export interface TimePoint {
  t: number;
  /** 読めなければ NaN（画像が無い・面外・画像の外）。 */
  value: number;
  /** 点から画像の面までの符号付き距離 [mm]。画像が無ければ NaN。 */
  outOfPlaneMm: number;
}

/** 画像上の画素 (x=列, y=行、小数可) → LPS mm。 */
export function pixelToWorld(p: PlaneMeta, x: number, y: number): Vec3 {
  const u = x * p.pixelSpacingCol;
  const v = y * p.pixelSpacingRow;
  return [
    p.ipp[0] + u * p.iop[0] + v * p.iop[3],
    p.ipp[1] + u * p.iop[1] + v * p.iop[4],
    p.ipp[2] + u * p.iop[2] + v * p.iop[5],
  ];
}

/** LPS mm → 画素 (x=列, y=行、連続 index) と、面からの符号付き距離 [mm]（法線 = 行方向余弦 × 列方向余弦）。 */
export function worldToPixel(p: PlaneMeta, w: Vec3): { x: number; y: number; outOfPlaneMm: number } {
  const d: Vec3 = [w[0] - p.ipp[0], w[1] - p.ipp[1], w[2] - p.ipp[2]];
  const r: Vec3 = [p.iop[0], p.iop[1], p.iop[2]];
  const c: Vec3 = [p.iop[3], p.iop[4], p.iop[5]];
  const n: Vec3 = [
    r[1] * c[2] - r[2] * c[1],
    r[2] * c[0] - r[0] * c[2],
    r[0] * c[1] - r[1] * c[0],
  ];
  const nl = Math.hypot(n[0], n[1], n[2]) || 1;
  return {
    x: (d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / p.pixelSpacingCol,
    y: (d[0] * c[0] + d[1] * c[1] + d[2] * c[2]) / p.pixelSpacingRow,
    outOfPlaneMm: (d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / nl,
  };
}

/** 双一次補間。範囲は画素中心の [0, cols−1] × [0, rows−1]。外なら NaN（NaN を含む画素に触れれば NaN も伝わる）。 */
export function sampleBilinear(values: ArrayLike<number>, cols: number, rows: number, x: number, y: number): number {
  if (!(x >= 0 && y >= 0 && x <= cols - 1 && y <= rows - 1)) return NaN;
  const x0 = Math.min(Math.floor(x), Math.max(0, cols - 2));
  const y0 = Math.min(Math.floor(y), Math.max(0, rows - 2));
  const x1 = Math.min(x0 + 1, cols - 1);
  const y1 = Math.min(y0 + 1, rows - 1);
  const fx = x - x0;
  const fy = y - y0;
  const v00 = values[y0 * cols + x0];
  const v10 = values[y0 * cols + x1];
  const v01 = values[y1 * cols + x0];
  const v11 = values[y1 * cols + x1];
  return (1 - fy) * ((1 - fx) * v00 + fx * v10) + fy * ((1 - fx) * v01 + fx * v11);
}

/**
 * 点 `world` の時間曲線。`slices[t]` は各時相の「同じ断面のはずの画像」（無ければ null）。
 *
 * @param maxOutOfPlaneMm 面外距離の上限（通常はスライス間隔の半分）。これを超えた時相は NaN。
 *   null なら距離で弾かない（上限が分からないとき。距離は返す）。
 */
export function timeCurveAt(
  world: Vec3,
  slices: ReadonlyArray<PlaneSlice | null>,
  maxOutOfPlaneMm: number | null,
): TimePoint[] {
  return slices.map((s, t) => {
    if (!s) return { t, value: NaN, outOfPlaneMm: NaN };
    const px = worldToPixel(s.plane, world);
    if (maxOutOfPlaneMm !== null && Math.abs(px.outOfPlaneMm) > maxOutOfPlaneMm) {
      return { t, value: NaN, outOfPlaneMm: px.outOfPlaneMm };
    }
    return { t, value: sampleBilinear(s.values, s.plane.cols, s.plane.rows, px.x, px.y), outOfPlaneMm: px.outOfPlaneMm };
  });
}
