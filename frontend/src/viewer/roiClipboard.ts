/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 計測 ROI の複製（アプリ内クリップボード）。
 *
 * <p>用途は「**同じ形の ROI をもう 1 つ置く**」——対側の比較、経時の追跡、同じ大きさでの
 * 多点サンプリング。描き直すと形が変わり、形が変われば値も変わるので、
 * 「同じ形であること」が保証できないと比較にならない。
 *
 * <h3>設計上の決めごと</h3>
 * <ul>
 *   <li>🔴 **新しい幾何コードを書かない。** 「annotation → 保存形 → annotation」の往復は
 *       {@link ../viewer/roiPersistence} と {@link ../viewer/roiRestore} に既にあり、
 *       スプライン・開閉輪郭・マルチフレームの取りこぼしが潰してある。複製もその経路に乗せる。</li>
 *   <li>🔴 **クリップボードには画素座標で入れる。** world をそのまま持つと、貼り付け先の
 *       スライスでは**面外**になる（平面が違う）。「見た目の同じ場所」に置くのが要件なので、
 *       コピー時に画素へ落とし、貼り付け時に貼り付け先の画像で world へ戻す。
 *       IPP の差分を足す方式は斜位・非平行スタック・XA で破綻するので採らない。</li>
 *   <li>🔴 **コピー時に画素へ落とす**のは、貼り付けの時点で元画像のメタデータが
 *       残っている保証が無いため（Cornerstone は読み込んだ画像しかメタデータを答えない）。</li>
 *   <li>🔴 **新しい `annotationUID` を振る。** UID はプラグインの縦断追跡の鍵なので、
 *       複製が元と同じ鍵を持つと追跡が壊れる（`fw/roi-manager-design.md` §11.2）。</li>
 *   <li>OS のクリップボードは使わない（DICOM 由来の座標をアプリの外へ出さない）。</li>
 * </ul>
 */
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { metaData, utilities as csCoreUtilities } from "@cornerstonejs/core";
import { roiPointsPx, type PointPx } from "./roiRead";
import { getRoiMaskMeta, type RoiScope } from "./roiMaskStore";
import { addSavedRoiToViewport, sopOfImageId, type RestoreViewport } from "./roiRestore";
import { frameOfImageId } from "./imageId";
import { log } from "../log";
import type { SavedRoi } from "./roiPersistence";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

/**
 * クリップボードの中身。**画素座標**で持つ（上のコメント参照）。
 *
 * <p>ハンドルと輪郭を分けて持つのは保存形（`SavedRoi`）と同じ構造。輪郭系ツールは
 * `polyline` が本体で、`handles.points` は制御点になる。
 */
export interface RoiClipboardEntry {
  tool: string;
  /** `handles.points` を画素座標にしたもの。 */
  pointsPx: PointPx[];
  /** `contour.polyline` を画素座標にしたもの。輪郭系以外では空。 */
  polylinePx: PointPx[];
  isOpenContour?: boolean;
  splineType?: string;
  isLocked?: boolean;
  label?: string;
  description?: string;
  custom?: Record<string, string>;
  /** 色・線幅・塗りなど（`annotation.config.style` の per-annotation 設定）。 */
  style?: Record<string, unknown>;
}

let clip: RoiClipboardEntry | null = null;

export function hasClipboardRoi(): boolean {
  return clip !== null;
}

/**
 * 画素 → world の変換器を作る。**幾何が無いスタック（XA）でも頂点を失わない。**
 *
 * <p>`roiRead.roiPointsPx()` のフォールバック（world = 画素 × 画素間隔・原点 0）の逆。
 * 規則が 2 つあると「コピーした場所と貼り付いた場所が違う」になるので、必ず対にする。
 */
