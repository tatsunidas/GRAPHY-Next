/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 本体 frontend/src/viewer/transform.ts からの移植（vanilla・依存は cornerstone のみ）。
// flip は setViewPresentation では OFF にできない Cornerstone 既知挙動があるため、
// flip だけ setCamera で双方向トグルし、残りは presentation で適用する（本体と同一ロジック）。
import { type Types } from "@cornerstonejs/core";

export interface ViewTransform {
  zoom: number;
  pan: [number, number];
  rotation: number;
  flipHorizontal: boolean;
  flipVertical: boolean;
}

/** Fit（1.0）・中央原点・無回転・無反転。Reset の目標状態。 */
export const FIT_TRANSFORM: ViewTransform = {
  zoom: 1,
  pan: [0, 0],
  rotation: 0,
  flipHorizontal: false,
  flipVertical: false,
};

export function readTransform(vp: Types.IStackViewport): ViewTransform {
  const p = vp.getViewPresentation();
  const pan = (p.pan ?? [0, 0]) as [number, number];
  return {
    zoom: p.zoom ?? 1,
    pan,
    rotation: p.rotation ?? 0,
    flipHorizontal: p.flipHorizontal ?? false,
    flipVertical: p.flipVertical ?? false,
  };
}

export function applyTransform(vp: Types.IStackViewport, patch: Partial<ViewTransform>): void {
  const cur = vp.getViewPresentation();

  // 1) flip は setCamera で（現在値と異なるときだけ）適用＝双方向に効く。
  const flip: { flipHorizontal?: boolean; flipVertical?: boolean } = {};
  if (patch.flipHorizontal !== undefined && patch.flipHorizontal !== cur.flipHorizontal) {
    flip.flipHorizontal = patch.flipHorizontal;
  }
  if (patch.flipVertical !== undefined && patch.flipVertical !== cur.flipVertical) {
    flip.flipVertical = patch.flipVertical;
  }
  if (flip.flipHorizontal !== undefined || flip.flipVertical !== undefined) {
    vp.setCamera(flip as Parameters<Types.IStackViewport["setCamera"]>[0]);
  }

  // 2) 残りは presentation で。flip は setCamera 後の実値に合わせて no-op にする。
  const after = vp.getViewPresentation();
  vp.setViewPresentation({
    ...cur,
    ...patch,
    flipHorizontal: after.flipHorizontal,
    flipVertical: after.flipVertical,
  });
  vp.render();
}
