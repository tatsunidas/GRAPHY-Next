/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { annotation as csAnnotation } from "@cornerstonejs/tools";

/**
 * ROI のロック。ロック中の ROI は移動・変形（Cornerstone が拒む）と削除（本体の各経路が拒む）から守られる。
 * 保存・復元は `isLocked` として roiPersistence が持つ。
 */
// Cornerstone はロックを、全体のロック集合（locking API）と注釈自身の isLocked の 2 か所で持つ。
// 移動を拒む判定は isLocked を見るので、どちらかが立っていればロック中とみなす。
export function isRoiLocked(uid: string): boolean {
  try {
    return csAnnotation.locking.isAnnotationLocked(uid) === true || csAnnotation.state.getAnnotation(uid)?.isLocked === true;
  } catch {
    return false;
  }
}

export function setRoiLocked(uid: string, locked: boolean): void {
  try {
    // isLocked だけ立っている注釈は、集合から外す処理が何もしない（isLocked も残る）。先に集合へ載せてから外す。
    if (!locked && !csAnnotation.locking.isAnnotationLocked(uid) && csAnnotation.state.getAnnotation(uid)?.isLocked) {
      csAnnotation.locking.setAnnotationLocked(uid, true);
    }
    csAnnotation.locking.setAnnotationLocked(uid, locked);
  } catch {
    /* ロックできない環境（テスト等）では素通しする */
  }
}

/** 削除の候補をロック中（kept）と、消してよいもの（removable）に分ける。 */
export function partitionByLock(
  uids: readonly string[],
  isLocked: (uid: string) => boolean = isRoiLocked,
): { removable: string[]; kept: string[] } {
  const removable: string[] = [];
  const kept: string[] = [];
  for (const uid of uids) (isLocked(uid) ? kept : removable).push(uid);
  return { removable, kept };
}
