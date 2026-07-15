/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Wand（対話型リージョングロー）ツール。GRAPHY の 2D/3D Wand 相当を、ダイアログ駆動で改良。
 *
 * - クリック点を **シード（制御点）** として記憶（`wandStore`）。
 * - Threshold（シード輝度からの許容差）・Connectivity をダイアログで変えると、同じシードから
 *   再フラッドして**結果を置換（追加ではなく Update）**する。
 * - 2D=シード面内のみ、3D=ボリューム全体。書込先は**アクティブ (mask, segment)**。
 *
 * 置換のため、前回書き込んだボクセルの**元値**を保持し、再実行時にまず復元してから新結果を書く。
 */
import { getEnabledElement, cache, imageLoader, utilities as csUtils } from "@cornerstonejs/core";
import { BaseTool, segmentation as csSeg } from "@cornerstonejs/tools";
import { getSegEditTarget } from "./roiMaskStore";
import { ensureStackSegmentation } from "./segmentation";
import { openWandSession, clearWandSession, getWandSession, type WandSession, type WandMode } from "./wandStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

const MAX_VOXELS = 4_000_000; // 暴走防止（threshold 過大で全域に広がるのを抑制）。

/** 前回フラッドで書き込んだボクセルの元値（globalIndex=z*sliceLen+idx → priorValue）と影響スライス。 */
let tracked: Map<number, number> | null = null;

function labelmapVmAt(labelmapIds: string[], z: number): AnyObj | null {
  const img = cache.getImage(labelmapIds[z]) as AnyObj | undefined;
  return img?.voxelManager ?? null;
}

/** 2D 近傍オフセット。4=辺, 8=辺＋角。 */
function offsets2D(conn: number): [number, number][] {
  const four: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  if (conn === 4) return four;
  return [...four, [1, 1], [1, -1], [-1, 1], [-1, -1]];
}
/** 3D 近傍オフセット。6=面(manh1), 12=辺(manh2), 8=角(manh3), 26=全て。 */
function offsets3D(conn: number): [number, number, number][] {
  const all: { o: [number, number, number]; m: number }[] = [];
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0 && dz === 0) continue;
        all.push({ o: [dx, dy, dz], m: Math.abs(dx) + Math.abs(dy) + Math.abs(dz) });
      }
  if (conn === 6) return all.filter((a) => a.m === 1).map((a) => a.o);
  if (conn === 12) return all.filter((a) => a.m === 2).map((a) => a.o);
  if (conn === 8) return all.filter((a) => a.m === 3).map((a) => a.o);
  return all.map((a) => a.o);
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
  const pxOf = (z: number): ArrayLike<number> | null => {
    const img = cache.getImage(sourceImageIds[z]) as AnyObj | undefined;
    return img ? (img.getPixelData() as ArrayLike<number>) : null;
  };
  const within = (v: number) => Math.abs(v - seedValue) <= threshold;

  let count = 0;
  if (s.mode === "2d") {
    const px = pxOf(s.seedZ);
    if (px) {
      const offs = offsets2D(s.connectivity);
      const visited = new Uint8Array(sliceLen);
      const stack: number[] = [s.seedY * cols + s.seedX];
      visited[stack[0]] = 1;
      while (stack.length && count < MAX_VOXELS) {
        const i = stack.pop() as number;
        if (!within(px[i])) continue;
        write(s.seedZ, i);
        count++;
        const y = Math.floor(i / cols);
        const x = i - y * cols;
        for (const [dx, dy] of offs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const ni = ny * cols + nx;
          if (!visited[ni]) { visited[ni] = 1; stack.push(ni); }
        }
      }
    }
  } else {
    const depth = sourceImageIds.length;
    const offs = offsets3D(s.connectivity);
    const pxCache: (ArrayLike<number> | null)[] = new Array(depth).fill(undefined as unknown as null);
    const getPx = (z: number) => (pxCache[z] === undefined ? (pxCache[z] = pxOf(z)) : pxCache[z]);
    const visited = new Set<number>();
    const startG = s.seedZ * sliceLen + (s.seedY * cols + s.seedX);
    const stack: number[] = [startG];
    visited.add(startG);
    while (stack.length && count < MAX_VOXELS) {
      const g = stack.pop() as number;
      const z = Math.floor(g / sliceLen);
      const rem = g - z * sliceLen;
      const y = Math.floor(rem / cols);
      const x = rem - y * cols;
      const px = getPx(z);
      if (!px || !within(px[rem])) continue;
      write(z, rem);
      count++;
      for (const [dx, dy, dz] of offs) {
        const nx = x + dx;
        const ny = y + dy;
        const nz = z + dz;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || nz < 0 || nz >= depth) continue;
        const ng = nz * sliceLen + (ny * cols + nx);
        if (!visited.has(ng)) { visited.add(ng); stack.push(ng); }
      }
    }
  }

  tracked = nextTracked;
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
  const ic = csUtils.worldToImageCoords(refImageId, world) as [number, number] | undefined;
  if (!ic) return;
  const sx = Math.round(ic[0]);
  const sy = Math.round(ic[1]);
  if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) return;
  const seedValue = Number(px[sy * cols + sx]);

  // シードスライスの輝度 min/max（スライダー範囲）。
  let rangeMin = seedValue;
  let rangeMax = seedValue;
  for (let i = 0; i < cols * rows; i++) {
    const v = px[i];
    if (v < rangeMin) rangeMin = v;
    if (v > rangeMax) rangeMax = v;
  }

  // 3D は全スライスの source 画素が要るため事前ロード。
  if (mode === "3d") {
    await Promise.all(stack.map((id) => imageLoader.loadAndCacheImage(id).catch(() => null)));
  }

  const prev = getWandSession();
  const threshold = prev ? prev.threshold : Math.max(1, Math.round((rangeMax - rangeMin) * 0.02));
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
