/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { synchronizers, SynchronizerManager } from "@cornerstonejs/tools";

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
 * シリーズ Sync 用: ViewPresentation（zoom/pan/rotation/flip を**相対**で）同期。
 * camera 同期（絶対 parallelScale/focalPoint）と違い、サイズ/FOV の異なるシリーズ間でも
 * 「Fit=1.0」基準の相対倍率で破綻なく連動する。
 */
export function getOrCreatePresentationSync(id: string) {
  return SynchronizerManager.getSynchronizer(id) ?? synchronizers.createPresentationViewSynchronizer(id);
}

/**
 * シリーズ Sync 用 VOI 同期: W/L に加え **Invert・カラーマップ(LUT)** も連動させる。
 * GridView 用 {@link getOrCreateVoiSync}（colormap 非同期）とは別 ID で使う。
 */
export function getOrCreateSeriesVoiSync(id: string) {
  return (
    SynchronizerManager.getSynchronizer(id) ??
    synchronizers.createVOISynchronizer(id, { syncInvertState: true, syncColormap: true })
  );
}
