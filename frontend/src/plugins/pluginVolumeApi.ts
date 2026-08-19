/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * プラグイン host API のボリューム層（H10）と位置合わせ（H21）。
 *
 * <p><b>新規に計算を書いていない。</b> どちらも本体に検証済みの実装があり、ここは
 * **公開の口**である:
 *
 * <ul>
 *   <li>H10 … {@link loadRegVolume}（シリーズ丸ごと → 校正済み値 ＋ 患者 LPS の幾何）</li>
 *   <li>H21 … {@link runRigidInWorker}（剛体・非剛体を Worker で実行）＋ {@link registrationToTransform}</li>
 *   <li>リサンプル … {@link sampleWorld}（RegVolume の world サンプラ）</li>
 * </ul>
 *
 * <p>プラグインに計算を書かせない理由は設計と同じで、**位置合わせの答えが 2 つになる**のを避けるため
 * （`fw/registration-design.md` / `fw/cornerstone-3d-geometry-caveat.md`）。
 */
import { fetchInstances } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import { imageIdForInstance } from "../viewer/imageId";
import { imageLoader, metaData } from "@cornerstonejs/core";
import { getModalityCalibration } from "../viewer/pixelCalibration";
import { estimateRegVolume, loadRegVolume, type VolumeEstimate } from "../viewer/regVolumeLoader";
import { runRigidInWorker, toPayload } from "../viewer/regWorkerClient";
import { registrationToTransform, type RegistrationResult } from "../viewer/regResult";
import type { MetricKind } from "../viewer/regMetrics";
import type {
  PluginRegistrationRequest,
  PluginRegistrationResult,
  PluginSeriesRef,
  PluginVolume,
} from "./pluginTypes";

/** シリーズ参照から studyUid を解決する（開いているタイルから引く）。 */
export type StudyResolver = (seriesUid: string) => string | undefined;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;

function resolveStudy(ref: PluginSeriesRef, resolver: StudyResolver): string | null {
  const uid = ref.studyUid ?? resolver(ref.seriesUid);
  return uid ?? null;
}

/**
 * H10: シリーズ 1 本をボリュームとして読む。
 *
 * <p>★ **1 回 1 ボリューム**（H3 で「1 回 1 スライス」にしたのと同じ理由: まとめて返す API は
 * 呼び出し側にメモリの見積りをさせない）。読み込み前に {@link estimatePluginVolume} で
 * 大きさを聞けるようにしてある。
 */
export async function loadPluginVolume(
  mode: ViewerMode,
  resolver: StudyResolver,
  ref: PluginSeriesRef,
  onProgress?: (loaded: number, total: number) => void,
): Promise<PluginVolume | null> {
  const studyUid = resolveStudy(ref, resolver);
  if (!studyUid) return null;
  const instances = await fetchInstances(studyUid, ref.seriesUid);
  if (!instances.length) return null;
  const loaded = await loadRegVolume(
    mode,
    studyUid,
    ref.seriesUid,
    instances,
    ref.c ?? 0,
    ref.t ?? 0,
    onProgress,
  );
  if (!loaded) return null;

  // 単位とスライス厚は「読んだ 1 枚目」から取る（`loadRegVolume` は幾何しか返さない）。
  // 画像は直前の読み込みでキャッシュ済みなので、ここでの取得は実質ゼロコスト。
  let unit = "";
  let sliceThickness: number | null = null;
  const firstId = imageIdForInstance(mode, instances[0].sopInstanceUid, studyUid, ref.seriesUid);
  try {
    const img = await imageLoader.loadAndCacheImage(firstId);
    unit = getModalityCalibration(img, firstId).unit ?? "";
    const plane = metaData.get("imagePlaneModule", firstId) as AnyObj | undefined;
    const st = plane?.sliceThickness;
    sliceThickness = typeof st === "number" && Number.isFinite(st) ? st : null;
  } catch {
    /* 単位が取れなくてもボリュームは返す（**捏造はしない**＝空文字のまま） */
  }

  const v = loaded.volume;
  return {
    data: v.data,
    dims: [v.dims[0], v.dims[1], v.dims[2]],
    spacing: [v.spacing[0], v.spacing[1], v.spacing[2]],
    indexToWorld: Array.from(v.indexToWorld),
    worldToIndex: Array.from(v.worldToIndex),
    ipp: [loaded.volume.indexToWorld[3], loaded.volume.indexToWorld[7], loaded.volume.indexToWorld[11]],
    iop: [...loaded.iop],
    sliceStep: [loaded.sliceStep[0], loaded.sliceStep[1], loaded.sliceStep[2]],
    frameOfReferenceUid: loaded.frameOfReferenceUid || null,
    modality: loaded.modality,
    unit,
    sliceThickness,
    seriesUid: ref.seriesUid,
    studyUid,
  };
}

