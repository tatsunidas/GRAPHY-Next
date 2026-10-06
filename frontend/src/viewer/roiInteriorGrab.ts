/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * **選択中の閉じた ROI は、内側のドラッグで移動できるようにする。**
 *
 * <p>Cornerstone3D の押下の振り分け（`eventDispatchers/mouseEventHandlers/mouseDown.js`）は
 * ①ハンドル（6px 以内）→ 形を変える ②`isPointNearTool`（線の 6px 以内）→ 移動 ③それ以外 → 新規作成。
 * 矩形・楕円・輪郭系の `isPointNearTool` は**線の近くしか拾わない**ので、内側を掴むと新しい ROI ができる。
 * そこで `isPointNearTool` を包み、**選択中**の閉じた ROI に限って内側も「近い」とする
 * （未選択の ROI の内側では従来どおり新しく描ける＝入れ子の ROI を描ける）。
 *
 * <p>フリーハンド（`PlanarFreehandROITool`）は線を掴むと**描き直し編集**になり移動の手段が無いので、
 * `toolSelectedCallback` も包み、線から離れた内側なら平行移動を自前で行う。統計の文字ボックスを掴んだときも
 * 上流は何もしない（開いた輪郭用の処理に入る）ので、`handleSelectedCallback` を包んで文字ボックスの移動にする。
 *
 * <p>🔴 **上流の内部実装（`isPointNearTool` / `toolSelectedCallback` がインスタンスのアロー関数）に依存している。**
 * `@cornerstonejs/tools` を上げたら `roiInteriorGrab.test.ts` と実機スパイク `roiMoveCheck.ts` を回す。
 */
import { Enums as csToolsEnums, annotation as csAnnotation, state as csToolsState } from "@cornerstonejs/tools";
import { triggerAnnotationRenderForViewportIds } from "@cornerstonejs/tools/utilities";
import { getEnabledElement, getRenderingEngines } from "@cornerstonejs/core";

