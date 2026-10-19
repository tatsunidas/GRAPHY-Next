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
 * 前提: 入力 Mask は同一 source スタック（同一 series/C/T）に載っていること。1 枚だけのラベルマップ
 * （⬚ 分割の出力）も、referencedImageId で元のスタックへ当てはめて演算する（{@link alignToStack}）。
 * 設計: `fw/roi-manager-design.md` 第4章。
 */
import { cache, imageLoader, getRenderingEngines } from "@cornerstonejs/core";
import { annotation as csAnnotation, segmentation as csSeg, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { roiKindOf } from "./roiKind";
import { deleteRoiMaskMeta, getRoiMaskMeta, setRoiMaskMeta } from "./roiMaskStore";
import { worldToImageCoords } from "./imageCoords";
import { alignToStack, combineLabelSlices, scopeZFromForeground, withTemp, type BoolOp } from "./maskScope";
import { isSegmentForeground } from "./maskStatsCore";
import { fillPolygonsEvenOdd } from "./maskContour";

const LABELMAP = csToolsEnums.SegmentationRepresentations.Labelmap;
const MAX_SEGMENTS = 64; // SPLIT の成分数上限（色枯渇/重さ回避）。
let opSeq = 0;

export type { BoolOp };

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

/**
 * 結果のマスクの scope.z を、前景を塗ったスライスから決め直す。
 * 入力のメタ（createResultSeg の scopeFrom）の z は中身と合わないことがあるため（⬤ の球・演算の結果）。
 * `localIndices` はラベルマップ上の番号。1 枚だけのラベルマップもあるので、表示中のスタック上の番号に直してから決める。
 */
export function setScopeZFromForeground(
  segId: string,
  sourceIds: ReadonlyArray<string>,
  localIndices: ReadonlyArray<number>,
): void {
  const stack = sourceIds.length ? resolveRoiStack(sourceIds[0])?.sourceIds : undefined;
  const stackIndices = localIndices.map((k) => {
    const s = stack ? stack.indexOf(sourceIds[k]) : -1;
    return s >= 0 ? s : k;
  });
  const z = scopeZFromForeground(stackIndices);
  if (z === null) return;
  const base = getRoiMaskMeta(segId);
  setRoiMaskMeta(segId, { scope: { ...base?.scope, z }, origin: { ...base?.origin, z } });
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

/** ブール演算の入力 1 件（塗りの ROI）。`segIndex` を指定するとその segment のみ前景、無ければ非ゼロすべて。 */
export interface MaskOperand {
  maskId: string;
  segIndex?: number;
}

/**
 * 複数の塗りの ROI を OR/AND/XOR で合成し新規 Mask（segment 1）を返す。
 * - 前景: `segIndex` 指定ならその値のボクセル、無ければ非ゼロ。
 * - or: いずれかが前景。and: すべて前景。xor: 前景数の奇偶（パリティ）。
 * 入力が同一 source スタックでない/2 件未満なら null。
 */
export async function combineMasks(
  operands: MaskOperand[],
  op: BoolOp,
  viewportIds: string[],
): Promise<string | null> {
  if (operands.length < 2) return null;
  const masks = operands.map((o) => readMask(o.maskId));
  if (masks.some((m) => !m)) return null;
  const ms = masks as MaskData[];
  // 当てはめ先: シリーズ全体の大きさのマスクがあればその列、無ければ表示中のスタック。
  const full = ms.reduce((a, b) => (b.sourceIds.length > a.sourceIds.length ? b : a));
  const target = resolveRoiStack(full.sourceIds[0])?.sourceIds ?? full.sourceIds;
  const aligned = ms.map((m) => alignToStack(target, m.sourceIds));
  if (aligned.some((a) => !a)) return null;

  const res = await createResultSeg(target, viewportIds, op.toUpperCase(), operands[0].maskId);
  if (!res) return null;

  const modified: number[] = [];
  for (let s = 0; s < target.length; s++) {
    const outVm = img(res.labelmapIds[s])?.voxelManager;
    if (!outVm) continue;
    const len = outVm.getScalarDataLength();
    const inputs = ms.map((m, k) => {
      const j = (aligned[k] as Int32Array)[s];
      const vm = j >= 0 ? img(m.labelmapIds[j])?.voxelManager : null;
      let labels: Int32Array | null = null;
      if (vm) {
        labels = new Int32Array(len);
        for (let i = 0; i < len; i++) labels[i] = vm.getAtIndex(i);
      }
      return { labels, segIndex: operands[k].segIndex };
    });
    const fg = combineLabelSlices(op, inputs, len);
    let touched = false;
    for (let i = 0; i < len; i++) {
      if (fg[i]) {
        outVm.setAtIndex(i, 1);
        touched = true;
      }
    }
    if (touched) modified.push(s);
  }
  csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(res.segId, modified, 1);
  setScopeZFromForeground(res.segId, target, modified);
  return res.segId;
}

/** ROI 一覧で選んだ 1 行。形のまま（annotation）か、塗り（labelmap）か。`segIndex` 未指定はマスク全体。 */
export type RoiOperand = { kind: "shape"; uid: string } | { kind: "painted"; maskId: string; segIndex?: number };

/**
 * 選んだ ROI（形・塗りの混在可）を合成する。形の ROI は先に一時マスクへラスタ化して演算に入れ、
 * 演算後に一時マスクは取り除く（パネルに結果以外のマスクを残さないため）。
 * 形をラスタ化できない（面積型でない/表示先が見つからない）ものが 1 つでもあれば null。
 */
export async function combineRois(operands: RoiOperand[], op: BoolOp, viewportIds: string[]): Promise<string | null> {
  const run = async (i: number, resolved: MaskOperand[]): Promise<string | null> => {
    if (i === operands.length) return combineMasks(resolved, op, viewportIds);
    const o = operands[i];
    if (o.kind === "painted") return run(i + 1, [...resolved, { maskId: o.maskId, segIndex: o.segIndex }]);
    return withTempMask(o.uid, (tmp) => run(i + 1, [...resolved, { maskId: tmp }]));
  };
  return run(0, []);
}

/**
 * 形の ROI（面積型）を一時の塗りの ROI にして `fn` に渡し、終わったら一時の塗りを消す。
 * パネルに結果以外の塗りを残さないため。ラスタ化できなければ null。
 */
export function withTempMask<T>(annotationUid: string, fn: (maskId: string) => Promise<T> | T): Promise<T | null> {
  return withTemp(() => roiToMask(annotationUid), removeTempMask, fn);
}

function removeTempMask(id: string): void {
  try { csSeg.removeSegmentation(id); } catch { /* ignore */ }
  deleteRoiMaskMeta(id);
}

/** エリア型 ROI（面積を持つ＝ラスタ化可能）の toolName か。 */
export function isAreaRoi(toolName: string | undefined): boolean {
  return roiKindOf(toolName) === "area";
}

/**
 * ベクタ ROI（annotation）を 1 スライス分の前景 Uint8（cols*rows）にラスタ化する。
 * worldToImageCoords は [x(列), y(行)] を返す（imageToWorldCoords の逆対応で確認済）。
 * 楕円/円/矩形は形状式、フリーハンド等は多角形塗り。面積を持たない（Length/Angle/Probe）は null。
 *
 * <p>⚠ **ROI 統計はこれを使わない**（`viewer/roiStats.ts` は自前のメッシュを塗る）。
 * 統計では「面積を出した多角形」と「値を拾った画素」が同じ図形でないと数字が食い違うため
 * （`fw/roi-stats-design.md` §4.2）。こちらは Mask 化（ブール演算の入口）専用。
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
      const ic = worldToImageCoords(refImageId, w as [number, number, number]) as [number, number];
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
    // 画素中心の偶奇判定。マスク→輪郭（maskContour）の塗り直しと同じ関数を使う。
    const filled = fillPolygonsEvenOdd([ipts], cols, rows);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (filled[y * cols + x]) set(x, y);
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
  setScopeZFromForeground(res.segId, stack.sourceIds, [homeZ]);
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
 * `segIndex` を指定するとその segment のボクセルだけを分割する（塗りの ROI 1 件）。
 * 前景が無ければ null。成分数は {@link MAX_SEGMENTS} で上限（超過分は最終 index にまとめる）。
 */
export async function splitMask(
  maskId: string,
  viewportIds: string[],
  connectivity: SplitConnectivity = 26,
  segIndex?: number,
): Promise<string | null> {
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
    for (let i = 0; i < sliceLen; i++) if (isSegmentForeground(vm.getAtIndex(i), segIndex)) fg[base + i] = 1;
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
  setScopeZFromForeground(res.segId, m.sourceIds, modified);
  // 成分ごとの segment index(1..N, MAX_SEGMENTS 上限) をパネルへ（segment チップ表示・選択用）。
  const segCount = Math.min(next, MAX_SEGMENTS);
  setRoiMaskMeta(res.segId, { segments: Array.from({ length: segCount }, (_, i) => i + 1) });
  return res.segId;
}
