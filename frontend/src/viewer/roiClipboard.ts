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
import { imageToWorldCoords, worldToImageCoords } from "./imageCoords";

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
  /** コピー元の患者。貼り付け先が別の患者なら、説明と custom は持ち越さない。 */
  sourcePatientKey?: string;
  /** コピー元の画像の寸法と画素間隔。画像の違う先へ貼るとき、実寸（mm）を保つために使う。 */
  source?: ImageGrid;
  /** コピー元スタックでのスライス番号。複数コピーで、スライス間の位置関係を貼り付け先にも写すために使う。 */
  stackIndex?: number;
}

/** 画像の寸法（画素）と画素間隔（mm）。不明な要素は null。 */
export interface ImageGrid {
  cols: number | null;
  rows: number | null;
  colSpacing: number | null;
  rowSpacing: number | null;
}

export function imageGridOf(imageId: string): ImageGrid {
  const plane = metaData.get("imagePlaneModule", imageId) as Any;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  return {
    cols: n(plane?.columns),
    rows: n(plane?.rows),
    colSpacing: n(plane?.columnPixelSpacing),
    rowSpacing: n(plane?.rowPixelSpacing),
  };
}

const sameNum = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1);

/**
 * 別の画像へ貼るために、画素座標を貼り付け先の画像へ写す（純関数）。
 *
 * <p>実寸（mm）を保ち、重心は画像内の同じ相対位置に置く。画素間隔と寸法が同じ画像（同じシリーズ）では
 * 恒等。間隔か寸法のどちらかが不明（XA など）なら画素のまま。変換後に画像の外へ出るなら null
 * （切り詰めると形が変わり、「同じ形の複製」でなくなる）。
 */
export function retargetEntry(entry: RoiClipboardEntry, dst: ImageGrid | null): RoiClipboardEntry | null {
  const src = entry.source;
  if (!src || !dst) return entry;
  const { cols: sw, rows: sh, colSpacing: sc, rowSpacing: sr } = src;
  const { cols: dw, rows: dh, colSpacing: dc, rowSpacing: dr } = dst;
  if (sw === null || sh === null || sc === null || sr === null) return entry;
  if (dw === null || dh === null || dc === null || dr === null) return entry;
  if (sw === dw && sh === dh && sameNum(sc, dc) && sameNum(sr, dr)) return entry;

  const all = [...entry.pointsPx, ...entry.polylinePx];
  if (!all.length) return entry;
  const cx = all.reduce((a, p) => a + p[0], 0) / all.length;
  const cy = all.reduce((a, p) => a + p[1], 0) / all.length;
  const nx = (cx / sw) * dw;
  const ny = (cy / sh) * dh;
  const kx = sc / dc;
  const ky = sr / dr;
  const map = (pts: PointPx[]): PointPx[] => pts.map((p) => [nx + (p[0] - cx) * kx, ny + (p[1] - cy) * ky]);
  const pointsPx = map(entry.pointsPx);
  const polylinePx = map(entry.polylinePx);
  const inside = ([...pointsPx, ...polylinePx] as PointPx[]).every(
    (p) => p[0] >= 0 && p[0] <= dw && p[1] >= 0 && p[1] <= dh,
  );
  return inside ? { ...entry, pointsPx, polylinePx } : null;
}

/**
 * 複数の ROI をまとめて別の画像へ写す（純関数）。{@link retargetEntry} の複数版。
 *
 * <p>重心と拡大率を**全体で 1 つ**にする。ROI ごとに重心を取ると、それぞれが別々の位置へ動いて
 * 元の配置関係（対側比較・多点サンプリングの並び）が崩れる。1 件でも画像の外へ出るなら全体を捨てる
 * （1 件だけ貼られて残りが黙って消えるのは、「同じ配置の複製」ではない）。
 */
