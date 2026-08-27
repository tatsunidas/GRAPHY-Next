/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * ROI 統計のキャッシュと再計算（`fw/roi-stats-design.md` §4.5・§4.6）。
 *
 * <h3>描画ループで計算しない</h3>
 * Cornerstone の `configuration.getTextLines(data, targetId)` は**フレームごとに呼ばれる**。
 * そこで画素を舐めると重い。計算はイベント契機でデバウンスして行い、`getTextLines` は
 * **ここを同期で読むだけ**にする。計算が終わったら `triggerAnnotationRenderForViewportIds()` で
 * 描き直す（画像の `viewport.render()` は注釈を描き直さない——`fw/roi-manager-design.md` §11.8）。
 *
 * <h3>2 本立てのキャッシュ</h3>
 * 🔴 `getTextLines` には **annotationUID が渡ってこない**（引数は `annotation.data` と `targetId`
 * だけ）。そこで描画経路用に {@code WeakMap<data, 結果>}、ダイアログ経路用に
 * {@code Map<uid, 結果>} を持つ。`annotation.data` に独自フィールドを生やす案は採らない
 * ——`roiPersistence` / `imagejExport` / `rtstructExport` が `data` を読む層なので、
 * 余計な項目を混ぜると保存形が汚れる。
 *
 * <h3>校正が変わったら捨てる</h3>
 * `roiPersistence.ts` の「古い統計を持ち回ると、校正が変わった場合に嘘の値が残る」と同じ方針。
 * 署名（{@link signatureOf}）に**校正エポック**を混ぜてあるので、SUV 校正や XA 空間校正を
 * 変えると全 ROI が自動的に stale になる。
 */
import {
  eventTarget,
  getRenderingEngines,
  metaData,
  utilities as csCoreUtilities,
} from "@cornerstonejs/core";
import { annotation as csAnnotation, Enums as csToolsEnums } from "@cornerstonejs/tools";
import { triggerAnnotationRenderForViewportIds } from "@cornerstonejs/tools/utilities";
import {
  readModalitySlice,
  readModalitySliceSync,
  resolveValueUnit,
  type ModalitySlice,
} from "./pixelCalibration";
import { roiPointsPx, type PointPx } from "./roiRead";
import { computeRoiStatsFrom, type RoiStatsResult } from "./roiStats";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

interface Entry {
  result: RoiStatsResult;
  signature: string;
}

const byUid = new Map<string, Entry>();
const byData = new WeakMap<object, Entry>();
const listeners = new Set<() => void>();

/** 校正（SUV / 空間）の世代。上げると全 ROI の署名が変わり、再計算される。 */
let calibrationEpoch = 0;

/** 1 回の掃除で計算する上限。ドラッグ中に 100 本ぶん回して固まらせない。 */
const MAX_PER_SWEEP = 32;
const DEBOUNCE_MS = 100;

// ───────────────────────── 読み出し ─────────────────────────

/** `getTextLines` からの同期読み出し（`annotation.data` をキーにする）。 */
export function getRoiStatsByData(data: unknown): RoiStatsResult | undefined {
  if (!data || typeof data !== "object") return undefined;
  return byData.get(data as object)?.result;
}

/** ダイアログ・一覧からの読み出し。 */
export function getRoiStats(uid: string): RoiStatsResult | undefined {
  return byUid.get(uid)?.result;
}

export function subscribeRoiStats(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of Array.from(listeners)) {
    try {
      fn();
    } catch {
      /* 1 つの購読者の失敗で他を巻き込まない */
    }
  }
}

// ───────────────────────── 入力の解決 ─────────────────────────

interface Resolved {
  tool: string;
  refImageId: string;
  pointsPx: PointPx[];
  closed?: boolean;
  spacingX: number | null;
  spacingY: number | null;
  unit: string;
}

