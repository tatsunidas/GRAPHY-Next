import { type Types } from "@cornerstonejs/core";

/**
 * 2D ビューアの表示変換（affine）モデル。
 *
 * <p>Cornerstone3D の ViewPresentation（内部的に camera=affine）と 1:1 で対応させ、
 * zoom / pan / flip(上下左右) / rotation を**まとめて 1 つの affine 状態**として扱う。
 * - zoom: コンポーネントに Fit している状態を <b>1.0（=100%）</b>とした相対倍率。
 * - pan : 既定（画像が中央）からのオフセット（world 座標）。[0,0] が中央原点。
 * - rotation: 度。flipHorizontal/Vertical: 左右/上下反転。
 */
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

/** ビューポートの現在の表示変換を読む。 */
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

/**
 * 部分更新を現在状態にマージして適用する。
 * displayArea を必ず現在値で埋めることで setViewPresentation の displayArea 誤適用を防ぐ。
 */
export function applyTransform(vp: Types.IStackViewport, patch: Partial<ViewTransform>): void {
  const cur = vp.getViewPresentation();
  vp.setViewPresentation({ ...cur, ...patch });
  vp.render();
}

/**
 * Pan 状態か否か。要件: <b>zoom されている（Fit=1.0 以外）と true</b>。
 * 併せてパンオフセットがある場合も true。
 */
export function isPanned(t: ViewTransform): boolean {
  return t.zoom !== 1 || t.pan[0] !== 0 || t.pan[1] !== 0;
}
