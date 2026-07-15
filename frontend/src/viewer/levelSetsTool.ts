/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Level Sets ツール（L2: Fast Marching ＋ Active Contours）。`wandTool.ts` と同じ構造。
 *
 * - クリック点を **シード** として記憶（`levelSetsStore`）。
 * - `Use Fast Marching` / `Use Level Sets(Active Contours)` は独立チェックボックス（fw/level-sets-design.md §1.1）。
 *   両方 ON なら Fast Marching の結果を Active Contours の初期輪郭として使う（Fiji `LevelSet.execute()` と同じ
 *   2 段パイプライン）。Fast Marching が OFF のときは、クリックしたスライスの**既存のアクティブ segment 画素**を
 *   初期輪郭として使う（§1.4：領域シードが必須の Active Contours 向け）。
 * - パラメータを変えると同じ起点（シード or 既存マスクのスナップショット）から再実行して
 *   **結果を置換（追加ではなく Update）**する。
 * - 実計算はメインスレッドをブロックしない Web Worker（`levelSetsWorker.ts`）で行う
 *   （fw/level-sets-design.md §3。本リポジトリ初の画像処理用 Worker）。
 * - 2D のみ（現スライス）。書込先は**アクティブ (mask, segment)**。
 *
 * 置換のため、前回書き込んだボクセルの**元値**を保持し、再実行時にまず復元してから新結果を書く
 * （`wandTool.ts` の `tracked`/`restoreTracked` と同じ発想）。
 */
import { getEnabledElement, cache, utilities as csUtils } from "@cornerstonejs/core";
import { BaseTool, segmentation as csSeg } from "@cornerstonejs/tools";
import { getSegEditTarget } from "./roiMaskStore";
import { ensureStackSegmentation } from "./segmentation";
import { emitToast } from "./toast";
import {
  openLevelSetSession,
  clearLevelSetSession,
  getLevelSetSession,
  updateLevelSetSession,
  type LevelSetSession,
  type FastMarchingParams,
  type ActiveContoursParams,
} from "./levelSetsStore";
import type { LevelSetWorkerRequest, LevelSetWorkerResponse } from "./levelSetsProtocol";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

// distanceThreshold の 0.5 という値そのものは Fiji の既定値だが意味が異なる（下記 startLevelSet 参照）。
// ここでの値は「前セッションが無い」場合の startLevelSet 側フォールバックが必ず上書きするため参照専用。
const DEFAULT_FAST_MARCHING: FastMarchingParams = { enabled: true, greyValueThreshold: 50, distanceThreshold: 200 };
// Fiji のデフォルト値（fw/level-sets-design.md §1.2）を踏襲。narrowBand/edgeSigma は Fiji に無い本実装独自の追加項目。
const DEFAULT_ACTIVE_CONTOURS: ActiveContoursParams = {
  enabled: false, method: "activeContours", advection: 2.2, curvature: 1.0, grayscaleTolerance: 30.0,
  propagation: 1.0, edgeSigma: 1.0, convergence: 0.005, regionExpandsTo: "outside", narrowBand: 5,
};
// UI 非露出の内部安全弁（fw/level-sets-design.md §1.0-5）。
const AC_REINIT_INTERVAL = 10;
const AC_MAX_ITERATIONS = 1000;

let worker: Worker | null = null;
let nextRequestId = 1;
/** 前回書き込んだボクセルの元値（スライス内 index → priorValue）。 */
let tracked: Map<number, number> | null = null;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./levelSetsWorker.ts", import.meta.url), { type: "module" });
  }
  return worker;
}

function labelmapVmAt(labelmapIds: string[], z: number): AnyObj | null {
  const img = cache.getImage(labelmapIds[z]) as AnyObj | undefined;
  return img?.voxelManager ?? null;
}

function restoreTracked(vm: AnyObj | null): void {
  if (tracked && vm) {
    for (const [idx, prior] of tracked) vm.setAtIndex(idx, prior);
  }
  tracked = null;
}

