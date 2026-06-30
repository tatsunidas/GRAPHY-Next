/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * global ROI（ZCT scope に "all" を含む計測注釈）のライブ全スライス描画。
 *
 * Cornerstone v3 の stack viewport は `metadata.referencedImageId === currentImageId` の
 * 完全一致でのみ annotation を描画する（`filterAnnotationsForDisplay`）。そこで scope.z="all" の
 * 注釈は、表示スライス変更時に `referencedImageId` を**現在の imageId へ追従**させて全スライスで見えるようにする。
 * local（z=具体 index）に戻した注釈は、その index の imageId へ復元する。
 *
 * 注: 1 つの annotation を「現在スライスへ追従」させる方式のため、同一シリーズを別スライスで
 * 同時表示する複数ビューポートでの全スライス同時描画は将来課題（要 per-imageId 複製）。
 * scope は {@link ./roiMaskStore} のメタを権威とする。
 */
import { annotation as csAnnotation, utilities as csToolsUtil } from "@cornerstonejs/tools";
import { getRoiMaskMeta, type DimScope } from "./roiMaskStore";

export interface GlobalRoiCtx {
  viewportId: string;
  seriesUid: string;
  c: number;
  t: number;
}

/** scope の 1 次元が現在表示中の値に該当するか（"all" は常に該当）。 */
function dimMatch(scope: DimScope | undefined, cur: number): boolean {
  return scope === "all" || scope === cur;
}

/**
 * 指定ビューポートが現在表示している (slice, c, t) に対し、global scope の注釈を追従描画させる。
 * - scope.z="all" → referencedImageId を現在 imageId に追従（全スライス可視）。
 * - scope.z=具体 index → その index の imageId へ（local 復元・c/t="all" の別チャンネル投影）。
 * - 現在表示中の c/t に属さない注釈は変更しない。
 */
export function reconcileGlobalAnnotations(
  ctx: GlobalRoiCtx,
  imageIds: string[],
  currentIndex: number,
): void {
  const currentImageId = imageIds[currentIndex];
  if (!currentImageId) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let all: any[];
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    all = csAnnotation.state.getAllAnnotations() as any[];
  } catch {
    return;
  }
  let changed = false;
  for (const a of all) {
    const uid = a?.annotationUID as string | undefined;
    if (!uid || !a.metadata) continue;
    const scope = getRoiMaskMeta(uid)?.scope;
    if (!scope) continue;
    if (scope.seriesUid && scope.seriesUid !== ctx.seriesUid) continue;
    // 現在表示中の c/t に属さない注釈は触らない（別チャンネルへ誤って移さない）。
    if (!dimMatch(scope.c, ctx.c) || !dimMatch(scope.t, ctx.t)) continue;
    let desired: string | undefined;
    if (scope.z === "all") {
      desired = currentImageId; // 全スライス追従
    } else if (typeof scope.z === "number") {
      desired = imageIds[scope.z]; // 固定スライス（local 復元 / c,t="all" の投影）
    }
    if (desired && a.metadata.referencedImageId !== desired) {
      a.metadata.referencedImageId = desired;
      // 再投影・stats 再計算のため無効化。referencedImageURI のキャッシュも更新。
      a.metadata.referencedImageURI = undefined;
      a.invalidated = true;
      changed = true;
    }
  }
  if (changed) {
    try {
      csToolsUtil.triggerAnnotationRenderForViewportIds([ctx.viewportId]);
    } catch {
      /* ignore */
    }
  }
}
