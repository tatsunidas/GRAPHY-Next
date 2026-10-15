/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 計測 → ROI の変換（「ROI にする」）。
 *
 * <p>計測はマスクにも RTSTRUCT にもならない。その計測の形を ROI として残したいときだけ、
 * Length → 線 ROI、Probe → 点 ROI に変える。Angle / Cobb / Bidirectional は ROI の形に
 * 落とせない（折れ線・交差する 2 線分に画素統計の意味が無い）ので変換しない。
 *
 * <p>新しい幾何コードは書かない: 保存形（{@link SavedRoi}）を作って、復元・複製と同じ
 * {@link addSavedRoiToViewport} に渡す（スプライン補間の用意など順序の罠がそこに閉じている）。
 */
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { utilities as csCoreUtilities } from "@cornerstonejs/core";
import { CONTOUR_TOOL_NAMES, SPLINE_TYPE_LINEAR } from "./roiContourTools";
import { POINT_ROI_TOOL_NAME } from "./pointRoiTool";
import { getRoiMaskMeta, deleteRoiMaskMeta } from "./roiMaskStore";
import { isRoiLocked } from "./roiLock";
import { addSavedRoiToViewport, sopOfImageId, type RestoreViewport } from "./roiRestore";
import { frameOfImageId } from "./imageId";
import type { SavedRoi } from "./roiPersistence";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** ROI に変えられる計測のツール名か（Length / Probe のみ）。 */
export function canConvertMeasureToRoi(toolName: string | undefined): boolean {
  const t = (toolName ?? "").toLowerCase();
  return t === "length" || t === "probe";
}

/** 変換先に引き継ぐメタ。 */
export interface MeasureRoiBase {
  roiUid: string;
  sopInstanceUid: string;
  frame: number | null;
  label?: string;
  description?: string;
  scope?: SavedRoi["scope"];
  origin?: SavedRoi["origin"];
  custom?: Record<string, string>;
}

/**
 * 計測のハンドル（LPS mm）→ ROI の保存形（純関数）。変換できなければ null。
 * Length は 2 点が要り、Probe は 1 点が要る。
 */
export function measureToSavedRoi(
  toolName: string,
  handles: ReadonlyArray<ArrayLike<number>>,
  base: MeasureRoiBase,
): SavedRoi | null {
  const t = toolName.toLowerCase();
  const pts = handles.map((p) => [p[0], p[1], p[2]]);
  if (pts.some((p) => p.length !== 3 || !p.every((n) => Number.isFinite(n)))) return null;
  let out: SavedRoi;
  if (t === "length") {
    if (pts.length < 2) return null;
    const line = [pts[0], pts[1]];
    out = {
      roiUid: base.roiUid,
      tool: CONTOUR_TOOL_NAMES.polyline,
      sopInstanceUid: base.sopInstanceUid,
      points: line,
      polyline: line.map((p) => [...p]),
      isOpenContour: true,
      splineType: SPLINE_TYPE_LINEAR,
    };
  } else if (t === "probe") {
    if (pts.length < 1) return null;
    out = {
      roiUid: base.roiUid,
      tool: POINT_ROI_TOOL_NAME,
      sopInstanceUid: base.sopInstanceUid,
      points: [pts[0]],
    };
  } else {
    return null;
  }
  if (base.frame !== null) out.frame = base.frame;
  if (base.label) out.label = base.label;
  if (base.description) out.description = base.description;
  if (base.custom && Object.keys(base.custom).length) out.custom = { ...base.custom };
  if (base.scope) {
    out.scope = base.scope;
    out.origin = base.origin ?? base.scope;
    if (base.scope.studyUid) out.studyUid = base.scope.studyUid;
    if (base.scope.seriesUid) out.seriesUid = base.scope.seriesUid;
    if (typeof base.scope.c === "number") out.c = base.scope.c;
    if (typeof base.scope.t === "number") out.t = base.scope.t;
  }
  return out;
}

export type ConvertFailure = "notFound" | "unsupported" | "locked" | "failed";
export type ConvertResult = { ok: true; uid: string } | { ok: false; reason: ConvertFailure };

export interface ConvertContext {
  viewport: RestoreViewport;
  /** 表示スタックの imageId 列（計測の imageId から sliceIndex を引く）。 */
  imageIds: readonly string[];
  patientKey: string;
  seriesLabel?: string;
}

/**
 * 計測を ROI に変え、元の計測を消す。作った ROI を先に置いてから元を消すので、
 * 途中で失敗しても計測は失われない。ロック中は何もしない。
 */
export function convertMeasureToRoi(uid: string, ctx: ConvertContext): ConvertResult {
  const ann = (csAnnotation.state as Any).getAnnotation(uid);
  const tool = ann?.metadata?.toolName as string | undefined;
  const refId = ann?.metadata?.referencedImageId as string | undefined;
  if (!ann || !tool || !refId) return { ok: false, reason: "notFound" };
  if (!canConvertMeasureToRoi(tool)) return { ok: false, reason: "unsupported" };
  if (isRoiLocked(uid)) return { ok: false, reason: "locked" };
  const sop = sopOfImageId(refId);
  if (!sop) return { ok: false, reason: "failed" };

  const meta = getRoiMaskMeta(uid);
  const newUid = (csCoreUtilities as Any).uuidv4() as string;
  const saved = measureToSavedRoi(tool, (ann.data?.handles?.points ?? []) as number[][], {
    roiUid: newUid,
    sopInstanceUid: sop,
    frame: frameOfImageId(refId),
    label: meta?.label,
    description: meta?.description,
    scope: meta?.scope,
    origin: meta?.origin,
    custom: meta?.custom,
  });
  if (!saved) return { ok: false, reason: "failed" };
  const ok = addSavedRoiToViewport(saved, refId, ctx.viewport, {
    sliceIndex: ctx.imageIds.indexOf(refId),
    patientKey: ctx.patientKey,
    seriesLabel: ctx.seriesLabel,
  });
  if (!ok) return { ok: false, reason: "failed" };
  try {
    (csAnnotation.state as Any).removeAnnotation(uid);
  } catch {
    /* 元が消せなくても ROI は出来ている */
  }
  deleteRoiMaskMeta(uid);
  return { ok: true, uid: newUid };
}