type Vec2 = [number, number] | number[];
type Vec3 = [number, number, number] | number[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** 偶奇規則による多角形の内外判定（canvas 座標）。 */
export function pointInPolygon(poly: Vec2[], p: Vec2): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 注釈が閉じた面を持つ ROI なら、canvas 点 `p` がその内側かを返す。面を持たない注釈は false。
 *
 * <p>矩形の `handles.points` は 0↔3・1↔2 が対角（上流 `RectangleROITool._dragCallback`）なので 0,1,3,2 の順で一周する。
 * 楕円は [bottom, top, left, right]。輪郭系は `data.contour.polyline` を `contour.closed` のときだけ使う。
 */
export function isInsideClosedRoi(annotation: Any, toCanvas: (w: Vec3) => Vec2, p: Vec2): boolean {
  const tool = annotation?.metadata?.toolName as string | undefined;
  const data = annotation?.data;
  if (!data) return false;
  if (tool === "RectangleROI") {
    const pts = data.handles?.points;
    if (!pts || pts.length !== 4) return false;
    return pointInPolygon([0, 1, 3, 2].map((i) => toCanvas(pts[i])), p);
  }
  if (tool === "EllipticalROI") {
    const pts = data.handles?.points;
    if (!pts || pts.length !== 4) return false;
    const [bottom, top, left, right] = pts.map(toCanvas);
    const cx = (left[0] + right[0]) / 2;
    const cy = (left[1] + right[1]) / 2;
    const a = Math.hypot(right[0] - left[0], right[1] - left[1]) / 2;
    const b = Math.hypot(top[0] - bottom[0], top[1] - bottom[1]) / 2;
    if (!(a > 0 && b > 0)) return false;
    const ux = (right[0] - left[0]) / (2 * a);
    const uy = (right[1] - left[1]) / (2 * a);
    const dx = p[0] - cx;
    const dy = p[1] - cy;
    const s = (dx * ux + dy * uy) / a;
    const t = (-dx * uy + dy * ux) / b;
    return s * s + t * t <= 1;
  }
  const contour = data.contour;
  if (contour?.closed && Array.isArray(contour.polyline) && contour.polyline.length >= 3) {
    return pointInPolygon(contour.polyline.map(toCanvas), p);
  }
  return false;
}

export interface InteriorGrabOptions {
  /** 左ドラッグに計測・ROI 系のツールが割り当たっているか。W/L・Pan 中は内側を掴まない。 */
  isMeasureToolActive: () => boolean;
}

function isSelected(uid: string): boolean {
  try {
    return !!csAnnotation.selection.isAnnotationSelected(uid);
  } catch {
    return false;
  }
}

/**
 * 内側を掴むかの判定（純関数・テスト用に切り出し）。元の判定が真ならそれを優先する。
 */
export function interiorHit(
  annotation: Any,
  toCanvas: (w: Vec3) => Vec2,
  p: Vec2,
  selected: boolean,
  measureActive: boolean,
): boolean {
  if (!selected || !measureActive) return false;
  if (annotation?.isLocked || annotation?.isVisible === false) return false;
  return isInsideClosedRoi(annotation, toCanvas, p);
}

/** ツールのインスタンスに内側掴みを入れる。二重にはかけない。 */
export function installInteriorGrab(tool: Any, opts: InteriorGrabOptions): void {
  if (!tool || tool.__graphyInteriorGrab) return;
  const originalNear = tool.isPointNearTool;
  if (typeof originalNear !== "function") return;
  tool.__graphyInteriorGrab = true;

  const insideFor = (element: HTMLDivElement, annotation: Any, canvasCoords: Vec2): boolean => {
    const vp = getEnabledElement(element)?.viewport;
    if (!vp) return false;
    return interiorHit(
      annotation,
      (w) => vp.worldToCanvas(w as Any) as Vec2,
      canvasCoords,
      isSelected(annotation?.annotationUID),
      opts.isMeasureToolActive(),
    );
  };

  tool.isPointNearTool = (element: HTMLDivElement, annotation: Any, canvasCoords: Vec2, proximity: number, ...rest: unknown[]) => {
    if (originalNear.call(tool, element, annotation, canvasCoords, proximity, ...rest)) return true;
    return insideFor(element, annotation, canvasCoords);
  };

  // フリーハンドは線を掴むと描き直し編集になる（上流 `PlanarFreehandROITool.toolSelectedCallback`）。
  // 線から離れた内側を掴んだときだけ、平行移動へ切り替える。
  if (!tool.activateClosedContourEdit) return;
  const originalSelected = tool.toolSelectedCallback;
  if (typeof originalSelected !== "function") return;
  tool.toolSelectedCallback = (evt: Any, annotation: Any, ...rest: unknown[]) => {
    const { element, currentPoints } = evt.detail;
    const canvas = currentPoints?.canvas as Vec2 | undefined;
    const onLine = canvas ? originalNear.call(tool, element, annotation, canvas, 6, "mouse") : true;
    if (!onLine && canvas && insideFor(element, annotation, canvas)) {
      startDrag(tool, element, annotation, "shape");
      evt.preventDefault();
      return;
    }
    return originalSelected.call(tool, evt, annotation, ...rest);
  };

  // 上流のフリーハンドは統計の文字ボックスを掴むと「開いた輪郭の端の編集」に入り、閉じた輪郭では何も起きない。
  // 文字ボックスは ROI の内側に大きく重なって置かれるので、そこを掴んだ内側のドラッグが黙って効かなくなる
  // （実機スパイクで発覚）。ほかの ROI と同じく、文字ボックスのドラッグは文字ボックスの移動にする。
  const originalHandle = tool.handleSelectedCallback;
  if (typeof originalHandle !== "function") return;
  tool.handleSelectedCallback = (evt: Any, annotation: Any, handle: Any, ...rest: unknown[]) => {
    if (handle && handle === annotation?.data?.handles?.textBox) {
      startDrag(tool, evt.detail.element, annotation, "textBox");
      evt.preventDefault();
      return;
    }
    return originalHandle.call(tool, evt, annotation, handle, ...rest);
  };
}

/**
 * world 差分で動かすドラッグを始める。`shape` は輪郭の全点（文字ボックスは利用者が動かしていれば一緒に）、
 * `textBox` は文字ボックスだけ。
 */
function startDrag(tool: Any, element: HTMLDivElement, annotation: Any, what: "shape" | "textBox"): void {
  const E = csToolsEnums.Events;
  const viewportIds = [getEnabledElement(element)?.viewport?.id].filter(Boolean) as string[];
  annotation.highlighted = true;
  let memoStarted = false;
  const shift = (pts: Vec3[] | undefined, d: Vec3) => {
    for (const q of pts ?? []) {
      q[0] += d[0];
      q[1] += d[1];
      q[2] += d[2];
    }
  };
  const onDrag = (e: Any) => {
    if (!memoStarted && typeof tool.createMemo === "function") {
      tool.createMemo(element, annotation);
      memoStarted = true;
    }
    const d = e.detail.deltaPoints.world as Vec3;
    const tb = annotation.data.handles?.textBox;
    if (what === "textBox") {
      if (tb?.worldPosition) {
        shift([tb.worldPosition], d);
        tb.hasMoved = true;
      }
    } else {
      shift(annotation.data.contour?.polyline, d);
      shift(annotation.data.handles?.points, d);
      if (tb?.hasMoved && tb.worldPosition) shift([tb.worldPosition], d);
      annotation.invalidated = true;
    }
    triggerAnnotationRenderForViewportIds(viewportIds);
  };
  const onEnd = () => {
    element.removeEventListener(E.MOUSE_DRAG, onDrag as EventListener);
    element.removeEventListener(E.MOUSE_UP, onEnd);
    element.removeEventListener(E.MOUSE_CLICK, onEnd);
    csToolsState.isInteractingWithTool = false;
    if (memoStarted && typeof tool.doneEditMemo === "function") tool.doneEditMemo();
    triggerAnnotationRenderForViewportIds(viewportIds);
  };
  csToolsState.isInteractingWithTool = true;
  element.addEventListener(E.MOUSE_DRAG, onDrag as EventListener);
  element.addEventListener(E.MOUSE_UP, onEnd);
  element.addEventListener(E.MOUSE_CLICK, onEnd);
}

/** ROI の選択をすべて外して描き直す（Esc）。何も選択していなければ何もしない。 */
export function deselectAllRois(): void {
  try {
    const selected = csAnnotation.selection.getAnnotationsSelected() ?? [];
    if (selected.length === 0) return;
    for (const uid of selected) csAnnotation.selection.setAnnotationSelected(uid, false);
    const ids = (getRenderingEngines() ?? []).flatMap((re) => re.getViewports().map((v) => v.id));
    triggerAnnotationRenderForViewportIds(ids);
  } catch {
    /* 選択を外せなくても致命的ではない */
  }
}