function postToWorker<T extends LevelSetWorkerResponse["type"]>(
  req: LevelSetWorkerRequest,
  transfer: ArrayBuffer[],
  doneType: T,
): Promise<LevelSetWorkerResponse & { type: T }> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (ev: MessageEvent<LevelSetWorkerResponse>) => {
      const res = ev.data;
      if (res.requestId !== req.requestId) return;
      w.removeEventListener("message", onMessage);
      if (res.type === doneType) resolve(res as LevelSetWorkerResponse & { type: T });
      else reject(new Error(res.message ?? "level set worker error"));
    };
    w.addEventListener("message", onMessage);
    w.postMessage(req, transfer);
  });
}

async function requestFastMarching(
  image: Float32Array, cols: number, rows: number, seedX: number, seedY: number, params: FastMarchingParams,
): Promise<Uint8Array> {
  const requestId = nextRequestId++;
  const req: LevelSetWorkerRequest = {
    type: "fastMarching", requestId, image,
    dims: { cols, rows, depth: 1 }, seedX, seedY, seedZ: 0,
    greyValueThreshold: params.greyValueThreshold, distanceThreshold: params.distanceThreshold,
  };
  const res = await postToWorker(req, [image.buffer as ArrayBuffer], "fastMarchingDone");
  return res.mask as Uint8Array;
}

async function requestActiveContours(
  image: Float32Array, cols: number, rows: number, initMask: Uint8Array, params: ActiveContoursParams,
): Promise<{ mask: Uint8Array; iterations: number; lastChange: number }> {
  const requestId = nextRequestId++;
  const transfer = [image.buffer as ArrayBuffer, initMask.buffer as ArrayBuffer];
  if (params.method === "geodesicActiveContours") {
    const req: LevelSetWorkerRequest = {
      type: "geodesicActiveContours", requestId, image,
      dims: { cols, rows, depth: 1 }, initMask,
      regionExpandsTo: params.regionExpandsTo,
      advection: params.advection, propagation: params.propagation, curvature: params.curvature,
      edgeSigma: params.edgeSigma, convergence: params.convergence,
      narrowBand: params.narrowBand, reinitInterval: AC_REINIT_INTERVAL, maxIterations: AC_MAX_ITERATIONS,
    };
    const res = await postToWorker(req, transfer, "geodesicActiveContoursDone");
    return { mask: res.mask as Uint8Array, iterations: res.iterations ?? 0, lastChange: res.lastChange ?? 0 };
  }
  const req: LevelSetWorkerRequest = {
    type: "activeContours", requestId, image,
    dims: { cols, rows, depth: 1 }, initMask,
    regionExpandsTo: params.regionExpandsTo,
    advection: params.advection, curvature: params.curvature,
    grayscaleTolerance: params.grayscaleTolerance, convergence: params.convergence,
    narrowBand: params.narrowBand, reinitInterval: AC_REINIT_INTERVAL, maxIterations: AC_MAX_ITERATIONS,
  };
  const res = await postToWorker(req, transfer, "activeContoursDone");
  return { mask: res.mask as Uint8Array, iterations: res.iterations ?? 0, lastChange: res.lastChange ?? 0 };
}

/** クリックしたスライスの、アクティブ segment の現在の画素を Uint8Array（1=segIndex）で読み出す。 */
function readActiveSegmentMask(vm: AnyObj, cols: number, rows: number, segIndex: number): Uint8Array {
  const n = cols * rows;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = vm.getAtIndex(i) === segIndex ? 1 : 0;
  return mask;
}

