/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI → 匿名化の焼き込みマスク（画像ピクセル座標の閉多角形）。
 *
 * <p>🔴 **新しい幾何コードを書かない。** 「任意 ROI → 閉多角形」の正本は
 * `roiStats.buildRoiMesh()`（「すべての ROI 種別がここへ潰れる」）で、world → 画素の換算は
 * `roiRead.roiPointsPx()` に集約されている（そちらのコメントいわく「3 か所目を作らないため」）。
 * ここはその 2 つを繋いで、焼き込みに使えるものだけを選ぶ薄い層。
 *
 * <p>⚠ **`imagejExport.ts` の `annotationToImageJDto` は使わない。** あれは ImageJ の
 * `.roi` / `RoiSet.zip` 用の交換型で、楕円・矩形を**軸平行 bbox に潰す**。45 度回転した楕円は
 * bbox から作った円になり、**長軸方向が塗り足りなくなる** —— 焼き込み文字が残るのに出力を
 * 見ても気づけないので、脱識別には使えない。
 *
 * <p>⚠ 頂点は**サブピクセルのまま**送る（丸めると 1px ずれる）。backend の
 * `PolygonRasterizer` が画素中心 `(x+0.5, y+0.5)` の偶奇則で判定する ——
 * `roiStats.pointInPolygon` と同じ規約。
 *
 * <p>Cornerstone に触るのは {@link annotationsToMaskPolygons} だけで、判定そのものは
 * {@link maskPolygonFrom} に純関数として分けてある（`roiStats.ts` と `roiStatsStore.ts` の
 * 分け方に合わせた。vitest は `.ts` の純ロジックしか見ない）。
 */
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { metaData, utilities as csCoreUtilities } from "@cornerstonejs/core";
import { roiPointsPx, type PointPx } from "./roiRead";
import { buildRoiMesh, pickSampleKind } from "./roiStats";
import { frameOfImageId, sopFromImageId, sopUidFromImageId } from "./imageId";
import type { AnonMaskPolygon } from "../api";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/** 焼き込みに使えなかった理由。UI で内訳を出すため。 */
export type MaskSkipReason = "notClosedArea" | "noVertices" | "noReference";

export interface MaskExportSkip {
  roiUid: string;
  tool: string;
  reason: MaskSkipReason;
}

export interface MaskExportResult {
  polygons: AnonMaskPolygon[];
  skipped: MaskExportSkip[];
}

/**
 * 解決済みの入力から焼き込み多角形を作る（純関数）。使えないなら理由。
 *
 * <p>使えるのは**面積を持つ閉じた ROI** だけ（`pickSampleKind` が `"area"` を返し、かつ
 * `buildRoiMesh` の結果が `closed` で 3 頂点以上）。線・点・角度は面積を持たないので
 * 焼き込みには使えない —— 受け付けると「登録できたのに 1 画素も塗られていないのに
 * Clean Pixel Data を申告する」新しい偽申告になる。
 *
 * @param refImageId 適用先の解決に使う。SOP Instance UID とフレーム番号をここから取る。
 */
export function maskPolygonFrom(
  tool: string,
  pointsPx: ReadonlyArray<PointPx>,
  closed: boolean | undefined,
  refImageId: string,
): { polygon: AnonMaskPolygon } | { reason: MaskSkipReason } {
  if (!refImageId) return { reason: "noReference" };
  // 適用先は「この ROI が描かれた 1 枚だけ」が既定（旧 GRAPHY の "Current Slice Only" 相当）。
  // 🔴 index ではなく SOP Instance UID で指定する —— index は並び順が変われば別スライスを塗る。
  const sop = sopFromImageId(refImageId) ?? sopUidFromImageId(refImageId);
  // XA の 1 ラン数十〜数百フレームは全部同じ SOP なので、フレーム番号も要る。
  const frame = frameOfImageId(refImageId);
  return maskPolygonFromResolved(tool, pointsPx, closed, sop, frame);
}

