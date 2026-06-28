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
 *
 * <p>flip は `setViewPresentation` 経由だと <b>OFF にできない</b>（Cornerstone の既知挙動:
 * 内部の flip(false) が no-op のため一方通行になる）。そこで flip だけ `setCamera` で
 * 双方向トグルし、残り（zoom/pan/rotation/displayArea）は presentation で適用する。
 * displayArea は現在値で埋め、setViewPresentation の displayArea 誤適用を防ぐ。
 */
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

/**
 * Pan 状態か否か。要件: <b>zoom されている（Fit=1.0 以外）と true</b>。
 * 併せてパンオフセットがある場合も true。
 */
export function isPanned(t: ViewTransform): boolean {
  return t.zoom !== 1 || t.pan[0] !== 0 || t.pan[1] !== 0;
}