export function makePixelToWorld(imageId: string): (p: PointPx) => number[] {
  const plane = metaData.get("imagePlaneModule", imageId) as Any;
  const col = positive(plane?.columnPixelSpacing) ?? 1;
  const row = positive(plane?.rowPixelSpacing) ?? 1;
  return (p) => {
    try {
      const w = (csCoreUtilities as Any).imageToWorldCoords(imageId, [p[0], p[1]]) as number[] | undefined;
      if (w && w.length >= 3 && w.every((n: number) => Number.isFinite(n))) return [w[0], w[1], w[2]];
    } catch {
      /* 幾何が無いスタックではフォールバックへ */
    }
    return [p[0] * col, p[1] * row, 0];
  };
}

/** 貼り付け先の情報（純関数へ渡すために解決済みで受ける）。 */
export interface PasteTarget {
  roiUid: string;
  sopInstanceUid: string;
  frame: number | null;
  scope?: RoiScope;
}

/**
 * クリップボードの中身 → 保存形（純関数）。**貼り付けられないなら null。**
 *
 * <p>頂点が 1 つでも world へ落とせなければ全体を捨てる —— 一部だけ座標が入れ替わった
 * 図形は「同じ形の複製」ではないので、黙って作るより作らない方がよい。
 */
export function entryToSavedRoi(
  entry: RoiClipboardEntry,
  target: PasteTarget,
  toWorld: (p: PointPx) => number[] | null,
  label?: string,
): SavedRoi | null {
  const points = mapWorld(entry.pointsPx, toWorld);
  const polyline = mapWorld(entry.polylinePx, toWorld);
  if (points === null || polyline === null) return null;
  if (!points.length && !polyline.length) return null;
  const out: SavedRoi = {
    roiUid: target.roiUid,
    tool: entry.tool,
    sopInstanceUid: target.sopInstanceUid,
    points,
  };
  if (polyline.length) out.polyline = polyline;
  if (target.frame !== null) out.frame = target.frame;
  if (entry.isOpenContour !== undefined) out.isOpenContour = entry.isOpenContour;
  if (entry.splineType) out.splineType = entry.splineType;
  if (entry.isLocked) out.isLocked = true;
  if (label) out.label = label;
  if (entry.description) out.description = entry.description;
  if (entry.custom && Object.keys(entry.custom).length) out.custom = { ...entry.custom };
  if (target.scope) {
    // 🔴 貼り付け先スライスの **local** scope にする。global（z:"all"）を引き継ぐと
    //    同じものが 2 本とも全スライスに追従して、どちらがどちらか分からなくなる。
    out.scope = target.scope;
    out.origin = target.scope;
    if (target.scope.studyUid) out.studyUid = target.scope.studyUid;
    if (target.scope.seriesUid) out.seriesUid = target.scope.seriesUid;
    if (typeof target.scope.c === "number") out.c = target.scope.c;
    if (typeof target.scope.t === "number") out.t = target.scope.t;
  }
  return out;
}

function mapWorld(
  pts: ReadonlyArray<PointPx>,
  toWorld: (p: PointPx) => number[] | null,
): number[][] | null {
  const out: number[][] = [];
  for (const p of pts) {
    const w = toWorld(p);
    if (!w || w.length < 3 || !w.every((n) => Number.isFinite(n))) return null;
    out.push([w[0], w[1], w[2]]);
  }
  return out;
}

/** ROI を 1 件クリップボードへ取る。取れなければ false。 */
export function copyRoiToClipboard(roiUid: string): boolean {
  const entry = readRoiAsEntry(roiUid);
  if (!entry) return false;
  clip = entry;
  return true;
}

