/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Wand（対話型リージョングロー）ツール。GRAPHY の 2D/3D Wand 相当を、ダイアログ駆動で改良。
 *
 * - クリック点を **シード（制御点）** として記憶（`wandStore`）。
 * - 方式（許容差・以上・以下・範囲。どれも同じ判定値で判定）・Connectivity をダイアログで変えると、同じシードから
 *   再フラッドして**結果を置換（追加ではなく Update）**する。
 * - 2D=シード面内のみ、3D=ボリューム全体。書込先は**アクティブ (mask, segment)**。
 *
 * 置換のため、前回書き込んだボクセルの**元値**を保持し、再実行時にまず復元してから新結果を書く。
 */
import { getEnabledElement, cache, imageLoader, metaData } from "@cornerstonejs/core";
import { BaseTool, segmentation as csSeg } from "@cornerstonejs/tools";
import { getSegEditTarget } from "./roiMaskStore";
import { ensureStackSegmentation } from "./segmentation";
import { openWandSession, updateWandSession, clearWandSession, getWandSession, type WandSession, type WandMode, type WandValueKind } from "./wandStore";
import { worldToImageCoords, imageToWorldCoords } from "./imageCoords";
import { getModalityCalibration, resolveValueUnit } from "./pixelCalibration";
import { roiPointsPx } from "./roiRead";
import { floodRegion, offsets2D, offsets3D, acceptTolerance, acceptGe, acceptLe, acceptRange, makeValueReader } from "./wandFlood";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const MAX_VOXELS = 4_000_000; // 暴走防止（threshold 過大で全域に広がるのを抑制）。

/** 前回フラッドで書き込んだボクセルの元値（globalIndex=z*sliceLen+idx → priorValue）と影響スライス。 */
let tracked: Map<number, number> | null = null;

function labelmapVmAt(labelmapIds: string[], z: number): AnyObj | null {
  const img = cache.getImage(labelmapIds[z]) as AnyObj | undefined;
  return img?.voxelManager ?? null;
}

/** tracked を元値へ復元（前回結果を消す）。影響スライスを返す。 */
function restoreTracked(labelmapIds: string[], cols: number, rows: number): Set<number> {
  const slices = new Set<number>();
  if (!tracked) return slices;
  const sliceLen = cols * rows;
  for (const [gi, prior] of tracked) {
    const z = Math.floor(gi / sliceLen);
    const idx = gi - z * sliceLen;
    const vm = labelmapVmAt(labelmapIds, z);
    if (vm) {
      vm.setAtIndex(idx, prior);
      slices.add(z);
    }
  }
  tracked = null;
  return slices;
}

/** 画像 1 枚の判定値の読み手（{@link makeValueReader}）。係数は `getModalityCalibration` の唯一の入口から取る。 */
function valueReaderOf(img: AnyObj, imageId: string): (i: number) => number {
  const px = img.getPixelData() as ArrayLike<number>;
  const n = Number(img.columns ?? img.width) * Number(img.rows ?? img.height);
  const comps = Math.max(1, Math.round(px.length / n));
  const cal = getModalityCalibration(img, imageId);
  return makeValueReader(px, comps, cal.scale, cal.offset);
}

/** 有効数字 3 桁に丸める（許容差の初期値の表示用）。 */
function roundSig(v: number): number {
  return v > 0 ? Number(v.toPrecision(3)) : 0;
}