/** annotation → 統計エンジンの入力（画素以外）。Cornerstone に触る層はここだけ。 */
function resolveInputs(ann: Any): Resolved | null {
  const tool = (ann?.metadata?.toolName as string) ?? "";
  const refImageId = ann?.metadata?.referencedImageId as string | undefined;
  if (!tool || !refImageId) return null;
  const world = (ann?.data?.contour?.polyline ?? ann?.data?.handles?.points ?? []) as number[][];
  if (!world.length) return null;

  const plane = metaData.get("imagePlaneModule", refImageId) as Any;
  const spacingX = numOrNull(plane?.columnPixelSpacing);
  const spacingY = numOrNull(plane?.rowPixelSpacing);
  // 幾何(IPP/IOP)が無いシリーズ（XA）でも頂点を失わない換算は roiRead に集約してある。
  const pointsPx = roiPointsPx(
    world,
    (w) => csCoreUtilities.worldToImageCoords(refImageId, w as [number, number, number]) as PointPx,
    spacingX,
    spacingY,
  );
  if (!pointsPx.length) return null;

  return {
    tool,
    refImageId,
    pointsPx,
    closed: ann?.data?.contour?.closed as boolean | undefined,
    spacingX,
    spacingY,
    unit: resolveValueUnit(refImageId),
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * 再計算が要るかを判定するための署名。
 *
 * <p>Cornerstone の `annotation.invalidated` は**使えない**——各ツールが自前の統計計算のあとで
 * `false` に戻すので、こちらが見る前に消えている。頂点そのものから作る方が確実で、
 * 「どの経路で編集されたか」を数え上げなくて済む（削除・undo・プラグイン経由も同じ扱いになる）。
 */
function signatureOf(r: Resolved): string {
  let sum = 0;
  for (const p of r.pointsPx) sum = (sum + p[0] * 31.7 + p[1] * 71.3) % 1e12;
  return `${r.tool}|${r.refImageId}|${r.closed}|${r.pointsPx.length}|${sum.toFixed(4)}|${r.unit}|${calibrationEpoch}`;
}

function store(uid: string, data: object | undefined, entry: Entry): void {
  byUid.set(uid, entry);
  if (data) byData.set(data, entry);
}

// ───────────────────────── 計算 ─────────────────────────

interface Detail {
  withProfile?: boolean;
  withHistogram?: boolean;
}

function computeWithSlice(
  uid: string,
  ann: Any,
  r: Resolved,
  slice: ModalitySlice | null,
  detail: Detail,
): RoiStatsResult {
  const result = computeRoiStatsFrom({
    roiUid: uid,
    tool: r.tool,
    imageId: r.refImageId,
    pointsPx: r.pointsPx,
    closed: r.closed,
    slice,
    unit: r.unit,
    spacingX: r.spacingX,
    spacingY: r.spacingY,
    withProfile: !!detail.withProfile,
    withHistogram: !!detail.withHistogram,
  });
  store(uid, ann?.data, { result, signature: signatureOf(r) });
  return result;
}

/**
 * いますぐ計算して返す（**同期**）。キャッシュが新しければそれを返す。
 *
 * <p>画素はキャッシュに載っているものだけを読む（{@link readModalitySliceSync}）。
 * プラグイン host API の H5 `getRois()` が同期契約なのでこの口が要る。
 * 表示中のスライスは必ずキャッシュに載っているため実用上はこれで足りる。
 * <b>載っていなければ統計を出さない</b>（Cornerstone の `cachedStats` で埋めない
 * ——単位系が黙って混ざる方が有害）。
 */
export function computeRoiStatsNow(uid: string, opts?: Detail & { force?: boolean }): RoiStatsResult | undefined {
  const ann = getAnnotation(uid);
  if (!ann) return undefined;
  const r = resolveInputs(ann);
  if (!r) return undefined;
  const hit = byUid.get(uid);
  if (!opts?.force && hit?.signature === signatureOf(r) && detailSatisfied(hit.result, opts)) {
    return hit.result;
  }
  return computeWithSlice(uid, ann, r, readModalitySliceSync(r.refImageId), opts ?? {});
}

/** キャッシュ済みの結果が、求められた詳細（プロファイル・ヒストグラム）を満たしているか。 */
function detailSatisfied(result: RoiStatsResult, opts: Detail | undefined): boolean {
  if (opts?.withProfile && !result.profile && result.geometry.kind === "line") return false;
  if (opts?.withHistogram && !result.histogram && result.values) return false;
  return true;
}

/** いますぐ計算して返す（**非同期**・画素が未ロードなら読み込む）。ダイアログ用。 */
export async function computeRoiStatsAsync(
  uid: string,
  opts?: Detail & { force?: boolean },
): Promise<RoiStatsResult | undefined> {
  const ann = getAnnotation(uid);
  if (!ann) return undefined;
  const r = resolveInputs(ann);
  if (!r) return undefined;
  const hit = byUid.get(uid);
  if (!opts?.force && hit?.signature === signatureOf(r) && detailSatisfied(hit.result, opts)) {
    return hit.result;
  }
  const slice = await readModalitySlice(r.refImageId);
  return computeWithSlice(uid, ann, r, slice, opts ?? {});
}

function getAnnotation(uid: string): Any {
  try {
    return (csAnnotation.state as Any).getAnnotation(uid);
  } catch {
    return null;
  }
}

function allAnnotations(): Any[] {
  try {
    const st = (csAnnotation.state as Any).getAllAnnotations?.();
    return Array.isArray(st) ? st : [];
  } catch {
    return [];
  }
}

/** いまどこかのビューポートに表示されている imageId（掃除の優先順位に使う）。 */
function displayedImageIds(): Set<string> {
  const out = new Set<string>();
  for (const engine of getRenderingEngines() ?? []) {
    for (const vp of engine?.getViewports() ?? []) {
      try {
        const id = (vp as Any).getCurrentImageId?.() as string | undefined;
        if (id) out.add(id);
      } catch {
        /* ボリュームビューポート等は持たない */
      }
    }
  }
  return out;
}

// ───────────────────────── 掃除（デバウンス） ─────────────────────────

let timer: number | null = null;
let running = false;

/**
 * stale な ROI をまとめて計算し直す。デバウンス付き。
 *
 * <p>`getTextLines` がキャッシュを外したときにも呼ばれる。**必ず結果を書き込む**
 * （計算できなかった場合も `warnings` 付きで書く）ので、
 * 「毎フレーム外して毎フレーム掃除を予約する」ループにはならない。
 */
export function scheduleRoiStatsSweep(): void {
  if (timer !== null) return;
  timer = window.setTimeout(() => {
    timer = null;
    void sweep();
  }, DEBOUNCE_MS);
}

async function sweep(): Promise<void> {
  if (running) {
    scheduleRoiStatsSweep();
    return;
  }
  running = true;
  try {
    const shown = displayedImageIds();
    const stale: { uid: string; ann: Any; r: Resolved; sig: string; shown: boolean }[] = [];
    for (const ann of allAnnotations()) {
      const uid = ann?.annotationUID as string | undefined;
      if (!uid) continue;
      const r = resolveInputs(ann);
      if (!r) continue;
      const sig = signatureOf(r);
      if (byUid.get(uid)?.signature === sig) continue;
      stale.push({ uid, ann, r, sig, shown: shown.has(r.refImageId) });
    }
    if (!stale.length) return;
    // 見えているスライスの ROI から先に片付ける（画面の反応を優先）。
    stale.sort((a, b) => Number(b.shown) - Number(a.shown));
    const batch = stale.slice(0, MAX_PER_SWEEP);
    for (const s of batch) {
      const slice = (await readModalitySlice(s.r.refImageId)) ?? null;
      // 待っているあいだに消された ROI は書かない（消えた ROI の統計が残る）。
      if (!getAnnotation(s.uid)) continue;
      computeWithSlice(s.uid, s.ann, s.r, slice, {});
    }
    if (stale.length > batch.length) scheduleRoiStatsSweep();
    renderAnnotations();
    notify();
  } finally {
    running = false;
  }
}

/** 注釈だけを描き直す（画像の render は注釈を更新しない）。 */
function renderAnnotations(): void {
  const ids: string[] = [];
  for (const engine of getRenderingEngines() ?? []) {
    for (const vp of engine?.getViewports() ?? []) ids.push(vp.id);
  }
  if (!ids.length) return;
  try {
    triggerAnnotationRenderForViewportIds(ids);
  } catch {
    /* ビューポート未準備 */
  }
}

// ───────────────────────── 無効化・購読 ─────────────────────────

/**
 * 校正が変わったので全部捨てる（SUV 校正・XA 空間校正の変更）。
 * 署名にエポックが入っているので、実際の破棄は次の掃除で行われる。
 */
export function invalidateAllRoiStats(): void {
  calibrationEpoch++;
  scheduleRoiStatsSweep();
}

/** ROI が消えたらキャッシュからも消す（`byData` は WeakMap なので放置でよい）。 */
export function forgetRoiStats(uid: string): void {
  byUid.delete(uid);
}

let installed = false;

/**
 * Cornerstone のイベントに繋ぐ（アプリ起動時に 1 度）。
 *
 * <p>⚠ **`removeAllAnnotations()` は個々の `ANNOTATION_REMOVED` を発火しない**
 * （`fw/roi-manager-design.md` §11.5' で踏んだのと同じ罠）。ここでは削除の取りこぼしが
 * あっても「消えた ROI の統計が `byUid` に残る」だけで、表示は annotation を起点に引くので
 * 実害が無い。掃除のたびに参照されなくなった entry は次の全消去で落ちる。
 */
export function installRoiStatsWatcher(): () => void {
  if (installed) return () => undefined;
  installed = true;
  const onChanged = () => scheduleRoiStatsSweep();
  const onRemoved = (evt: Any) => {
    const uid = evt?.detail?.annotation?.annotationUID as string | undefined;
    if (uid) forgetRoiStats(uid);
  };
  const E = csToolsEnums.Events;
  eventTarget.addEventListener(E.ANNOTATION_ADDED, onChanged);
  eventTarget.addEventListener(E.ANNOTATION_MODIFIED, onChanged);
  eventTarget.addEventListener(E.ANNOTATION_COMPLETED, onChanged);
  eventTarget.addEventListener(E.ANNOTATION_REMOVED, onRemoved);
  return () => {
    eventTarget.removeEventListener(E.ANNOTATION_ADDED, onChanged);
    eventTarget.removeEventListener(E.ANNOTATION_MODIFIED, onChanged);
    eventTarget.removeEventListener(E.ANNOTATION_COMPLETED, onChanged);
    eventTarget.removeEventListener(E.ANNOTATION_REMOVED, onRemoved);
    installed = false;
  };
}

/** 診断用: キャッシュ件数（automator の検証で「計算が走ったか」を見る）。 */
export function roiStatsCacheSize(): number {
  return byUid.size;
}