/** ROI を読んでクリップボード形（画素座標）にする。複製にも使うので分けてある。 */
function readRoiAsEntry(roiUid: string): RoiClipboardEntry | null {
  const ann = (csAnnotation.state as Any).getAnnotation(roiUid);
  const tool = ann?.metadata?.toolName as string | undefined;
  const refId = ann?.metadata?.referencedImageId as string | undefined;
  if (!ann || !tool || !refId) return null;

  const plane = metaData.get("imagePlaneModule", refId) as Any;
  const col = positive(plane?.columnPixelSpacing);
  const row = positive(plane?.rowPixelSpacing);
  const toPx = (w: ArrayLike<number>) => {
    try {
      return (csCoreUtilities as Any).worldToImageCoords(refId, w as [number, number, number]) as PointPx;
    } catch {
      return null;
    }
  };
  const pointsPx = roiPointsPx((ann.data?.handles?.points ?? []) as number[][], toPx, col, row);
  const polylinePx = roiPointsPx(
    (ann.data?.contour?.polyline ?? ann.data?.polyline ?? []) as number[][],
    toPx,
    col,
    row,
  );
  if (!pointsPx.length && !polylinePx.length) return null;

  const meta = getRoiMaskMeta(roiUid);
  const entry: RoiClipboardEntry = {
    tool,
    pointsPx,
    polylinePx,
    isOpenContour: ann.data?.isOpenContour ?? (ann.data?.contour?.closed === false ? true : undefined),
    splineType: ann.data?.spline?.type,
    isLocked: ann.isLocked === true,
    label: meta?.label,
    description: meta?.description,
    custom: meta?.custom ? { ...meta.custom } : undefined,
    style: readAnnotationStyle(roiUid),
  };
  return entry;
}

/** 貼り付け先のビューポート情報。 */
export interface PasteContext {
  /** 貼り付け先の imageId（＝**現在表示中のスライス**）。 */
  imageId: string;
  viewport: RestoreViewport;
  /** 表示スタック内の index（`getViewReference` 用）。 */
  sliceIndex?: number;
  patientKey: string;
  seriesLabel?: string;
  /** 貼り付け先スライスの scope（`viewerContext` から作る）。 */
  scope?: RoiScope;
  /** 複製したことが分かるラベル（例: `${元}  (コピー)`）。 */
  labelFor?: (sourceLabel: string | undefined, tool: string) => string;
}

/**
 * クリップボードの ROI を貼り付ける。作った annotationUID を返す（失敗は null）。
 */
export function pasteRoiInto(ctx: PasteContext): string | null {
  const entry = clip;
  if (!entry) return null;
  return placeEntry(entry, ctx);
}

/** ROI をその場で複製する（クリップボードを経由しない＝コピー内容を壊さない）。 */
export function duplicateRoi(roiUid: string, ctx: PasteContext): string | null {
  const entry = readRoiAsEntry(roiUid);
  if (!entry) return null;
  return placeEntry(entry, ctx);
}

function placeEntry(entry: RoiClipboardEntry, ctx: PasteContext): string | null {
  const sop = sopOfImageId(ctx.imageId);
  if (!sop) {
    log.warn("roi paste: cannot resolve SOP for", ctx.imageId);
    return null;
  }
  const uid = (csCoreUtilities as Any).uuidv4() as string;
  const saved = entryToSavedRoi(
    entry,
    { roiUid: uid, sopInstanceUid: sop, frame: frameOfImageId(ctx.imageId), scope: ctx.scope },
    makePixelToWorld(ctx.imageId),
    ctx.labelFor ? ctx.labelFor(entry.label, entry.tool) : entry.label,
  );
  if (!saved) {
    log.warn("roi paste: could not map points onto", ctx.imageId);
    return null;
  }
  const ok = addSavedRoiToViewport(saved, ctx.imageId, ctx.viewport, {
    sliceIndex: ctx.sliceIndex,
    patientKey: ctx.patientKey,
    seriesLabel: ctx.seriesLabel,
  });
  if (!ok) return null;
  if (entry.style && Object.keys(entry.style).length) {
    try {
      (csAnnotation.config.style as Any).setAnnotationStyles(uid, entry.style);
    } catch {
      /* スタイルが写らなくても複製自体は成立している */
    }
  }
  return uid;
}

function readAnnotationStyle(roiUid: string): Record<string, unknown> | undefined {
  try {
    const s = (csAnnotation.config.style as Any).getAnnotationToolStyles(roiUid) as Record<string, unknown>;
    return s && Object.keys(s).length ? { ...s } : undefined;
  } catch {
    return undefined;
  }
}

function positive(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
