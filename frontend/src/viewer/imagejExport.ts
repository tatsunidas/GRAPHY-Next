/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Cornerstone アノテーション（world 座標）→ ImageJ ROI DTO（画像ピクセル座標）変換。
 *
 * backend の ImageJ サービス（`.roi`/`RoiSet.zip` エンコード）へ渡す DTO を作る。tool 種別を ImageJ の
 * ROI 種別（oval/rect/freehand/polyline/angle/point/polygon）へマップし、頂点/範囲を `worldToImageCoords`
 * で画素へ変換する。保存優先=ImageJ（`fw/roi-manager-design.md`）。
 */
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { resolveRoiStack } from "./roiBooleanOps";
import { getRoiMaskMeta } from "./roiMaskStore";
import type { ImageJRoiDto } from "../api";
import { worldToImageCoords } from "./imageCoords";

/** 単一アノテーション → ImageJ DTO（面積/線/点系。変換不能なら null）。 */
export function annotationToImageJDto(annotationUid: string): ImageJRoiDto | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ann = (csAnnotation.state as any).getAnnotation(annotationUid);
  const refId = ann?.metadata?.referencedImageId as string | undefined;
  if (!ann || !refId) return null;
  const tool = (ann.metadata?.toolName ?? "") as string;
  const world: number[][] = ann.data?.contour?.polyline ?? ann.data?.handles?.points ?? [];
  if (!world.length) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const w of world) {
    try {
      const ic = worldToImageCoords(refId, w as [number, number, number]) as [number, number];
      xs.push(ic[0]);
      ys.push(ic[1]);
    } catch {
      /* skip */
    }
  }
  if (!xs.length) return null;

  // スライス位置（1-based）: ROI 表示中スタックでの index。
  const stack = resolveRoiStack(refId);
  const position = stack ? stack.sourceIds.indexOf(refId) + 1 : 0;
  const name = getRoiMaskMeta(annotationUid)?.label || tool || "ROI";

  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const bbox = { bx: minX, by: minY, bw: maxX - minX, bh: maxY - minY };

  const type = imagejRoiType(tool);
  if (!type) return null;
  if (type === "oval" || type === "rect") return { name, type, position, ...bbox };
  return { name, type, position, xs, ys };
}

/** ツール名 → ImageJ の ROI の種類。書き出せないものは null。 */
export function imagejRoiType(tool: string): "oval" | "rect" | "freehand" | "angle" | "polyline" | "point" | "polygon" | null {
  if (/ellip|circle/i.test(tool)) return "oval";
  // Bidirectional は名前に "rect" を含むので、矩形の判定より先に線へ振る（以前は矩形で書き出していた）。
  if (/bidirectional/i.test(tool)) return "polyline";
  if (/rect/i.test(tool)) return "rect";
  if (/freehand/i.test(tool)) return "freehand";
  // Cobb 角（2 本の線・4 点）は ImageJ に同じ種類が無い。ANGLE（3 点）にすると壊れるので書き出さない。
  if (/cobb/i.test(tool)) return null;
  if (/angle/i.test(tool)) return "angle";
  if (/length|bidirectional|line/i.test(tool)) return "polyline";
  if (/probe|point/i.test(tool)) return "point";
  return "polygon";
}

/** 複数アノテーション → DTO 群（変換できたもののみ）。 */
export function annotationsToImageJDtos(uids: string[]): ImageJRoiDto[] {
  const out: ImageJRoiDto[] = [];
  for (const uid of uids) {
    const d = annotationToImageJDto(uid);
    if (d) out.push(d);
  }
  return out;
}
