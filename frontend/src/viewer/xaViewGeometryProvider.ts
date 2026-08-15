/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * DICOM タグから XA の**投影幾何**（`xaGeometry.ts` の `XaViewGeometry`）を組み立てる層。
 * A6a・`fw/angio-design.md` §10.1 の表がそのまま入力になる。
 *
 * <p>校正（`xaCalibrationProvider.ts`）とは別物なので分けてある。あちらは「mm/px をどう決めるか」、
 * こちらは「線源と検出器がどこにあるか」。**3D 再構成は校正値を使わない**（検出器面の
 * `ImagerPixelSpacing` と SID/SOD だけで決まる。校正済み `PixelSpacing` を使うと二重補正になる）。
 */

import { type XaViewGeometry } from "./xaGeometry";
import { xaDataSetOf } from "./xaCine";

interface MinimalDataSet {
  string(tag: string): string | undefined;
  floatString(tag: string, index?: number): number | undefined;
  uint16?(tag: string): number | undefined;
}

/** 幾何が組めなかった理由。UI にそのまま出す（「使えません」だけだと直しようがない）。 */
export type XaGeometryMissing =
  | "noDataSet"
  | "noAngles"
  | "noDistances"
  | "noImagerSpacing"
  | "noImageSize";

export interface XaViewGeometryResult {
  geometry: XaViewGeometry | null;
  missing: XaGeometryMissing | null;
  /** 角度がフレームごとに変わる収集（回転 DSA など）か。 */
  perFrameAngles: boolean;
}

function num(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * `imageId` のフレームに対応する投影幾何を作る。
 *
 * @param frameIndex 0 origin。`PositionerPrimaryAngleIncrement (0018,1520)` があるときだけ効く
 *
 * <p>⚠️ **主点は画像中心と仮定している。** `FieldOfView*` による切り出しや、装置側の
 * 画像回転・反転があるとずれる。ずれた主点は**モデル全体の系統誤差**になるので、
 * ここを直すときは §10.3 の実測をやり直すこと。
 */
export function readXaViewGeometry(imageId: string, frameIndex = 0): XaViewGeometryResult {
  const ds = (xaDataSetOf(imageId) as unknown as MinimalDataSet) ?? null;
  if (!ds) return { geometry: null, missing: "noDataSet", perFrameAngles: false };

  const primary = num(ds.floatString("x00181510"));
  const secondary = num(ds.floatString("x00181511"));
  if (primary == null || secondary == null) {
    return { geometry: null, missing: "noAngles", perFrameAngles: false };
  }

  // 回転収集では 1 フレームごとの角度増分が並ぶ。あればフレームに合わせて足す。
  let dPrimary = 0;
  let dSecondary = 0;
  let perFrameAngles = false;
  const incP = num(ds.floatString("x00181520", frameIndex));
  const incS = num(ds.floatString("x00181521", frameIndex));
  if (incP != null || incS != null) {
    perFrameAngles = true;
    dPrimary = incP ?? 0;
    dSecondary = incS ?? 0;
  }

  const sid = num(ds.floatString("x00181110"));
  const sod = num(ds.floatString("x00181111"));
  if (sid == null || sod == null || !(sid > 0) || !(sod > 0) || !(sid > sod)) {
    // SID ≤ SOD は物理的にあり得ない（線源→検出器より線源→患者のほうが遠い）。
    return { geometry: null, missing: "noDistances", perFrameAngles };
  }

  const spRow = num(ds.floatString("x00181164", 0));
  const spCol = num(ds.floatString("x00181164", 1)) ?? spRow;
  if (spRow == null || spCol == null || !(spRow > 0) || !(spCol > 0)) {
    return { geometry: null, missing: "noImagerSpacing", perFrameAngles };
  }

  const rows = num(ds.uint16?.("x00280010") ?? ds.floatString("x00280010"));
  const cols = num(ds.uint16?.("x00280011") ?? ds.floatString("x00280011"));
  if (rows == null || cols == null || !(rows > 0) || !(cols > 0)) {
    return { geometry: null, missing: "noImageSize", perFrameAngles };
  }

  return {
    geometry: {
      primaryAngleDeg: primary + dPrimary,
      secondaryAngleDeg: secondary + dSecondary,
      sidMm: sid,
      sodMm: sod,
      imagerSpacingMm: [spRow, spCol],
      principalPoint: [cols / 2, rows / 2],
    },
    missing: null,
    perFrameAngles,
  };
}