/** 現在のセッションのパラメータで実行し、結果を labelmap へ書き込む（前回結果は置換）。 */
export async function runLevelSet(s: LevelSetSession): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const labelmapIds = (csSeg as any).getLabelmapImageIds?.(s.segId) as string[] | undefined;
  if (!labelmapIds?.length) return;
  const vm = labelmapVmAt(labelmapIds, s.seedZ);
  if (!vm) return;
  const srcImg = cache.getImage(s.sourceImageIds[s.seedZ]) as AnyObj | undefined;
  if (!srcImg) return;
  const srcPx = srcImg.getPixelData() as ArrayLike<number>;
  // Cornerstone のキャッシュ画素バッファは transfer で detach してはいけないので、必ずコピーする。
  const makeImageCopy = (): Float32Array => {
    const img = new Float32Array(s.cols * s.rows);
    for (let i = 0; i < img.length; i++) img[i] = srcPx[i];
    return img;
  };

  updateLevelSetSession({ status: "running" });

  // 前回の書込を復元してから、今回の起点（initMask）を決める（§ヘッダのコメント参照）。
  restoreTracked(vm);

  let finalMask: Uint8Array;
  let iterations: number | undefined;
  let lastChange: number | undefined;
  let reachedCount = 0;

  try {
    let initMask: Uint8Array | null = null;
    if (s.fastMarching.enabled) {
      const fmMask = await requestFastMarching(makeImageCopy(), s.cols, s.rows, s.seedX, s.seedY, s.fastMarching);
      initMask = fmMask;
      finalMask = fmMask;
      reachedCount = fmMask.reduce((a, b) => a + b, 0);
    } else {
      // Fast Marching 無効: セッション開始時点の既存マスクのスナップショットを起点にする（固定、毎回同じ）。
      // スナップショット本体は再実行のたびに Worker へ transfer で渡すため、必ずコピーしてから使う
      // （transfer すると ArrayBuffer が detach され、次回の再実行でスナップショットが壊れる）。
      const base = s.initMaskSnapshot ?? readActiveSegmentMask(vm, s.cols, s.rows, s.segIndex);
      initMask = new Uint8Array(base);
      finalMask = initMask;
      reachedCount = initMask.reduce((a, b) => a + b, 0);
    }

    if (s.activeContours.enabled) {
      if (reachedCount === 0) {
        updateLevelSetSession({ status: "noInitContour", reachedCount: 0 });
        emitToast("Level Sets: 初期輪郭がありません（Fast Marching を有効にするか、既存マスクを描いてから実行してください）");
        return;
      }
      const acResult = await requestActiveContours(makeImageCopy(), s.cols, s.rows, initMask, s.activeContours);
      finalMask = acResult.mask;
      iterations = acResult.iterations;
      lastChange = acResult.lastChange;
      reachedCount = finalMask.reduce((a, b) => a + b, 0);
    }
  } catch (e) {
    console.warn("[levelSet] run failed", e);
    updateLevelSetSession({ status: "error" });
    return;
  }

  const nextTracked = new Map<number, number>();
  for (let i = 0; i < finalMask.length; i++) {
    if (!finalMask[i]) continue;
    if (!nextTracked.has(i)) nextTracked.set(i, vm.getAtIndex(i));
    vm.setAtIndex(i, s.segIndex);
  }
  tracked = nextTracked;

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (csSeg as any).triggerSegmentationEvents.triggerSegmentationDataModified(s.segId, [s.seedZ], s.segIndex);
  } catch {
    /* ignore */
  }

  updateLevelSetSession({ status: "done", reachedCount, iterations, lastChange });
}

/** 現在の Level Sets 結果を確定（永続化）してセッションを閉じる。 */
export function commitLevelSet(): void {
  tracked = null;
  clearLevelSetSession();
}