/** シードから現在の Threshold/Connectivity でフラッドし、結果を書き込む（前回結果は置換）。 */
export function runWand(s: WandSession): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labelmapIds = (csSeg as any).getLabelmapImageIds?.(s.segId) as string[] | undefined;
  if (!labelmapIds?.length) return;
  const { cols, rows, seedValue, threshold, segIndex, sourceImageIds } = s;
  const sliceLen = cols * rows;
  const modified = restoreTracked(labelmapIds, cols, rows);
  const nextTracked = new Map<number, number>();

  const write = (z: number, idx: number) => {
    const vm = labelmapVmAt(labelmapIds, z);
    if (!vm) return;
    const gi = z * sliceLen + idx;
    if (!nextTracked.has(gi)) nextTracked.set(gi, vm.getAtIndex(idx));
    vm.setAtIndex(idx, segIndex);
    modified.add(z);
  };
  // 判定値（どの方式も同じ）。係数はスライスごと（Rescale が無ければ保存値、カラーは輝度）。
  const method = s.method ?? "tolerance";
  const depth = sourceImageIds.length;
  const readerCache: (((i: number) => number) | null | undefined)[] = new Array(depth).fill(undefined);
  const readerAt = (z: number) => {
    if (readerCache[z] === undefined) {
      const img = cache.getImage(sourceImageIds[z]) as AnyObj | undefined;
      readerCache[z] = img ? valueReaderOf(img, sourceImageIds[z]) : null;
    }
    return readerCache[z];
  };
  const readOf = (zMap: (z: number) => number) => (z: number, i: number): number | null => {
    const r = readerAt(zMap(z));
    return r ? r(i) : null;
  };
  const lower = s.lower ?? seedValue;
  const upper = s.upper ?? seedValue;
  const accept =
    method === "ge" ? acceptGe(lower)
    : method === "le" ? acceptLe(upper)
    : method === "range" ? acceptRange(lower, upper)
    : acceptTolerance(seedValue, threshold);

  const res =
    s.mode === "2d"
      ? floodRegion(readOf(() => s.seedZ), { cols, rows, depth: 1 }, { x: s.seedX, y: s.seedY, z: 0 }, accept, offsets2D(s.connectivity), MAX_VOXELS)
      : floodRegion(readOf((z) => z), { cols, rows, depth }, { x: s.seedX, y: s.seedY, z: s.seedZ }, accept, offsets3D(s.connectivity), MAX_VOXELS);
  for (const g of res.indices) {
    const z = Math.floor(g / sliceLen);
    write(s.mode === "2d" ? s.seedZ : z, g - z * sliceLen);
  }

  tracked = nextTracked;
  updateWandSession({ count: res.indices.length, truncated: res.truncated, seedRejected: res.seedRejected });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csSeg as any).triggerSegmentationEvents.triggerSegmentationDataModified(s.segId, [...modified], segIndex);
  } catch {
    /* ignore */
  }
}

/** 現在の Wand 結果を確定（永続化）してセッションを閉じる。 */
export function commitWand(): void {
  tracked = null;
  clearWandSession();
}

/** 現在の Wand 結果を取り消して（元値へ復元）セッションを閉じる。 */
export function cancelWand(): void {
  const s = getWandSession();
  if (s) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labelmapIds = (csSeg as any).getLabelmapImageIds?.(s.segId) as string[] | undefined;
    if (labelmapIds?.length) {
      const modified = restoreTracked(labelmapIds, s.cols, s.rows);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (csSeg as any).triggerSegmentationEvents.triggerSegmentationDataModified(s.segId, [...modified], s.segIndex);
      } catch {
        /* ignore */
      }
    }
  }
  tracked = null;
  clearWandSession();
}

