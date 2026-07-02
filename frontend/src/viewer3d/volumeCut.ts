/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Cut（lasso スカルプト）の**幾何ユーティリティ**（`fw/3d-viewer-design.md` §15-#2）。
 * 旧 GRAPHY `view/D3/ui/{VolumeEditor,CutLineRenderer}` の TS/vtk.js 移植。
 *
 * ユーザが画面上に描いた投げ縄（lasso, CSS px の多角形）に対し、3D ROI（labelmap）の各前景ボクセルを
 * **現在のビュー方向に沿って投影**し、多角形の内/外で除去する（＝視線方向のパンチカット）。要件 11 に従い、
 * ボクセル→world は**実画像空間（患者 LPS mm）**で計算し（`labelVolume.voxelToWorld`）、world→画面は
 * **pure vtk のカメラ行列**（`getViewMatrix`/`getProjectionMatrix`）で行う（cornerstone の worldToCanvas に依存しない）。
 *
 * 投影は vtk.js `Rendering/Core/Renderer.worldToView → viewToProjection → projectionToNormalizedDisplay` の
 * 数式を 1:1 で再現する（行列を 1 度だけ取得して全ボクセルに適用＝高速）。dpr は CSS 換算で相殺されるため、
 * 必要なのは **カメラ ＋ ビューポートの CSS 寸法（幅/高さ）** のみ。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
type V3 = [number, number, number];

/** カット方向。inside=lasso 内を除去 / outside=lasso 内だけ残す（外を除去）。 */
export type CutMode = "inside" | "outside";

/** world(LPS mm) → ビューポート CSS px（左上原点）。カメラ後方など投影不能なら null。 */
export type Projector = (world: V3) => [number, number] | null;

/** world → world（アクター行列を掛ける。カメラ固定=アクター回転モード対応）。 */
export type WorldTransform = (world: V3) => V3;

// ── 行列（gl-matrix と同じ列優先＝m[col*4+row]）ヘルパ ──────────────
/** 16 要素行列の転置（vtk は行優先で返すので gl 列優先へ直す時に使う）。 */
function transpose16(m: ArrayLike<number>): number[] {
  return [
    m[0], m[4], m[8], m[12],
    m[1], m[5], m[9], m[13],
    m[2], m[6], m[10], m[14],
    m[3], m[7], m[11], m[15],
  ];
}

/**
 * 列優先行列 m（gl-matrix 互換）で点 p を変換し、w 除算した [x,y,z] を返す。
 * w<=eps（カメラ後方・退化）は null。gl-matrix `vec3.transformMat4` と同じ挙動。
 */
function applyMat4(m: ArrayLike<number>, p: V3): V3 | null {
  const x = p[0], y = p[1], z = p[2];
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  if (!(Math.abs(w) > 1e-9)) return null;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

/**
 * 現在のカメラ状態から world→CSS 投影関数を作る。
 * `renderer` から activeCamera を取り、ビューポートの CSS 寸法（幅/高さ）で NDC→CSS 変換する。
 * カメラや寸法が取れなければ null。
 */
export function makeCameraProjector(renderer: Any, cssWidth: number, cssHeight: number): Projector | null {
  try {
    const cam: Any = renderer?.getActiveCamera?.();
    if (!cam || cssWidth <= 0 || cssHeight <= 0) return null;
    const aspect = cssWidth / cssHeight;
    // vtk Renderer.worldToView は getViewMatrix() を transpose して gl 列優先で使う。ここも同様。
    const Vt = transpose16(cam.getViewMatrix());
    const Pt = transpose16(cam.getProjectionMatrix(aspect, -1, 1));
    return (world: V3): [number, number] | null => {
      const v = applyMat4(Vt, world); // view 空間（w=1）
      if (!v) return null;
      const c = applyMat4(Pt, v); // NDC [-1,1]（透視は w 除算・w<=0 は後方で null）
      if (!c) return null;
      // NDC → CSS（左上原点）。dpr はフレームバッファ/CSS で相殺されるため寸法のみで足りる。
      const sx = (c[0] + 1) * 0.5 * cssWidth;
      const sy = (1 - c[1]) * 0.5 * cssHeight;
      return [sx, sy];
    };
  } catch {
    return null;
  }
}

/**
 * アクターのモデル行列（`getMatrix()`）で world 点を変換する関数を作る。
 * カメラ固定・被写体回転（actor rotate モード）で蓄積した向きを投影に反映するため。
 * 恒等（既定のカメラ回転モード）なら素通し。
 */
export function makeActorTransform(actor: Any): WorldTransform {
  try {
    if (!actor?.getMatrix) return (w) => w;
    const m = actor.getMatrix(); // getMatrix() が computeMatrix→isIdentity を更新する
    if (actor.getIsIdentity?.()) return (w) => w;
    const Mg = transpose16(m); // vtk 行優先 → gl 列優先
    return (w) => applyMat4(Mg, w) ?? w;
  } catch {
    return (w) => w;
  }
}

/** 点 pt が多角形 poly（CSS px）の内部か（even-odd ray casting）。 */
export function pointInPolygon(pt: [number, number], poly: [number, number][]): boolean {
  const x = pt[0];
  const y = pt[1];
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