/** H10: 読み込み前の大きさの見積り（**先に聞けるようにする**）。 */
export async function estimatePluginVolume(
  mode: ViewerMode,
  resolver: StudyResolver,
  ref: PluginSeriesRef,
): Promise<VolumeEstimate | null> {
  const studyUid = resolveStudy(ref, resolver);
  if (!studyUid) return null;
  const instances = await fetchInstances(studyUid, ref.seriesUid);
  if (!instances.length) return null;
  return estimateRegVolume(mode, studyUid, ref.seriesUid, instances, ref.c ?? 0, ref.t ?? 0);
}

/** 指標名の検証（本体が知っている語彙だけ通す。未知なら既定に任せる）。 */
function toMetricKind(v: string | undefined): MetricKind | undefined {
  return v === "mi" || v === "nmi" || v === "ncc" || v === "lncc" ? v : undefined;
}

/**
 * H21: 位置合わせを実行する（剛体 / 非剛体 / 両方）。
 *
 * <p>★ **プラグインが持っているボリュームは受け取らない。** Worker へは画素バッファを
 * *転送*する（コピーしない）ので、渡した側の配列は detach されて壊れる。事故を仕様で防ぐため、
 * ここでは**シリーズ参照だけ**を受け取り、本体が読み直したボリュームを渡す。
 */
export async function registerPluginVolumes(
  mode: ViewerMode,
  resolver: StudyResolver,
  req: PluginRegistrationRequest,
  onProgress?: (fraction: number, stage: string) => void,
): Promise<PluginRegistrationResult | null> {
  const studyFixed = resolveStudy(req.fixed, resolver);
  const studyMoving = resolveStudy(req.moving, resolver);
  if (!studyFixed || !studyMoving) return null;

  const [fixedInst, movingInst] = await Promise.all([
    fetchInstances(studyFixed, req.fixed.seriesUid),
    fetchInstances(studyMoving, req.moving.seriesUid),
  ]);
  const [fixed, moving] = await Promise.all([
    loadRegVolume(mode, studyFixed, req.fixed.seriesUid, fixedInst, req.fixed.c ?? 0, req.fixed.t ?? 0),
    loadRegVolume(mode, studyMoving, req.moving.seriesUid, movingInst, req.moving.c ?? 0, req.moving.t ?? 0),
  ]);
  if (!fixed || !moving) return null;

  const sameFor =
    !!fixed.frameOfReferenceUid && fixed.frameOfReferenceUid === moving.frameOfReferenceUid;
  const handle = runRigidInWorker(
    {
      mode: req.mode ?? "rigid",
      fixed: toPayload(fixed.volume, fixed.iop, fixed.sliceStep),
      moving: toPayload(moving.volume, moving.iop, moving.sliceStep),
      sameModality: fixed.modality === moving.modality,
      sameFrameOfReference: sameFor,
      ...(req.options ?? {}),
      // 指標名は本体の語彙に限る（未知の文字列を渡させない）。
      metric: toMetricKind(req.options?.metric),
    },
    (p) => onProgress?.(p.fraction, `L${p.level + 1}/${p.levelCount} it=${p.iteration}`),
  );
  const done = await handle.promise;

  const result: RegistrationResult = {
    matrix: done.matrix,
    center: done.center,
    translationMm: done.translationMm,
    eulerDeg: done.eulerDeg,
    metric: done.metric,
    metricValue: done.metricValue,
    elapsedMs: done.elapsedMs,
    sameFrameOfReference: sameFor,
    initialization: done.initialization,
    dvf: done.dvf
      ? {
          displacements: done.dvf.displacements,
          dims: done.dvf.dims,
          origin: done.dvf.origin,
          spacing: done.dvf.spacing,
          jacobian: done.dvf.jacobian,
          maxDisplacementMm: done.dvf.maxDisplacementMm,
        }
      : null,
    mode: req.mode ?? "rigid",
  };
  const transform = registrationToTransform(result);
  return {
    matrix: done.matrix,
    center: done.center,
    translationMm: done.translationMm,
    eulerDeg: done.eulerDeg,
    metric: done.metric,
    metricValue: done.metricValue,
    elapsedMs: done.elapsedMs,
    aborted: done.aborted,
    hasDeformation: !!done.dvf,
    maxDisplacementMm: done.dvf?.maxDisplacementMm ?? 0,
    /** 内部表現（プラグインは中身を見ない。`resampleVolume` にそのまま渡す）。 */
    transform: transform as unknown,
  };
}
