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
import { worldToImageCoords, worldSpacingOf } from "./imageCoords";
import { buildRoiMesh } from "./roiStats";
import { convexHull, roiPointsPx, type PointPx } from "./roiRead";

/** 単一アノテーション → ImageJ DTO（面積/線/点系。変換不能なら null）。 */
export function annotationToImageJDto(annotationUid: string): ImageJRoiDto | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ann = (csAnnotation.state as any).getAnnotation(annotationUid);
  const refId = ann?.metadata?.referencedImageId as string | undefined;
  if (!ann || !refId) return null;
  const tool = (ann.metadata?.toolName ?? "") as string;
  const world: number[][] = ann.data?.contour?.polyline ?? ann.data?.handles?.points ?? [];
  if (!world.length) return null;

  // 幾何（IPP/IOP）が無いスタック（XA など）でも頂点を失わない換算は roiPointsPx に集約してある。
  const basis = worldSpacingOf(refId);
  const ptsPx = roiPointsPx(
    world,
    (w) => worldToImageCoords(refId, w as [number, number, number]) as [number, number],
    basis.col,
    basis.row,
  );
  const xs: number[] = ptsPx.map((p) => p[0]);
  const ys: number[] = ptsPx.map((p) => p[1]);
  if (!xs.length) return null;

  // スライス位置（1-based）: ROI 表示中スタックでの index。
  const stack = resolveRoiStack(refId);
  const position = stack ? stack.sourceIds.indexOf(refId) + 1 : 0;
  const name = getRoiMaskMeta(annotationUid)?.label || tool || "ROI";

  const type = imagejRoiType(tool);
  if (!type) return null;
  if (type === "oval" || type === "rect") {
    const pts = xs.map((x, i): PointPx => [x, ys[i]]);
    const shape = ovalOrRectShape(tool, type, pts, worldSpacingOf(refId));
    if (shape.kind === "bbox") return { name, type, position, ...shape.bbox };
    return { name, type: "polygon", position, xs: shape.xs, ys: shape.ys };
  }
  return { name, type, position, xs, ys };
}

const AXIS_EPS = 1e-3; // 画素。ハンドルの軸整列の判定

function bboxOf(pts: ReadonlyArray<PointPx>): { bx: number; by: number; bw: number; bh: number } {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { bx: minX, by: minY, bw: maxX - minX, bh: maxY - minY };
}

/**
 * 円・楕円・矩形を ImageJ の oval / rect（画像軸に整列した bbox）か、整列していなければ多角形にする。純関数。
 *
 * <p>ハンドルの外接 bbox は、整列した楕円・矩形では形の bbox と一致するが、**円**（ハンドルは [中心, 縁]）では
 * 中心〜縁の長方形になる。回転表示で描いた楕円・矩形は軸に整列しないので、oval / rect では書けない。
 * 円は world（mm）の円なので、非正方画素では画素空間の楕円（`buildRoiMesh` の円と同じ）。
 *
 * @param pts   ハンドルの画素座標（円 [中心, 縁]、楕円 [下, 上, 左, 右]、矩形 4 隅）
 * @param basis world ↔ 画素の換算に使う間隔（円の形）
 */
export function ovalOrRectShape(
  tool: string,
  type: "oval" | "rect",
  pts: ReadonlyArray<PointPx>,
  basis?: { col: number; row: number },
):
  | { kind: "bbox"; bbox: { bx: number; by: number; bw: number; bh: number } }
  | { kind: "polygon"; xs: number[]; ys: number[] } {
  const poly = (p: ReadonlyArray<PointPx>) => ({ kind: "polygon" as const, xs: p.map((q) => q[0]), ys: p.map((q) => q[1]) });
  const t = tool.trim().toLowerCase();
  if (type === "rect") {
    const hull = convexHull(pts);
    const bb = bboxOf(hull.length ? hull : pts);
    // 4 隅がすべて bbox の角に乗っていれば軸整列
    const aligned =
      hull.length === 4 &&
      hull.every((p) => (Math.abs(p[0] - bb.bx) < AXIS_EPS || Math.abs(p[0] - bb.bx - bb.bw) < AXIS_EPS) &&
        (Math.abs(p[1] - bb.by) < AXIS_EPS || Math.abs(p[1] - bb.by - bb.bh) < AXIS_EPS));
    return aligned ? { kind: "bbox", bbox: bb } : hull.length >= 3 ? poly(hull) : { kind: "bbox", bbox: bb };
  }
  const mesh = buildRoiMesh(tool, pts, undefined, undefined, basis);
  if (!mesh || !mesh.pointsPx.length) return { kind: "bbox", bbox: bboxOf(pts) };
  if (t === "circleroi") return { kind: "bbox", bbox: bboxOf(mesh.pointsPx) };
  // 楕円 [下, 上, 左, 右]: 下と上の x、左と右の y が揃っていれば軸整列
  const [bottom, top, left, right] = pts;
  const aligned =
    pts.length >= 4 && Math.abs(bottom[0] - top[0]) < AXIS_EPS && Math.abs(left[1] - right[1]) < AXIS_EPS;
  return aligned ? { kind: "bbox", bbox: bboxOf(mesh.pointsPx) } : poly(mesh.pointsPx);
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