export function retargetEntries(entries: readonly RoiClipboardEntry[], dst: ImageGrid | null): RoiClipboardEntry[] | null {
  if (entries.length === 0) return [];
  const src = entries[0].source;
  if (!src || !dst) return [...entries];
  const { cols: sw, rows: sh, colSpacing: sc, rowSpacing: sr } = src;
  const { cols: dw, rows: dh, colSpacing: dc, rowSpacing: dr } = dst;
  if (sw === null || sh === null || sc === null || sr === null) return [...entries];
  if (dw === null || dh === null || dc === null || dr === null) return [...entries];
  if (sw === dw && sh === dh && sameNum(sc, dc) && sameNum(sr, dr)) return [...entries];

  const all = entries.flatMap((e) => [...e.pointsPx, ...e.polylinePx]);
  if (!all.length) return [...entries];
  const cx = all.reduce((a, p) => a + p[0], 0) / all.length;
  const cy = all.reduce((a, p) => a + p[1], 0) / all.length;
  const nx = (cx / sw) * dw;
  const ny = (cy / sh) * dh;
  const kx = sc / dc;
  const ky = sr / dr;
  const map = (pts: PointPx[]): PointPx[] => pts.map((p) => [nx + (p[0] - cx) * kx, ny + (p[1] - cy) * ky]);
  const out = entries.map((e) => ({ ...e, pointsPx: map(e.pointsPx), polylinePx: map(e.polylinePx) }));
  const inside = out.every((e) =>
    ([...e.pointsPx, ...e.polylinePx] as PointPx[]).every((p) => p[0] >= 0 && p[0] <= dw && p[1] >= 0 && p[1] <= dh),
  );
  return inside ? out : null;
}

let clip: RoiClipboardEntry[] = [];

/** ROI の参照画像が、このスタックの画像のどれかか（コピー・複製の宛先タイルを ROI から決める）。 */
export function ownsImage(imageIds: readonly string[], referencedImageId: string | undefined): boolean {
  return !!referencedImageId && imageIds.includes(referencedImageId);
}

