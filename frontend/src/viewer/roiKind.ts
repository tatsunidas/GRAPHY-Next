/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ツール名 → 種別の単一の分類器（純関数）。
 *
 * <p>ROI は area（面）/ line（線）/ point（点）。計測（Length・Bidirectional・Angle・Cobb・Probe）は
 * "measure" で、マスクにも RTSTRUCT にもしない。
 *
 * <p>🔴 **部分一致の正規表現でツール名を振り分けない。** `Bidirectional` は名前に "rect" を含むので、
 * `/rect/` で面積型を判定すると計測が面になる（以前の `isAreaRoi` / RTSTRUCT 書き出しの不具合）。
 * 分類はここだけに置き、完全一致（小文字化）で引く。
 */
import { CONTOUR_TOOL_NAMES } from "./roiContourTools";
import { POINT_ROI_TOOL_NAME } from "./pointRoiTool";

export type RoiKind = "area" | "line" | "point" | "measure";

const MEASURE = new Set(["length", "bidirectional", "angle", "cobbangle", "probe", "dragprobe"]);

const lc = (s: string) => s.toLowerCase();
const AREA = new Set([
  "ellipticalroi",
  "circleroi",
  "rectangleroi",
  "rectangleroithreshold",
  lc(CONTOUR_TOOL_NAMES.polygon),
  lc(CONTOUR_TOOL_NAMES.freehand),
]);
const LINE = new Set([lc(CONTOUR_TOOL_NAMES.polyline), lc(CONTOUR_TOOL_NAMES.freeLine)]);
/** 開閉を `closed` で決める Cornerstone 標準の輪郭ツール。 */
const BY_CLOSED = new Set(["planarfreehandroi", "splineroi", "catmullromsplineroi", "linearsplineroi", "bsplineroi"]);

/** 未知のツールは null（呼び出し側が「知らないものには何もしない」を選べる）。 */
export function roiKindOf(toolName: string | undefined, closed?: boolean): RoiKind | null {
  const t = lc((toolName ?? "").trim());
  if (!t) return null;
  if (MEASURE.has(t)) return "measure";
  if (t === lc(POINT_ROI_TOOL_NAME)) return "point";
  if (AREA.has(t)) return "area";
  if (LINE.has(t)) return "line";
  if (BY_CLOSED.has(t)) return closed === false ? "line" : "area";
  return null;
}

/** ROI（area / line / point）か。計測と未知は false。 */
export function isRoiKind(kind: RoiKind | null): boolean {
  return kind === "area" || kind === "line" || kind === "point";
}

/** annotation オブジェクトから種別を引く（`contour.closed` を開閉の根拠にする）。 */
export function annotationRoiKind(ann: unknown): RoiKind | null {
  const a = ann as { metadata?: { toolName?: string }; data?: { contour?: { closed?: boolean } } } | null | undefined;
  return roiKindOf(a?.metadata?.toolName, a?.data?.contour?.closed);
}
