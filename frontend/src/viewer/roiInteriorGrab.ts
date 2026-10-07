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
 * <p>**複数選択と同時移動**: Ctrl（Mac は ⌘）＋クリックで選択を足す・外す（{@link installSelectionGestures}）。
 * 選択中の ROI を掴んで動かすと、**表示中のスライスにある選択中の ROI がすべて**同じ量だけ動く。
 * 上流は押した時点で選択を「掴んだ 1 つだけ」に置き換える（`mouseDown.js` の `toggleAnnotationSelection`）ので、
 * 押した瞬間の選択を控えておき、選択中の ROI を掴んだときはその選択に戻す。
 *
 * <p>🔴 **上流の内部実装（`isPointNearTool` / `toolSelectedCallback` がインスタンスのアロー関数）に依存している。**
 * `@cornerstonejs/tools` を上げたら `roiInteriorGrab.test.ts` と実機スパイク `roiMoveCheck.ts` を回す。
 */
import { AnnotationTool, Enums as csToolsEnums, annotation as csAnnotation, state as csToolsState } from "@cornerstonejs/tools";
import { getAnnotationNearPoint, triggerAnnotationRenderForViewportIds } from "@cornerstonejs/tools/utilities";
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

/**
 * まとめて動かす注釈（純関数）。押した時点で選択中で、**表示中の画像に属し**、ロック・非表示でないもの。
 * 別スライスの ROI は、見えないまま動くと気付けないので含めない。
 */
export function groupMembers(selectedUids: readonly string[], annotations: readonly Any[], displayedImageId: string | undefined): Any[] {
  if (!displayedImageId) return [];
  const sel = new Set(selectedUids);
  return annotations.filter(
    (a) =>
      sel.has(a?.annotationUID) &&
      a?.metadata?.referencedImageId === displayedImageId &&
      !a?.isLocked &&
      a?.isVisible !== false,
  );
}

function shiftPoints(pts: Vec3[] | undefined, d: Vec3): void {
  for (const q of pts ?? []) {
    q[0] += d[0];
    q[1] += d[1];
    q[2] += d[2];
  }
}

/**
 * 注釈を world 差分 d だけ平行移動する（純関数ではないが DOM に触らない）。`handles.points` と `contour.polyline`、
 * 利用者が動かした文字ボックスを動かす。スプライン系は描画時に `handles.points` から輪郭を作り直すので、
 * 両方動かしても二重にはならない。
 */
export function shiftAnnotation(annotation: Any, d: Vec3): void {
  const data = annotation?.data;
  if (!data) return;
  shiftPoints(data.contour?.polyline, d);
  shiftPoints(data.handles?.points, d);
  const tb = data.handles?.textBox;
  if (tb?.hasMoved && tb.worldPosition) shiftPoints([tb.worldPosition], d);
  annotation.invalidated = true;
}

/** 押した瞬間の選択（{@link installSelectionGestures} が控える）。上流が掴んだ 1 つに置き換える前の状態。 */
let selectionAtPress: string[] = [];

function currentSelection(): string[] {
  try {
    return [...(csAnnotation.selection.getAnnotationsSelected() ?? [])];
  } catch {
    return [];
  }
}

/** 選択中の ROI を掴んだのなら、押した瞬間の選択に戻す（掴んだだけで複数選択が外れないように）。 */
function keepSelectionIfGrabbedSelected(uid: string): boolean {
  if (!selectionAtPress.includes(uid)) return false;
  try {
    for (const u of selectionAtPress) {
      if (csAnnotation.state.getAnnotation(u)) csAnnotation.selection.setAnnotationSelected(u, true, true);
    }
  } catch {
    /* 選択を戻せなくても操作自体は続ける */
  }
  return true;
}

function allAnnotations(): Any[] {
  try {
    return ((csAnnotation.state as Any).getAllAnnotations?.() ?? []) as Any[];
  } catch {
    return [];
  }
}