/** クリック位置（world）からシードを決めてセッションを開始（or 再シード）し、初回フラッドする。 */
async function startWand(viewport: AnyObj, world: [number, number, number], mode: WandMode): Promise<void> {
  const refImageId: string | undefined = viewport.getCurrentImageId?.();
  if (!refImageId) return;
  const stack = (viewport.getImageIds?.() as string[] | undefined) ?? [];
  const seedZ = stack.indexOf(refImageId);
  if (seedZ < 0) return;
  // アクティブ編集対象はツール切替時のブロードキャスト（他タイルの activate）で上書きされ得るため、
  // 実際にクリックされたこの viewport のスタックに対して都度再確認する（他シリーズへの誤描画防止）。
  const segmentationId = await ensureStackSegmentation(viewport.id, stack);
  if (!segmentationId) return;
  const target = { segmentationId, segmentIndex: getSegEditTarget().segmentIndex };
  const src = cache.getImage(refImageId) as AnyObj | undefined;
  if (!src) return;
  const px = src.getPixelData() as ArrayLike<number>;
  const cols = Number(src.columns ?? src.width);
  const rows = Number(src.rows ?? src.height);
  if (!cols || !rows) return;
  // 幾何（IPP/IOP）が無い画像（CR・US・XA など）は変換が NaN になるので、roiPointsPx の換算へ落とす。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plane: any = metaData.get("imagePlaneModule", refImageId) ?? {};
  const ic = roiPointsPx(
    [world],
    (w) => worldToImageCoords(refImageId, w as [number, number, number]) as [number, number] | undefined,
    plane.columnPixelSpacing,
    plane.rowPixelSpacing,
  )[0];
  if (!ic) return;
  const sx = Math.round(ic[0]);
  const sy = Math.round(ic[1]);
  if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) return;
  const comps = Math.max(1, Math.round(px.length / (cols * rows)));
  const read = valueReaderOf(src, refImageId);
  const seedValue = read(sy * cols + sx);

  // シードスライスの判定値の min/max（スライダー範囲）。
  let rangeMin = seedValue;
  let rangeMax = seedValue;
  for (let i = 0; i < cols * rows; i++) {
    const v = read(i);
    if (v < rangeMin) rangeMin = v;
    if (v > rangeMax) rangeMax = v;
  }

  // 3D は全スライスの source 画素が要るため事前ロード。
  if (mode === "3d") {
    await Promise.all(stack.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
  }

  const calUnit = getModalityCalibration(src, refImageId).unit;
  const valueKind: WandValueKind = comps >= 3 ? "luminance" : calUnit === "raw" ? "stored" : "calibrated";
  const unit = valueKind === "calibrated" ? resolveValueUnit(refImageId) : "";
  const w = imageToWorldCoords(refImageId, [sx + 0.5, sy + 0.5]) as [number, number, number];
  const seedWorld = w.every(Number.isFinite) ? w : undefined; // 幾何が無ければ LPS は出さない

  const prev = getWandSession();
  const threshold = prev ? prev.threshold : roundSig((rangeMax - rangeMin) * 0.02);
  const connectivity = prev && prev.mode === mode ? prev.connectivity : mode === "2d" ? 8 : 6;

  const session: WandSession = {
    mode,
    viewportId: viewport.id,
    segId: target.segmentationId,
    segIndex: target.segmentIndex || 1,
    sourceImageIds: stack,
    cols,
    rows,
    seedZ,
    seedX: sx,
    seedY: sy,
    seedValue,
    threshold,
    connectivity,
    rangeMin,
    rangeMax,
    // 方式は再シードでも保つ。新規セッションは「許容差」（従来の既定）。
    method: prev?.method ?? "tolerance",
    // 絶対値の方式の初期しきい値＝シードの判定値（シードは必ず条件を満たす）。再シードでは前回値を保つ。
    lower: prev?.lower ?? seedValue,
    upper: prev?.upper ?? (prev?.method === "range" ? rangeMax : seedValue),
    unit,
    valueKind,
    seedWorld,
  };
  // 再シード時は前回結果を消してから新シードでフラッド（tracked は runWand が復元）。
  openWandSession(session);
  runWand(session);
}

export class WandTool extends BaseTool {
  static toolName = "GraphyWand";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(props: AnyObj = {}) {
    super(props, {
      supportedInteractionTypes: ["Mouse"],
      configuration: { mode: "2d" as WandMode },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async preMouseDownCallback(evt: AnyObj): Promise<boolean> {
    const { element, currentPoints } = evt.detail;
    const world = currentPoints.world as [number, number, number];
    try {
      const { viewport } = getEnabledElement(element) as AnyObj;
      await startWand(viewport, world, (this.configuration.mode as WandMode) ?? "2d");
    } catch (e) {
      console.warn("[wand] failed", e);
    }
    return true; // クリック確定でイベント消費。
  }
}