export function hasClipboardRoi(): boolean {
  return clip.length > 0;
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
      const w = imageToWorldCoords(imageId, [p[0], p[1]]) as number[] | undefined;
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

/**
 * ROI をクリップボードへ取る（複数可）。**取れた件数**を返す（0 のときは前のクリップボードを残す）。
 * `stackIndexOf` は ROI が乗っているスライスの番号。貼り付けで、スライス間の位置関係を保つのに使う。
 */
export function copyRoisToClipboard(
  roiUids: readonly string[],
  sourcePatientKey?: string,
  stackIndexOf?: (roiUid: string) => number | undefined,
): number {
  const next: RoiClipboardEntry[] = [];
  for (const uid of roiUids) {
    const entry = readRoiAsEntry(uid);
    if (entry) next.push({ ...entry, sourcePatientKey, stackIndex: stackIndexOf?.(uid) });
  }
  if (next.length === 0) return 0;
  clip = next;
  return next.length;
}

/** 1 件だけ取る（行の操作用）。 */
export function copyRoiToClipboard(roiUid: string, sourcePatientKey?: string, stackIndex?: number): boolean {
  return copyRoisToClipboard([roiUid], sourcePatientKey, () => stackIndex) === 1;
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
      return worldToImageCoords(refId, w as [number, number, number]) as PointPx;
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
    source: imageGridOf(refId),
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
export function pasteRoiInto(ctx: PasteContext): PasteResult {
  const r = pasteRoisInto(() => ctx);
  return { uid: r.uids[0] ?? null, reason: r.reason };
}

/**
 * クリップボードの ROI をすべて貼る。`ctxAt(offset)` は、貼り付け先で「基準のスライスから offset 枚ずれた」
 * スライスへの貼り付け情報（スタックの外なら null）。基準は、コピーした ROI のうち**最も若いスライス**で、
 * それが現在表示中のスライスに載る（複数スライスにまたがるコピーも、枚数の差を保って貼れる）。
 */
export function pasteRoisInto(ctxAt: (offset: number) => PasteContext | null): PasteManyResult {
  const entries = clip;
  const base = ctxAt(0);
  if (entries.length === 0 || !base) return { uids: [], skipped: 0, reason: "failed" };
  const moved = retargetEntries(entries.map((e) => carryOver(e, base.patientKey)), imageGridOf(base.imageId));
  if (!moved) return { uids: [], skipped: 0, reason: "outOfImage" };
  const indices = moved.map((e) => e.stackIndex).filter((n): n is number => typeof n === "number");
  const minIndex = indices.length ? Math.min(...indices) : 0;
  const uids: string[] = [];
  let skipped = 0;
  for (const e of moved) {
    const ctx = ctxAt(typeof e.stackIndex === "number" ? e.stackIndex - minIndex : 0);
    const r = ctx ? placeMoved(e, ctx) : null;
    if (r?.uid) uids.push(r.uid);
    else skipped++;
  }
  return { uids, skipped, reason: uids.length === 0 ? "failed" : undefined };
}

/** 貼り付け（複数）の結果。`skipped` は、スタックの外・変換不能で置けなかった件数。 */
export interface PasteManyResult {
  uids: string[];
  skipped: number;
  reason?: "failed" | "outOfImage";
}

/** 貼り付けの結果。失敗の理由を分けるのは、画像の外にはみ出すときだけ別の案内を出すため。 */
export interface PasteResult {
  uid: string | null;
  reason?: "failed" | "outOfImage";
}

/** ROI をその場で複製する（クリップボードを経由しない＝コピー内容を壊さない）。 */
export function duplicateRoi(roiUid: string, ctx: PasteContext): PasteResult {
  const entry = readRoiAsEntry(roiUid);
  if (!entry) return { uid: null, reason: "failed" };
  return placeEntry(entry, ctx);
}

/**
 * 貼り付け先の患者が違うとき、説明と custom は持ち越さない（別の患者に元の所見や個人情報、
 * プラグインの結果が混ざる＝取り違えの元になる）。ラベルは残す。
 */
export function carryOver(entry: RoiClipboardEntry, destPatientKey: string): RoiClipboardEntry {
  const other = !!entry.sourcePatientKey && !!destPatientKey && entry.sourcePatientKey !== destPatientKey;
  return other ? { ...entry, description: undefined, custom: undefined } : entry;
}

function placeEntry(source: RoiClipboardEntry, ctx: PasteContext): PasteResult {
  const failed: PasteResult = { uid: null, reason: "failed" };
  const sop = sopOfImageId(ctx.imageId);
  if (!sop) {
    log.warn("roi paste: cannot resolve SOP for", ctx.imageId);
    return failed;
  }
  const moved = retargetEntry(carryOver(source, ctx.patientKey), imageGridOf(ctx.imageId));
  if (!moved) return { uid: null, reason: "outOfImage" };
  return placeMoved(moved, ctx);
}

/** 貼り付け先の画像へ写し終えた ROI を、その画像に置く。 */
function placeMoved(entry: RoiClipboardEntry, ctx: PasteContext): PasteResult {
  const failed: PasteResult = { uid: null, reason: "failed" };
  const sop = sopOfImageId(ctx.imageId);
  if (!sop) {
    log.warn("roi paste: cannot resolve SOP for", ctx.imageId);
    return failed;
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
    return failed;
  }
  const ok = addSavedRoiToViewport(saved, ctx.imageId, ctx.viewport, {
    sliceIndex: ctx.sliceIndex,
    patientKey: ctx.patientKey,
    seriesLabel: ctx.seriesLabel,
  });
  if (!ok) return failed;
  if (entry.style && Object.keys(entry.style).length) {
    try {
      (csAnnotation.config.style as Any).setAnnotationStyles(uid, entry.style);
    } catch {
      /* スタイルが写らなくても複製自体は成立している */
    }
  }
  return { uid };
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