/**
 * ツールのインスタンスに、内側掴み・まとめて移動・選択の保持を入れる。二重にはかけない。
 * 閉じた ROI 以外（Length など）にかけても、内側判定は常に偽なので線の掴みだけが対象になる。
 */
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

  const isFreehand = !!tool.activateClosedContourEdit;
  const originalSelected = tool.toolSelectedCallback;
  if (typeof originalSelected === "function") {
    tool.toolSelectedCallback = (evt: Any, annotation: Any, ...rest: unknown[]) => {
      const { element, currentPoints } = evt.detail;
      const canvas = currentPoints?.canvas as Vec2 | undefined;
      const onLine = canvas ? originalNear.call(tool, element, annotation, canvas, 6, "mouse") : true;
      const wasSelected = keepSelectionIfGrabbedSelected(annotation?.annotationUID);
      // フリーハンドの線を掴んだら、従来どおり描き直し編集（上流 `PlanarFreehandROITool.toolSelectedCallback`）。
      if (isFreehand && onLine) return originalSelected.call(tool, evt, annotation, ...rest);
      if (wasSelected) {
        const vp = getEnabledElement(element)?.viewport;
        const group = groupMembers(selectionAtPress, allAnnotations(), vp?.getCurrentImageId?.());
        if (group.length >= 2 && group.includes(annotation)) {
          startDrag(element, group, "shape");
          evt.preventDefault();
          return;
        }
      }
      // フリーハンドは上流に移動の手段が無いので、内側を掴んだら自前で平行移動する。
      if (isFreehand && canvas && insideFor(element, annotation, canvas)) {
        startDrag(element, [annotation], "shape", tool);
        evt.preventDefault();
        return;
      }
      return originalSelected.call(tool, evt, annotation, ...rest);
    };
  }

  const originalHandle = tool.handleSelectedCallback;
  if (typeof originalHandle === "function") {
    tool.handleSelectedCallback = (evt: Any, annotation: Any, handle: Any, ...rest: unknown[]) => {
      // ハンドルで形を変えるのは掴んだ 1 つだけ。ただし複数選択は外さない。
      keepSelectionIfGrabbedSelected(annotation?.annotationUID);
      // 上流のフリーハンドは統計の文字ボックスを掴むと「開いた輪郭の端の編集」に入り、閉じた輪郭では何も起きない。
      // 文字ボックスは ROI の内側に大きく重なって置かれるので、そこを掴んだ内側のドラッグが黙って効かなくなる
      // （実機スパイクで発覚）。ほかの ROI と同じく、文字ボックスのドラッグは文字ボックスの移動にする。
      if (isFreehand && handle && handle === annotation?.data?.handles?.textBox) {
        startDrag(evt.detail.element, [annotation], "textBox", tool);
        evt.preventDefault();
        return;
      }
      return originalHandle.call(tool, evt, annotation, handle, ...rest);
    };
  }
}

/**
 * world 差分で動かすドラッグを始める。`shape` は注釈全体（{@link shiftAnnotation}）、`textBox` は文字ボックスだけ。
 * Undo は上流の履歴に積む。1 つなら掴んだツールの memo、複数ならグループ記録で 1 段にまとめる。
 */
function startDrag(element: HTMLDivElement, annotations: Any[], what: "shape" | "textBox", tool?: Any): void {
  const E = csToolsEnums.Events;
  const viewportIds = [getEnabledElement(element)?.viewport?.id].filter(Boolean) as string[];
  for (const a of annotations) a.highlighted = true;
  let memoStarted = false;
  const startMemo = () => {
    memoStarted = true;
    try {
      if (annotations.length === 1 && typeof tool?.createMemo === "function") {
        tool.createMemo(element, annotations[0]);
        return;
      }
      AnnotationTool.startGroupRecording();
      for (const a of annotations) AnnotationTool.createAnnotationMemo(element, a);
      AnnotationTool.endGroupRecording();
    } catch {
      /* 履歴に積めなくても移動はする */
    }
  };
  const onDrag = (e: Any) => {
    if (!memoStarted) startMemo();
    const d = e.detail.deltaPoints.world as Vec3;
    for (const a of annotations) {
      const tb = a.data.handles?.textBox;
      if (what === "textBox") {
        if (tb?.worldPosition) {
          shiftPoints([tb.worldPosition], d);
          tb.hasMoved = true;
        }
      } else {
        shiftAnnotation(a, d);
      }
    }
    triggerAnnotationRenderForViewportIds(viewportIds);
  };
  const onEnd = () => {
    element.removeEventListener(E.MOUSE_DRAG, onDrag as EventListener);
    element.removeEventListener(E.MOUSE_UP, onEnd);
    element.removeEventListener(E.MOUSE_CLICK, onEnd);
    csToolsState.isInteractingWithTool = false;
    if (memoStarted && annotations.length === 1 && typeof tool?.doneEditMemo === "function") tool.doneEditMemo();
    triggerAnnotationRenderForViewportIds(viewportIds);
  };
  csToolsState.isInteractingWithTool = true;
  element.addEventListener(E.MOUSE_DRAG, onDrag as EventListener);
  element.addEventListener(E.MOUSE_UP, onEnd);
  element.addEventListener(E.MOUSE_CLICK, onEnd);
}

