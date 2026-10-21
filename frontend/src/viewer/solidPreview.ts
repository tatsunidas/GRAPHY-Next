/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 台帳の solid（楕円体・直方体）の、現在スライスでの断面輪郭をキャンバス座標で返す（2D ビューのプレビュー用）。
 * 断面の幾何は `roi3dBox.sectionOutline`（患者座標 mm）。ここは現在スライスの平面を引き、
 * 点列を `worldToCanvas` で投影するだけの薄い層（zoom/pan/回転に追従）。
 */
import { metaData, type Types } from "@cornerstonejs/core";
import { sectionOutline, type Roi3dBox, type Vec3 } from "./roi3dBox";

/** SVG 描画用の断面輪郭（キャンバス CSS px、reference lines と同座標系）。 */
export interface SolidCanvasOutline {
  points: Array<[number, number]>;
  /** 点列の重心（ラベルの位置用）。 */
  cx: number;
  cy: number;
  color: string;
  label: string;
}

/** 現在スライスと交差しない/対象外（非表示・c/t 不一致）なら null。 */
export function solidCanvasOutline(
  viewport: Types.IStackViewport,
  s: Roi3dBox,
  curC: number,
  curT: number,
): SolidCanvasOutline | null {
  if (s.visible === false) return null;
  if (s.c !== undefined && s.c !== "all" && s.c !== curC) return null;
  if (s.t !== undefined && s.t !== "all" && s.t !== curT) return null;
  const imageId = viewport.getCurrentImageId?.();
  if (!imageId) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = metaData.get("imagePlaneModule", imageId) as any;
  if (!m?.imagePositionPatient || !m.rowCosines || !m.columnCosines) return null;
  const outline = sectionOutline(s, m.imagePositionPatient as Vec3, m.rowCosines as Vec3, m.columnCosines as Vec3);
  if (!outline) return null;
  const points = outline.map((w) => {
    const p = viewport.worldToCanvas(w);
    return [p[0], p[1]] as [number, number];
  });
  const cx = points.reduce((a, p) => a + p[0], 0) / points.length;
  const cy = points.reduce((a, p) => a + p[1], 0) / points.length;
  return { points, cx, cy, color: s.color ?? "#00e5ff", label: s.label ?? "" };
}
