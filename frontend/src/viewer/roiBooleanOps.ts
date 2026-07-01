/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Mask（labelmap）ブール演算（M3）。
 *
 * 選択した複数 Mask を labelmap ラスタのまま OR/AND/XOR/マージ（=OR）し、結果を**新規 Mask** として
 * 生成・登録する。SPLIT は単一 Mask を 3D 連結成分でラベリングし、成分ごとに segment index を割り当てた
 * 新規 Mask を作る。出力は設計どおり Mask（ラスタ）に統一。
 *
 * 前提: 入力 Mask は同一 source スタック（同じ referencedImageId 列）であること（同一 series/C/T）。
 * 設計: `fw/roi-manager-design.md` 第4章。
 */
import { cache, imageLoader, getRenderingEngines, utilities as csUtils } from "@cornerstonejs/core";
import { annotation as csAnnotation, segmentation as csSeg, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { getRoiMaskMeta, setRoiMaskMeta } from "./roiMaskStore";

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
const MAX_SEGMENTS = 64; // SPLIT の成分数上限（色枯渇/重さ回避）。
let opSeq = 0;

export type BoolOp = "or" | "and" | "xor";

interface MaskData {
  labelmapIds: string[]; // スライスごとの labelmap imageId
  sourceIds: string[]; // スライスごとの source(referenced) imageId
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function img(id: string): any {
  return cache.getImage(id);
}

/** Mask の labelmap/ソース imageId 列を取得（取得不能なら null）。 */
function readMask(segId: string): MaskData | null {
  let labelmapIds: string[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    labelmapIds = (csSeg as any).getLabelmapImageIds(segId) as string[];
  } catch {
    return null;
  }
  if (!labelmapIds?.length) return null;
  const sourceIds = labelmapIds.map((id) => img(id)?.referencedImageId as string);
  if (sourceIds.some((s) => !s)) return null;
  return { labelmapIds, sourceIds };
}

function sameStack(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** 結果用の新規 labelmap セグメンテーションを生成・ビューポート登録し、メタを継承する。 */
export async function createResultSeg(
  sourceIds: string[],
  viewportIds: string[],
  label: string,
  scopeFrom: string,
): Promise<{ segId: string; labelmapIds: string[] } | null> {
  await Promise.all(sourceIds.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
  const derived = imageLoader.createAndCacheDerivedLabelmapImages(sourceIds);
  const labelmapIds = derived.map((d) => d.imageId);
  const segId = `graphy-segop-${++opSeq}-${sourceIds.length}`;
  csSeg.addSegmentations([
    { segmentationId: segId, representation: { type: LABELMAP, data: { imageIds: labelmapIds } } },
  ]);
  for (const vp of viewportIds) {
    try {
      csSeg.addLabelmapRepresentationToViewport(vp, [{ segmentationId: segId, type: LABELMAP }]);
    } catch {
      /* ignore */
    }
  }
  const base = getRoiMaskMeta(scopeFrom);
  setRoiMaskMeta(segId, {
    patientKey: base?.patientKey,
    seriesLabel: base?.seriesLabel,
    scope: base?.scope,
    origin: base?.origin,
    label,
  });
  return { segId, labelmapIds };
}

/**
 * 複数 Mask を OR/AND/XOR（前景=非ゼロ）で合成し新規 Mask（segment 1）を返す。
 * - or: いずれかが前景。and: すべて前景。xor: 前景数の奇偶（パリティ）。
 * 入力が同一 source スタックでない/2 件未満なら null。
 */
export async function combineMasks(
  maskIds: string[],
  op: BoolOp,
  viewportIds: string[],
): Promise<string | null> {
  if (maskIds.length < 2) return null;
  const masks = maskIds.map(readMask);
  if (masks.some((m) => !m)) return null;
  const m0 = masks[0] as MaskData;
  if (!masks.every((m) => sameStack((m as MaskData).sourceIds, m0.sourceIds))) return null;

  const res = await createResultSeg(m0.sourceIds, viewportIds, op.toUpperCase(), maskIds[0]);
  if (!res) return null;

  const modified: number[] = [];
  for (let s = 0; s < m0.labelmapIds.length; s++) {
    const outVm = img(res.labelmapIds[s])?.voxelManager;
    if (!outVm) continue;
    const len = outVm.getScalarDataLength();
    const inVms = masks.map((m) => img((m as MaskData).labelmapIds[s])?.voxelManager);
    let touched = false;
    for (let i = 0; i < len; i++) {
      let cnt = 0;
      for (const vm of inVms) if (vm && vm.getAtIndex(i) > 0) cnt++;
      const on = op === "or" ? cnt > 0 : op === "and" ? cnt === inVms.length : cnt % 2 === 1;
      if (on) {
        outVm.setAtIndex(i, 1);
        touched = true;
      }
    }
    if (touched) modified.push(s);
  }
  csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(res.segId, modified, 1);
  return res.segId;
}

/** エリア型 ROI（面積を持つ＝ラスタ化可能）の toolName か。 */
export function isAreaRoi(toolName: string | undefined): boolean {
  return /ellip|circle|rect|freehand|polygon|spline/i.test(toolName ?? "");
}

/** 多角形内判定（レイキャスト, 画素中心 [px,py]）。 */
function pointInPoly(px: number, py: number, poly: Array<[number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * ベクタ ROI（annotation）を 1 スライス分の前景 Uint8（cols*rows）にラスタ化する。
 * worldToImageCoords は [x(列), y(行)] を返す（imageToWorldCoords の逆対応で確認済）。
 * 楕円/円/矩形は形状式、フリーハンド等は多角形塗り。面積を持たない（Length/Angle/Probe）は null。
 */
function rasterizeRoi(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ann: any,
  cols: number,
  rows: number,
  refImageId: string,
): Uint8Array | null {
  const tool = (ann?.metadata?.toolName ?? "") as string;
  if (!isAreaRoi(tool)) return null;
  // 頂点（world）: フリーハンドは contour.polyline、その他は handles.points。
  const world: number[][] = ann?.data?.contour?.polyline ?? ann?.data?.handles?.points ?? [];
  if (!world.length) return null;
  const ipts: Array<[number, number]> = [];
  for (const w of world) {
    try {
      const ic = csUtils.worldToImageCoords(refImageId, w as [number, number, number]) as [number, number];
      ipts.push([ic[0], ic[1]]);
    } catch {
      /* skip */
    }
  }
  if (!ipts.length) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ipts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const fg = new Uint8Array(cols * rows);
  const set = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) fg[y * cols + x] = 1;
  };
  const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(cols - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(rows - 1, Math.ceil(maxY));

  if (/circle/i.test(tool) && ipts.length >= 2) {
    const [cx, cy] = ipts[0];
    const r = Math.hypot(ipts[1][0] - cx, ipts[1][1] - cy) || 0.5;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(rows - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(cols - 1, Math.ceil(cx + r)); x++)
        if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r) set(x, y);
  } else if (/ellip/i.test(tool)) {
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
    const rx = (maxX - minX) / 2 || 0.5, ry = (maxY - minY) / 2 || 0.5;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const nx = (x + 0.5 - cx) / rx, ny = (y + 0.5 - cy) / ry;
        if (nx * nx + ny * ny <= 1) set(x, y);
      }
  } else if (/rect/i.test(tool)) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y);
  } else {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (pointInPoly(x + 0.5, y + 0.5, ipts)) set(x, y);
  }
  return fg;
}

/** ROI の referencedImageId を含む stack viewport を探し、source スタックと表示先を返す。 */
export function resolveRoiStack(refImageId: string): { sourceIds: string[]; viewportIds: string[] } | null {
  for (const engine of getRenderingEngines() ?? []) {
    for (const vp of engine?.getViewports() ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = (vp as any).getImageIds?.() as string[] | undefined;
      if (ids?.includes(refImageId)) return { sourceIds: ids, viewportIds: [vp.id] };
    }
  }
  return null;
}

/**
 * ベクタ ROI（エリア型）を作成スライスへラスタ化し**新規 Mask** に変換する（ROI を演算対象化する橋渡し）。
 * source スタックと cols/rows は ROI を表示中の stack viewport から解決する。非エリア/解決不能なら null。
 */
export async function roiToMask(annotationUid: string): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ann = (csAnnotation.state as any).getAnnotation(annotationUid);
  const refId = ann?.metadata?.referencedImageId as string | undefined;
  if (!ann || !refId || !isAreaRoi(ann.metadata?.toolName)) return null;
  const stack = resolveRoiStack(refId);
  if (!stack) return null;
  const homeZ = stack.sourceIds.indexOf(refId);
  if (homeZ < 0) return null;
  const src = img(refId);
  const cols = (src?.columns ?? src?.width) as number;
  const rows = (src?.rows ?? src?.height) as number;
  if (!cols || !rows) return null;
  const fg = rasterizeRoi(ann, cols, rows, refId);
  if (!fg) return null;

  const res = await createResultSeg(stack.sourceIds, stack.viewportIds, getRoiMaskMeta(annotationUid)?.label || "ROI", annotationUid);
  if (!res) return null;
  const vm = img(res.labelmapIds[homeZ])?.voxelManager;
  if (!vm) return null;
  for (let i = 0; i < fg.length; i++) if (fg[i]) vm.setAtIndex(i, 1);
  csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(res.segId, [homeZ], 1);
  return res.segId;
}