/** 外接矩形の面積（canvas px²）。入れ子の ROI を Ctrl＋クリックしたとき、内側の小さい方を選ぶのに使う。 */
function canvasBoxArea(annotation: Any, toCanvas: (w: Vec3) => Vec2): number {
  const pts: Vec3[] = annotation?.data?.contour?.polyline?.length ? annotation.data.contour.polyline : annotation?.data?.handles?.points ?? [];
  if (pts.length === 0) return Infinity;
  const c = pts.map(toCanvas);
  const xs = c.map((p) => p[0]);
  const ys = c.map((p) => p[1]);
  return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys));
}

/**
 * ビューポートの element に、選択まわりの押下の扱いを付ける。戻り値で外す。
 *
 * <ul>
 *   <li>押した瞬間の選択を控える（上流が選択を置き換える前。{@link keepSelectionIfGrabbedSelected}）。</li>
 *   <li>**Ctrl（Mac は ⌘）＋左クリック**で、そこにある ROI の選択を足す・外す。線・ハンドルの近くを先に見て、
 *       無ければ表示中の閉じた ROI の内側（入れ子なら小さい方）。当たったら上流に渡さない
 *       （新規作成・移動・W/L を起こさない）。当たらなければ素通し。</li>
 * </ul>
 *
 * <p>Shift は使わない（タイル選択 `Viewer2DScreen` と同時に起きる）。Mac の Ctrl＋クリックは右クリックになるので ⌘ も受ける。
 * 上流が聞くのは `mousedown`（`eventListeners/mouse/mouseDownListener.js`）なので、その捕捉段階で止める。
 */
export function installSelectionGestures(element: HTMLDivElement): () => void {
  const onDown = (e: MouseEvent) => {
    selectionAtPress = currentSelection();
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return;
    const vp = getEnabledElement(element)?.viewport as Any;
    const canvas = vp?.canvas as HTMLCanvasElement | undefined;
    if (!vp || !canvas) return;
    const r = canvas.getBoundingClientRect();
    const p: Vec2 = [e.clientX - r.left, e.clientY - r.top];
    let hit: Any = null;
    try {
      hit = getAnnotationNearPoint(element, p as Any, 6);
    } catch {
      hit = null;
    }
    if (!hit) {
      const toCanvas = (w: Vec3) => vp.worldToCanvas(w) as Vec2;
      const imageId = vp.getCurrentImageId?.();
      const inside = allAnnotations().filter(
        (a) => a?.metadata?.referencedImageId === imageId && !a?.isLocked && a?.isVisible !== false && isInsideClosedRoi(a, toCanvas, p),
      );
      inside.sort((x, y) => canvasBoxArea(x, toCanvas) - canvasBoxArea(y, toCanvas));
      hit = inside[0] ?? null;
    }
    if (!hit) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    toggleRoiSelection(hit.annotationUID);
  };
  element.addEventListener("mousedown", onDown, true);
  return () => element.removeEventListener("mousedown", onDown, true);
}

/** ROI の選択を足す・外す（ほかの選択は残す）。Ctrl＋クリック（画像上・ROI マネージャの行）。 */
export function toggleRoiSelection(uid: string): void {
  try {
    const on = !csAnnotation.selection.isAnnotationSelected(uid);
    csAnnotation.selection.setAnnotationSelected(uid, on, true);
    const ids = (getRenderingEngines() ?? []).flatMap((re) => re.getViewports().map((v) => v.id));
    triggerAnnotationRenderForViewportIds(ids);
  } catch {
    /* 選択できなくても致命的ではない */
  }
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
