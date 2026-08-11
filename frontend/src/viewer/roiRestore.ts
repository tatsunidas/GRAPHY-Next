/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 保存済み ROI を表示中スタックへ復元し、いまある ROI を保存形へ集める（Cornerstone に触る層）。
 *
 * <p>純関数側は {@link ./roiPersistence}、保存の段取りは {@link ./roiSaveStore}。
 * ここは「Cornerstone の annotation state を読む／書く」だけを担う薄い層で、
 * 判断（何を保存するか・何を復元するか）は極力純関数側に置いてある。
 */
import { getRenderingEngines, metaData } from "@cornerstonejs/core";
import { annotation as csAnnotation } from "@cornerstonejs/tools";
import { log } from "../log";
import { sopFromImageId } from "./imageId";
import { getRoiMaskMeta, setRoiMaskMeta } from "./roiMaskStore";
import { ensureSplineInstance } from "./roiContourTools";
import {
  buildAnnotationData,
  buildRestoredMeta,
  selectRestorable,
  toSavedRoi,
  type AnnotationLike,
  type SavedRoi,
} from "./roiPersistence";

/**
 * imageId → SOP Instance UID（`segExport` / `maskFrames` と同じ解決）。
 * 同じ imageId を何度も引くのでメモ化する（保存のたびに全スライス分を引くため）。
 */
const sopCache = new Map<string, string | null>();

export function sopOfImageId(imageId: string): string | null {
  const hit = sopCache.get(imageId);
  if (hit !== undefined) return hit;
  let sop: string | null = null;
  try {
    const sc = metaData.get("sopCommonModule", imageId) as { sopInstanceUID?: string } | undefined;
    sop = sc?.sopInstanceUID ?? null;
  } catch {
    sop = null;
  }
  // メタデータは**その画像を読み込んだ後**にしか無い。復元はスタック確定時に 1 度だけ走るので、
  // これだけだと表示中の 1 枚しか対応表に載らず、他スライスの ROI が永久に戻らない
  // （実データで発覚。9 スライスに描いた ROI のうち 0 件しか復元されなかった）。
  // imageId は自前で組み立てているため、URL から SOP を取り出せる。
  if (!sop) sop = sopFromImageId(imageId);
  // 解決できた時だけ覚える（メタ未読の段階の null を固定化しないため）。
  if (sop) sopCache.set(imageId, sop);
  return sop;
}

/**
 * いま**どこかのビューポートに読み込まれている**スタックの SOP 集合。
 *
 * <p>「ユーザーがその ROI を削除し得たか」の判定に使う。表示されていないシリーズの ROI は
 * annotation state に無いのが正常なので、削除と区別しなければならない。
 */
export function openStackSops(): Set<string> {
  const out = new Set<string>();
  for (const engine of getRenderingEngines() ?? []) {
    for (const vp of engine?.getViewports() ?? []) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ids = (vp as any).getImageIds?.() as string[] | undefined;
      for (const id of ids ?? []) {
        const sop = sopOfImageId(id);
        if (sop) out.add(sop);
      }
    }
  }
  return out;
}

/** スタックの imageId 群から SOP → imageId の対応表を作る。 */
export function sopIndex(imageIds: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of imageIds) {
    const sop = sopOfImageId(id);
    // 同じ SOP が複数 imageId に現れることは通常無いが、先勝ちにする（合成 imageId 対策）。
    if (sop && !map.has(sop)) map.set(sop, id);
  }
  return map;
}

/**
 * いまある ROI を保存形へ集める（`roiSaveStore` の収集関数として渡す）。
 *
 * <p>対象は**この患者に属する ROI**。作成時にメタが付いていない ROI（＝患者未紐付け）も含める
 * ——`RoiManagerPanel` の表示規則（`!pk || pk === activePatientKey`）と揃えてある。
 * 揃えないと「マネージャには出るのに保存されない」ROI が生まれる。
 */