/** 3D 連結性（6=面, 18=面+辺, 26=全て）。数字が大きいほど斜め接続もつなぎ、過分割が減る。 */
export type SplitConnectivity = 6 | 18 | 26;

/** 連結性に応じた 3D 近傍オフセット（[dx,dy,dz]）。累積: 6⊂18⊂26。 */
function splitOffsets(conn: SplitConnectivity): [number, number, number][] {
  const offs: [number, number, number][] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        const manh = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
        if (manh <= (conn === 6 ? 1 : conn === 18 ? 2 : 3)) offs.push([dx, dy, dz]);
      }
  return offs;
}

/**
 * 単一 Mask を 3D 連結成分で分割し、成分ごとに segment index(1..N) を割り当てた新規 Mask を返す。
 * connectivity: 6(面)/18(面+辺)/26(全て)。既定 26（見た目の塊数に近い＝斜め接続もつなぐ）。
 * 前景が無ければ null。成分数は {@link MAX_SEGMENTS} で上限（超過分は最終 index にまとめる）。
 */
export async function splitMask(maskId: string, viewportIds: string[], connectivity: SplitConnectivity = 26): Promise<string | null> {
  const m = readMask(maskId);
  if (!m) return null;
  const first = img(m.labelmapIds[0]);
  const cols = (first?.columns ?? first?.width) as number;
  const rows = (first?.rows ?? first?.height) as number;
  if (!cols || !rows) return null;
  const depth = m.labelmapIds.length;
  const sliceLen = cols * rows;

  // 前景を 1 本の Uint8 ボリュームへ。
  const fg = new Uint8Array(sliceLen * depth);
  for (let z = 0; z < depth; z++) {
    const vm = img(m.labelmapIds[z])?.voxelManager;
    if (!vm) continue;
    const base = z * sliceLen;
    for (let i = 0; i < sliceLen; i++) if (vm.getAtIndex(i) > 0) fg[base + i] = 1;
  }

  // 連結成分ラベリング（明示スタックの反復 flood fill）。近傍は connectivity で決定。
  const offs = splitOffsets(connectivity);
  const labels = new Int32Array(sliceLen * depth);
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < fg.length; start++) {
    if (!fg[start] || labels[start]) continue;
    next++;
    labels[start] = next;
    stack.length = 0;
    stack.push(start);
    while (stack.length) {
      const cur = stack.pop() as number;
      const z = (cur / sliceLen) | 0;
      const rem = cur - z * sliceLen;
      const y = (rem / cols) | 0;
      const x = rem - y * cols;
      for (const [dx, dy, dz] of offs) {
        const nx = x + dx, ny = y + dy, nz = z + dz;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || nz < 0 || nz >= depth) continue;
        const ni = nz * sliceLen + (ny * cols + nx);
        if (fg[ni] && !labels[ni]) { labels[ni] = next; stack.push(ni); }
      }
    }
  }
  if (next === 0) return null;

  const res = await createResultSeg(m.sourceIds, viewportIds, "SPLIT", maskId);
  if (!res) return null;
  const modified: number[] = [];
  for (let z = 0; z < depth; z++) {
    const vm = img(res.labelmapIds[z])?.voxelManager;
    if (!vm) continue;
    const base = z * sliceLen;
    let touched = false;
    for (let i = 0; i < sliceLen; i++) {
      const lab = labels[base + i];
      if (lab > 0) {
        vm.setAtIndex(i, lab > MAX_SEGMENTS ? MAX_SEGMENTS : lab);
        touched = true;
      }
    }
    if (touched) modified.push(z);
  }
  csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(res.segId, modified, undefined);
  // 成分ごとの segment index(1..N, MAX_SEGMENTS 上限) をパネルへ（segment チップ表示・選択用）。
  const segCount = Math.min(next, MAX_SEGMENTS);
  setRoiMaskMeta(res.segId, { segments: Array.from({ length: segCount }, (_, i) => i + 1) });
  return res.segId;
}
