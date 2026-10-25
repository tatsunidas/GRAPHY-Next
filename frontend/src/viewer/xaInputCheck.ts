/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D QCA の入力検査（GN-XA-001 段 P1）。読み取りと警告のみで、結果をブロックしない。
 *
 * <p>2 つの拡大率（SID/SOD、ImagerPixelSpacing/PixelSpacing）と、装置が書く推定拡大率が
 * 食い違う入力は、二次取得（SC）のタグ誤りなど「タグが当てにならない」入力で起きた。
 * タグが取れない項目は `unknown` に分け、警告にも合格にも数えない（欠損を合格にしない）。
 */
import { GEOMETRIC_DISAGREE_WARN, type XaCalibTags } from "./xaCalibration";

export type XaInputCheckCode =
  /** ImagerPixelSpacing ÷ PixelSpacing が SID ÷ SOD と合わない。 */
  | "spacingRatioDiffersFromSidSod"
  /** SID ÷ SOD が EstimatedRadiographicMagnificationFactor と合わない。 */
  | "sidSodDiffersFromMagFactor"
  /** XA/XRF の SOP クラスではない（SC など）。 */
  | "notXaSopClass";

export interface XaInputCheck {
  /** 食い違いが見つかった項目。 */
  warnings: XaInputCheckCode[];
  /** 材料が足りず判定できなかった項目（警告でも合格でもない）。 */
  unknown: XaInputCheckCode[];
}

function pos(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function relDiff(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(a, b);
}

/** @param isXaSopClass SOP クラスが XA/XRF か。UID が読めなければ null。 */
export function checkXaInput(tags: XaCalibTags, isXaSopClass: boolean | null): XaInputCheck {
  const warnings: XaInputCheckCode[] = [];
  const unknown: XaInputCheckCode[] = [];

  if (isXaSopClass == null) unknown.push("notXaSopClass");
  else if (!isXaSopClass) warnings.push("notXaSopClass");

  const sid = pos(tags.distanceSourceToDetector);
  const sod = pos(tags.distanceSourceToPatient);
  const bySidSod = sid != null && sod != null ? sid / sod : null;

  const imager = tags.imagerPixelSpacing;
  const ps = tags.pixelSpacing;
  const iR = pos(imager?.[0]);
  const iC = pos(imager?.[1]);
  const pR = pos(ps?.[0]);
  const pC = pos(ps?.[1]);
  if (bySidSod == null || iR == null || iC == null || pR == null || pC == null) {
    unknown.push("spacingRatioDiffersFromSidSod");
  } else if (
    relDiff(iR / pR, bySidSod) > GEOMETRIC_DISAGREE_WARN ||
    relDiff(iC / pC, bySidSod) > GEOMETRIC_DISAGREE_WARN
  ) {
    warnings.push("spacingRatioDiffersFromSidSod");
  }

  const mag = pos(tags.estimatedRadiographicMagnificationFactor);
  if (bySidSod == null || mag == null) unknown.push("sidSodDiffersFromMagFactor");
  else if (relDiff(bySidSod, mag) > GEOMETRIC_DISAGREE_WARN) warnings.push("sidSodDiffersFromMagFactor");

  return { warnings, unknown };
}