export function collectRoisForPatient(patientKey: string, loaded: SavedRoi[] = []): SavedRoi[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let all: any[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    all = csAnnotation.state.getAllAnnotations() as any[];
  } catch {
    return [];
  }
  const out: SavedRoi[] = [];
  for (const a of all) {
    const uid = a?.annotationUID as string | undefined;
    if (!uid) continue;
    const meta = getRoiMaskMeta(uid);
    if (meta?.patientKey && meta.patientKey !== patientKey) continue;
    const saved = toSavedRoi(a as AnnotationLike, {
      sopOf: sopOfImageId,
      metaOf: (roiUid) => getRoiMaskMeta(roiUid),
      // scope は作成時のメタが持っているので、ここでは補わない
      // （表示中の ZCT を混ぜると、別タイルの ROI に今見ている c/t を書いてしまう）。
    });
    if (saved) out.push(saved);
  }

  // ⚠ ここが要点: **いま開いていないシリーズの ROI を持ち越す**。
  // 復元は表示中スタックに属する ROI だけを戻すので、別シリーズの ROI は annotation state に無い。
  // 持ち越さないと `roiSaveStore` の差分検出が「消えた」と判定し、墓標を立てて**実際に消す**。
  // 判定は「その ROI の SOP が、いまどこかのビューポートに読み込まれているか」で行う
  // （読み込まれているのに annotation が無い＝ユーザーが削除した、と確定できる）。
  const live = new Set(out.map((r) => r.roiUid));
  const openSops = openStackSops();
  for (const r of loaded) {
    if (live.has(r.roiUid)) continue;
    if (openSops.has(r.sopInstanceUid)) continue; // 見えていたのに無い＝削除された
    out.push(r);
  }
  return out;
}

/** 復元先のビューポート（ダックタイピング）。 */
interface RestoreViewport {
  element?: HTMLElement;
  getCamera?: () => { viewPlaneNormal?: number[]; viewUp?: number[]; position?: number[]; focalPoint?: number[] };
  /** Cornerstone の `ViewReference`。中身は本体の型に追従させたくないので unknown で受ける。 */
  getViewReference?: (opts: { sliceIndex: number }) => unknown;
}

/**
 * 保存済み ROI のうち、このスタックに属するものを復元する。復元できた件数を返す。
 *
 * <p>**SOP が現在のスタックに無い ROI は復元しない**（別シリーズへ載せると座標の意味が壊れる）。
 * 既に annotation state にある UID も二重に足さない（タイルの再マウントで重複するのを防ぐ）。
 */
export function restoreRoisIntoStack(
  saved: SavedRoi[],
  imageIds: string[],
  viewport: RestoreViewport,
  patientKey: string,
  seriesLabel?: string,
): number {
  if (!saved.length || !imageIds.length || !viewport?.element) return 0;
  const index = sopIndex(imageIds);
  const targets = selectRestorable(
    saved,
    (sop) => index.get(sop) ?? null,
    (roiUid) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return Boolean((csAnnotation.state as any).getAnnotation(roiUid));
      } catch {
        return false;
      }
    },
  );
  if (!targets.length) return 0;

  let camera: ReturnType<NonNullable<RestoreViewport["getCamera"]>> | undefined;
  try {
    camera = viewport.getCamera?.();
  } catch {
    camera = undefined;
  }

  let restored = 0;
  for (const { roi, imageId } of targets) {
    const z = imageIds.indexOf(imageId);
    let viewRef: Record<string, unknown> = {};
    try {
      viewRef = (viewport.getViewReference?.({ sliceIndex: z }) as Record<string, unknown>) ?? {};
    } catch {
      viewRef = {};
    }
    const annotation = {
      // **保存されていた UID をそのまま使う**（プラグインが鍵に使えるようにするため）。
      annotationUID: roi.roiUid,
      highlighted: false,
      invalidated: true,
      isLocked: roi.isLocked ?? false,
      isVisible: roi.isVisible ?? true,
      metadata: {
        ...viewRef,
        toolName: roi.tool,
        referencedImageId: imageId,
        viewPlaneNormal: camera?.viewPlaneNormal,
        viewUp: camera?.viewUp,
        cameraPosition: camera?.position,
        cameraFocalPoint: camera?.focalPoint,
      },
      data: buildAnnotationData(roi),
    };
    // スプライン系は補間インスタンスが無いと描画・当たり判定で落ちる（保存形は type しか持たない）。
    ensureSplineInstance(annotation);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (csAnnotation.state as any).addAnnotation(annotation, viewport.element);
    } catch (e) {
      log.warn("roi restore failed", roi.roiUid, e);
      continue;
    }
    setRoiMaskMeta(roi.roiUid, buildRestoredMeta(roi, patientKey, seriesLabel));
    if (roi.isVisible === false) {
      try {
        csAnnotation.visibility.setAnnotationVisibility(roi.roiUid, false);
      } catch {
        /* 表示状態は復元できなくても致命的ではない */
      }
    }
    restored++;
  }
  // 再描画は呼び出し側（Viewer2D）が行う。ここは annotation state を触るだけに留める。
  return restored;
}