/** 現在の Level Sets 結果を取り消して（元値へ復元）セッションを閉じる。 */
export function cancelLevelSet(): void {
  const s = getLevelSetSession();
  if (s) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labelmapIds = (csSeg as any).getLabelmapImageIds?.(s.segId) as string[] | undefined;
    if (labelmapIds?.length) {
      const vm = labelmapVmAt(labelmapIds, s.seedZ);
      restoreTracked(vm);
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (csSeg as any).triggerSegmentationEvents.triggerSegmentationDataModified(s.segId, [s.seedZ], s.segIndex);
      } catch {
        /* ignore */
      }
    }
  }
  tracked = null;
  clearLevelSetSession();
}

/** クリック位置（world）からシードを決めてセッションを開始（or 再シード）し、初回実行する。 */
async function startLevelSet(viewport: AnyObj, world: [number, number, number]): Promise<void> {
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

  // シードスライスの輝度 min/max（Wand と同じ発想、wandTool.ts の rangeMin/rangeMax）。
  // Fiji の既定値（Grey value threshold=50, Grayscale tolerance=30）は 8bit(0-255) 画像を前提にした値で、
  // CT の HU 等はるかに広いダイナミックレンジの DICOM ではほぼ機能しない（最初の1歩すら踏み出せず
  // 膨張しない）ため、既定値のみ実データのレンジに比例させてスケールする（ユーザーが値を変更した後は
  // そのセッションの値をそのまま使う。§7 に記録）。
  let rangeMin = seedValue;
  let rangeMax = seedValue;
  for (let i = 0; i < cols * rows; i++) {
    const v = px[i];
    if (v < rangeMin) rangeMin = v;
    if (v > rangeMax) rangeMax = v;
  }
  const dynRange = Math.max(1, rangeMax - rangeMin);

  const prev = getLevelSetSession();
  const fastMarching = prev
    ? prev.fastMarching
    : {
        ...DEFAULT_FAST_MARCHING,
        greyValueThreshold: Math.max(1, Math.round(dynRange * (50 / 255))),
        // Fiji の既定 0.5 は「1反復あたりの凍結率」という別の意味の値で、本実装の
        // 「シードからの最大到達コスト距離」（1 歩あたり最小コスト ≈1）にそのまま使うと
        // 最初の1歩すら許可されず全く拡張できない。スライス対角線長を安全側の既定値にする。
        distanceThreshold: Math.max(50, Math.round(Math.hypot(cols, rows))),
      };
  const activeContours = prev
    ? prev.activeContours
    : { ...DEFAULT_ACTIVE_CONTOURS, grayscaleTolerance: Math.max(1, Math.round(dynRange * (30 / 255))) };

  // Fast Marching 無効時のみ、開始時点の既存マスクをスナップショットとして固定する（§ヘッダコメント）。
  let initMaskSnapshot: Uint8Array | undefined;
  if (!fastMarching.enabled) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labelmapIds = (csSeg as any).getLabelmapImageIds?.(target.segmentationId) as string[] | undefined;
    const vm = labelmapIds?.length ? labelmapVmAt(labelmapIds, seedZ) : null;
    if (vm) initMaskSnapshot = readActiveSegmentMask(vm, cols, rows, target.segmentIndex || 1);
  }

  const session: LevelSetSession = {
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
    fastMarching,
    activeContours,
    status: "running",
    reachedCount: 0,
    initMaskSnapshot,
  };
  // 再シード時は前回結果を消してから新シードで実行（tracked は runLevelSet が復元）。
  openLevelSetSession(session);
  await runLevelSet(session);
}

export class LevelSetTool extends BaseTool {
  static toolName = "GraphyLevelSet";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(props: AnyObj = {}) {
    super(props, {
      supportedInteractionTypes: ["Mouse"],
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async preMouseDownCallback(evt: AnyObj): Promise<boolean> {
    const { element, currentPoints } = evt.detail;
    const world = currentPoints.world as [number, number, number];
    try {
      const { viewport } = getEnabledElement(element) as AnyObj;
      await startLevelSet(viewport, world);
    } catch (e) {
      console.warn("[levelSet] failed", e);
    }
    return true; // クリック確定でイベント消費。
  }
}