/**
 * 適用先（SOP / フレーム）を**解決済みで**受け取る版。
 *
 * <p>imageId から SOP を起こせない場所——具体的には**匿名化ダイアログ（MainScreen ウィンドウ）**
 * ——のための入口。あちらは 2D ビューアと別レンダラで、Cornerstone に画像を読み込んでいないため
 * imageId が存在しない。保存済み ROI（`roiPersistence`）は SOP とフレームを直接持っている。
 *
 * <p>🔴 **判定と多角形化の規則をこちらに寄せてある**（`maskPolygonFrom` は薄いラッパ）。
 * 「楕円を bbox に潰さない」「頂点はサブピクセルのまま」「面積を持つ閉 ROI だけ」という
 * 決定が、2 つの経路で食い違わないようにするため。
 *
 * @param sop   適用先の SOP Instance UID。null なら**そのシリーズの全インスタンス**が対象になる
 * @param frame multi-frame のフレーム index（0 origin）。null なら全フレーム
 */
export function maskPolygonFromResolved(
  tool: string,
  pointsPx: ReadonlyArray<PointPx>,
  closed: boolean | undefined,
  sop: string | null,
  frame: number | null,
): { polygon: AnonMaskPolygon } | { reason: MaskSkipReason } {
  if (!pointsPx.length) return { reason: "noVertices" };
  if (pickSampleKind((tool ?? "").trim().toLowerCase(), closed) !== "area") {
    return { reason: "notClosedArea" };
  }
  const mesh = buildRoiMesh(tool, pointsPx, closed);
  if (!mesh || !mesh.closed || mesh.pointsPx.length < 3) {
    return { reason: "notClosedArea" };
  }

  return {
    polygon: {
      xs: mesh.pointsPx.map((p) => p[0]),
      ys: mesh.pointsPx.map((p) => p[1]),
      sopInstanceUids: sop ? [sop] : [],
      frames: frame === null ? [] : [frame],
    },
  };
}

/** 複数アノテーション → 焼き込み多角形。使えなかったものは理由つきで返す。 */
export function annotationsToMaskPolygons(roiUids: readonly string[]): MaskExportResult {
  const polygons: AnonMaskPolygon[] = [];
  const skipped: MaskExportSkip[] = [];
  for (const roiUid of roiUids) {
    const ann = (csAnnotation.state as Any).getAnnotation(roiUid);
    const tool = (ann?.metadata?.toolName as string) ?? "";
    const refId = ann?.metadata?.referencedImageId as string | undefined;
    if (!ann || !refId) {
      skipped.push({ roiUid, tool, reason: "noReference" });
      continue;
    }
    const world = (ann?.data?.contour?.polyline ?? ann?.data?.handles?.points ?? []) as number[][];
    if (!world.length) {
      skipped.push({ roiUid, tool, reason: "noVertices" });
      continue;
    }
    const plane = metaData.get("imagePlaneModule", refId) as Any;
    // 幾何(IPP/IOP)が無いシリーズ（XA）でも頂点を失わない換算は roiRead に集約してある。
    const pointsPx = roiPointsPx(
      world,
      (w) => csCoreUtilities.worldToImageCoords(refId, w as [number, number, number]) as PointPx,
      numOrNull(plane?.columnPixelSpacing),
      numOrNull(plane?.rowPixelSpacing),
    );
    const r = maskPolygonFrom(tool, pointsPx, ann?.data?.contour?.closed as boolean | undefined, refId);
    if ("polygon" in r) {
      polygons.push(r.polygon);
    } else {
      skipped.push({ roiUid, tool, reason: r.reason });
    }
  }
  return { polygons, skipped };
}

/** ROI が描かれているシリーズの UID（マスクはシリーズ単位で登録するため）。 */
export function seriesUidOfRoi(roiUid: string): string | null {
  const ann = (csAnnotation.state as Any).getAnnotation(roiUid);
  const refId = ann?.metadata?.referencedImageId as string | undefined;
  if (!refId) return null;
  const series = metaData.get("generalSeriesModule", refId) as Any;
  const uid = series?.seriesInstanceUID;
  return typeof uid === "string" && uid ? uid : null;
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
