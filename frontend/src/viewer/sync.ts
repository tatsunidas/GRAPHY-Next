/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { synchronizers, SynchronizerManager } from "@cornerstonejs/tools";
import { getRenderingEngine, Enums, type Types } from "@cornerstonejs/core";
import { applyTransform, readTransform } from "./transform";

/**
 * GridView リンク用の同期。camera（pan/zoom/rotate/flip）と VOI（W/L）を、
 * 同一グループに add した全ビューポート間で同期する。重複生成は getSynchronizer で回避。
 */
export function getOrCreateCameraSync(id: string) {
  return SynchronizerManager.getSynchronizer(id) ?? synchronizers.createCameraPositionSynchronizer(id);
}

export function getOrCreateVoiSync(id: string) {
  return (
    SynchronizerManager.getSynchronizer(id) ??
    synchronizers.createVOISynchronizer(id, { syncInvertState: true, syncColormap: false })
  );
}

/**
 * シリーズ Sync 用: zoom/pan/rotation/flip を**相対**（Fit=1.0 基準）で同期する。
 *
 * <p>Cornerstone の `createPresentationViewSynchronizer` は使わない。当該 factory は options を
 * `{viewPresentation: …}` でラップして callback に渡すが、callback はそれをそのまま
 * `getViewPresentation(selector)` の selector として使うため、rotation/zoom/pan… の各フラグが
 * 未定義になり**空の presentation**しか返らず同期が効かない（W/L は別の VOI 同期なので効く）。
 * そこで CAMERA_MODIFIED で発火する自前 synchronizer を作り、source の {@link readTransform} を
 * target へ {@link applyTransform}（flip は setCamera で双方向）で適用する。
 */
function presentationSyncCallback(
  _sync: unknown,
  source: Types.IViewportId,
  target: Types.IViewportId,
): void {
  const tgt = getRenderingEngine(target.renderingEngineId)
    ?.getViewport(target.viewportId) as Types.IStackViewport | undefined;
  const src = getRenderingEngine(source.renderingEngineId)
    ?.getViewport(source.viewportId) as Types.IStackViewport | undefined;
  if (!tgt || !src) return;
  try {
    applyTransform(tgt, readTransform(src));
  } catch {
    /* 破棄途中などは無視 */
  }
}

export function getOrCreatePresentationSync(id: string) {
  return (
    SynchronizerManager.getSynchronizer(id) ??
    SynchronizerManager.createSynchronizer(id, Enums.Events.CAMERA_MODIFIED, presentationSyncCallback)
  );
}

/** シリーズ Sync 用 VOI synchronizer の固定 ID。 */
export const SERIES_VOI_SYNC_ID = "graphy-series:voi";

// ── W/L 相対同期（基準値＋変化量） ────────────────────────────────
//
// グローバルに同一 W/L を適用するのではなく、**Sync 参加時点の各シリーズの W/L を基準(baseline)**とし、
// source の baseline からの変化量(ΔWC/ΔWW)を各 target の baseline に加算する。
// これにより modality/コントラストの異なるシリーズ間でも、各自の見え方を保ったまま連動する。

const voiBaseline = new Map<string, { wc: number; ww: number }>();

function vpById(v: Types.IViewportId): Types.IStackViewport | undefined {
  return getRenderingEngine(v.renderingEngineId)?.getViewport(v.viewportId) as Types.IStackViewport | undefined;
}

function readVoi(vp: Types.IStackViewport): { wc: number; ww: number } | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = (vp.getProperties() as any)?.voiRange;
  if (!r || !Number.isFinite(r.lower) || !Number.isFinite(r.upper)) return null;
  return { wc: (r.lower + r.upper) / 2, ww: r.upper - r.lower };
}

/** Sync 参加時に現在の W/L を基準値として記録する。 */
export function captureVoiBaseline(viewportId: string, vp: Types.IStackViewport): void {
  const v = readVoi(vp);
  if (v) voiBaseline.set(viewportId, v);
}

/** Sync 離脱時に基準値を破棄する。 */
export function clearVoiBaseline(viewportId: string): void {
  voiBaseline.delete(viewportId);
}

/** source の baseline からの ΔWC/ΔWW を、target の baseline に加算して適用する。 */
function relativeVoiSyncCallback(_s: unknown, source: Types.IViewportId, target: Types.IViewportId): void {
  const sVp = vpById(source);
  const tVp = vpById(target);
  if (!sVp || !tVp) return;
  const sCur = readVoi(sVp);
  if (!sCur) return;
  let sBase = voiBaseline.get(source.viewportId);
  if (!sBase) {
    sBase = sCur;
    voiBaseline.set(source.viewportId, sBase);
  }
  const dWC = sCur.wc - sBase.wc;
  const dWW = sCur.ww - sBase.ww;
  let tBase = voiBaseline.get(target.viewportId);
  if (!tBase) {
    const tCur = readVoi(tVp);
    if (!tCur) return;
    tBase = tCur;
    voiBaseline.set(target.viewportId, tBase);
  }
  const wc = tBase.wc + dWC;
  const ww = Math.max(1, tBase.ww + dWW);
  try {
    tVp.setProperties({ voiRange: { lower: wc - ww / 2, upper: wc + ww / 2 } });
    tVp.render();
  } catch {
    /* 破棄途中などは無視 */
  }
}

/**
 * シリーズ Sync 用 VOI（W/L）同期: **相対**（baseline からの変化量のみ）で連動する。
 * Cornerstone の createVOISynchronizer は絶対値コピーのため使わず、自前 callback を用いる。
 * Invert/LUT は本 synchronizer の参加集合を使った {@link broadcastSeriesProperties} で別途同期。
 */
export function getOrCreateSeriesVoiSync(id: string) {
  return (
    SynchronizerManager.getSynchronizer(id) ??
    SynchronizerManager.createSynchronizer(id, Enums.Events.VOI_MODIFIED, relativeVoiSyncCallback)
  );
}

/**
 * 同期中（{@link SERIES_VOI_SYNC_ID} に参加）の他ビューポートへ invert/colormap を**直接適用**する。
 *
 * <p>StackViewport は VOI_MODIFIED の detail に invert/colormap を載せない（W/L=voiRange のみ）。
 * そのため VOI synchronizer の syncInvertState/syncColormap は stack では発火せず同期されない。
 * これを補うため、source の invert/LUT 変更時に同期相手へ直接 setProperties する。
 */
export function broadcastSeriesProperties(
  sourceViewportId: string,
  props: { invert?: boolean; colormap?: { name: string } },
): void {
  const voi = SynchronizerManager.getSynchronizer(SERIES_VOI_SYNC_ID);
  if (!voi) {
    return;
  }
  for (const t of voi.getTargetViewports()) {
    if (t.viewportId === sourceViewportId) {
      continue;
    }
    const vp = getRenderingEngine(t.renderingEngineId)
      ?.getViewport(t.viewportId) as Types.IStackViewport | undefined;
    if (!vp) {
      continue;
    }
    try {
      vp.setProperties(props);
      vp.render();
    } catch {
      /* 破棄途中などは無視 */
    }
  }
}
