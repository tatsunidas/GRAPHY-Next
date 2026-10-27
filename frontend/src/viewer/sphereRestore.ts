/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 球 ROI の保存形への収集と、表示中スタックへの復元（`sphere3dStore` に触る層）。
 *
 * <p>形の ROI の {@link ./roiRestore} と同じ作り。判断（何を持ち越すか・何を戻すか）は
 * 純関数 {@link carryOverSpheres} / {@link selectRestorableSpheres} に置く。
 */
import { addSphere3D, listSpheres3D, type Sphere3D } from "./sphere3dStore";
import { openStackSops, resolveImageId, sopIndex, sopOfImageId } from "./roiRestore";
import type { SavedSphere } from "./roiPersistence";

/** ストアの球 → 保存形。患者・シリーズ・参照スライスの SOP が分からない球は復元できないので null。 */
export function toSavedSphere(s: Sphere3D, sopOf: (imageId: string) => string | null): SavedSphere | null {
  if (!s.seriesUid) return null;
  const sop = sopOf(s.refImageId);
  if (!sop) return null;
  const out: SavedSphere = {
    uid: s.uid,
    studyUid: s.studyUid,
    seriesUid: s.seriesUid,
    refSopInstanceUid: sop,
    center: [s.center[0], s.center[1], s.center[2]],
    radiusMm: s.radiusMm,
    c: s.c,
    t: s.t,
    color: s.color,
    visible: s.visible,
  };
  if (s.label !== undefined) out.label = s.label;
  if (s.groupId) {
    out.groupId = s.groupId;
    if (s.groupName !== undefined) out.groupName = s.groupName;
  }
  return out;
}

/**
 * 現存の球に、読み込み済みの球を持ち越して足す（純関数）。
 *
 * <p>持ち越すのは「参照スライスの SOP がいまどのビューポートにも読み込まれていない」球だけ。
 * 読み込まれているのにストアに無い球は、利用者が削除した（→ 墓標が立つ）と確定できる。
 * 持ち越さないと、表示していないシリーズの球が保存のたびに消える。
 */
export function carryOverSpheres(live: SavedSphere[], loaded: SavedSphere[], openSops: ReadonlySet<string>): SavedSphere[] {
  const out = [...live];
  const have = new Set(live.map((s) => s.uid));
  for (const sp of loaded) {
    if (have.has(sp.uid)) continue;
    if (openSops.has(sp.refSopInstanceUid)) continue;
    out.push(sp);
  }
  return out;
}

/** 復元できる球（参照 SOP がスタックにあり、同じ uid がストアに無い）と、その imageId。 */
export function selectRestorableSpheres(
  saved: SavedSphere[],
  resolve: (sop: string) => string | null,
  existingUids: ReadonlySet<string>,
): Array<{ sphere: SavedSphere; imageId: string }> {
  const out: Array<{ sphere: SavedSphere; imageId: string }> = [];
  for (const sp of saved) {
    if (existingUids.has(sp.uid)) continue;
    const imageId = resolve(sp.refSopInstanceUid);
    if (imageId) out.push({ sphere: sp, imageId });
  }
  return out;
}

/** この患者の球を保存形に集める（`registerRoiCollector` の第 3 引数）。 */
export function collectSpheresForPatient(patientKey: string, loaded: SavedSphere[]): SavedSphere[] {
  const live: SavedSphere[] = [];
  for (const s of listSpheres3D()) {
    if (s.patientKey !== patientKey) continue;
    const saved = toSavedSphere(s, sopOfImageId);
    if (saved) live.push(saved);
  }
  return carryOverSpheres(live, loaded, openStackSops());
}

/** 保存済みの球のうち、このスタックに属するものをストアへ戻す。戻した件数を返す。 */
export function restoreSpheresIntoStack(saved: SavedSphere[], imageIds: string[], patientKey: string, seriesLabel?: string): number {
  if (!saved.length || !imageIds.length) return 0;
  const index = sopIndex(imageIds);
  const existing = new Set(listSpheres3D().map((s) => s.uid));
  const targets = selectRestorableSpheres(saved, (sop) => resolveImageId(index, sop), existing);
  for (const { sphere, imageId } of targets) {
    addSphere3D({
      uid: sphere.uid,
      studyUid: sphere.studyUid,
      seriesUid: sphere.seriesUid,
      refImageId: imageId,
      center: sphere.center,
      radiusMm: sphere.radiusMm,
      c: sphere.c,
      t: sphere.t,
      patientKey,
      seriesLabel,
      label: sphere.label,
      color: sphere.color,
      visible: sphere.visible,
      groupId: sphere.groupId,
      groupName: sphere.groupName,
    });
  }
  return targets.length;
}
