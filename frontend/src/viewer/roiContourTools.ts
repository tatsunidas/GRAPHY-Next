/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 輪郭系 ROI ツール（ポリゴン / フリーハンド × 閉じる / 閉じない）と、スプライン Fit。
 *
 * <p>Swing 版 GRAPHY（ImageJ の POLYGON / FREEHAND / POLYLINE / FREELINE）に合わせて 4 つを出す。
 * Cornerstone3D の素のツールは次の性質を持つため、そのままでは 4 通りを作れない:
 *
 * <ul>
 *   <li>{@code SplineROITool} … クリックで頂点を足す。**ダブルクリックすると必ず閉じて終わる**
 *       （`_mouseDownCallback` が `closeContour = points>=2 && doubleClick`）。開いたまま終える術が無い。</li>
 *   <li>{@code PlanarFreehandROITool} … ドラッグで描く。`allowOpenContours` で開いた輪郭を許すが、
 *       始点付近で離すと閉じる（`closeContourProximity`）。「必ず閉じる」「決して閉じない」の指定は無い。</li>
 * </ul>
 *
 * <p>そこで**同じクラスを別名で 2 つ登録**し（Cornerstone はツール名でインスタンスを持つ）、
 * 「開く方」は描き終わりに `contour.closed` を落として開いた輪郭に矯正する。
 *
 * <p>**スプライン Fit は描画モードではなく、描いた ROI への操作**として提供する
 * （ROI Tools メニュー、または ROI 上の右クリック）。選択中の ROI のうちポリゴン系のものだけに
 * 効き、制御点はそのままで補間だけ直線 ↔ Catmull-Rom に張り替える。
 * 描くときのモードにすると「この輪郭はどちらで描いたか」が後から分からなくなる。
 */
import {
  PlanarFreehandROITool,
  SplineROITool,
  AnnotationTool,
  ToolGroupManager,
  annotation as csAnnotation,
} from "@cornerstonejs/tools";
import {
  drawing as csDrawingUtils,
  getAnnotationNearPoint,
  triggerAnnotationRenderForViewportIds,
} from "@cornerstonejs/tools/utilities";
import { drawing as csDrawing } from "@cornerstonejs/tools";
import { getEnabledElement, getRenderingEngines } from "@cornerstonejs/core";

/**
 * 直線補間（＝ポリゴン）。Cornerstone の `SplineTypesEnum.Linear` と同じ値。
 *
 * <p>⚠ `SplineROITool` の**既定は CatmullRom（曲線）**なので、ポリゴンとして登録するときは
 * これを明示する（実機で「ポリゴンなのに曲線で描かれる」を踏んだ）。
 */
export const SPLINE_TYPE_LINEAR = "LINEAR";
const SPLINE_LINEAR = SPLINE_TYPE_LINEAR;
/** 曲線補間（スプライン Fit）。`SplineTypesEnum.CatmullRom` と同じ値。 */
const SPLINE_CURVE = "CATMULLROM";

/** ポリゴン（閉）。クリックで頂点を足し、ダブルクリック or 始点クリックで閉じる。 */
export class PolygonRoiTool extends SplineROITool {
  static override toolName = "GraphyPolygonROI";
}

/**
 * ポリゴンライン（開）。頂点をクリックで足し、ダブルクリックで**閉じずに**終える。
 *
 * <p>素の `SplineROITool` はダブルクリックで閉じてしまうので、終了後に `contour.closed` を
 * 落として開いた輪郭へ矯正する（描画・統計はどちらも `contour.closed` を見ている）。
 */
export class PolylineRoiTool extends SplineROITool {
  static override toolName = "GraphyPolylineROI";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(toolProps: any = {}, defaultToolProps?: any) {
    super(toolProps, defaultToolProps);
    forceOpenAfterFinish(this);
    // 開いた輪郭でも統計を出す（上流は closed のときしか描かない）。
    forceTextBoxOnOpenContour(this);
  }
}

/** フリーハンド（閉）。ドラッグで描き、離した時点で必ず閉じる。 */
export class FreehandRoiTool extends PlanarFreehandROITool {
  static override toolName = "GraphyFreehandROI";
}

/** フリーライン（開）。ドラッグで描き、閉じない（始点付近で離しても開いたまま）。 */
export class FreeLineRoiTool extends PlanarFreehandROITool {
  static override toolName = "GraphyFreeLineROI";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(toolProps: any = {}, defaultToolProps?: any) {
    super(toolProps, defaultToolProps);
    forceOpenAfterFinish(this);
  }
}

/** 4 ツールの名前（メニュー・ツール切替で使う）。 */
export const CONTOUR_TOOL_NAMES = {
  polygon: PolygonRoiTool.toolName,
  polyline: PolylineRoiTool.toolName,
  freehand: FreehandRoiTool.toolName,
  freeLine: FreeLineRoiTool.toolName,
} as const;

/** 閉じた面として扱うツール（面積・長径短径の対象）。 */
export const CLOSED_CONTOUR_TOOLS: readonly string[] = [
  CONTOUR_TOOL_NAMES.polygon,
  CONTOUR_TOOL_NAMES.freehand,
];

/** 開いた線として扱うツール（面積を出さない）。 */
export const OPEN_CONTOUR_TOOLS: readonly string[] = [
  CONTOUR_TOOL_NAMES.polyline,
  CONTOUR_TOOL_NAMES.freeLine,
];

/** スプライン Fit が効くツール（ポリゴン系のみ。フリーハンドは点が密で意味が無い）。 */
export const SPLINE_FIT_TOOLS: readonly string[] = [
  CONTOUR_TOOL_NAMES.polygon,
  CONTOUR_TOOL_NAMES.polyline,
];

/**
 * ツールを ToolGroup へ登録するときの設定。純関数（テスト対象）。
 *
 * <p>⚠ **登録は 1 回きり**（Cornerstone は 2 度目の `addTool` を警告して無視する）ので、
 * 設定はこの 1 か所で渡す。実機で「後から `addTool(name, config)` を足したが無視され、
 * ポリゴンが曲線で描かれる」を踏んだ。
 */
export function contourToolConfig(toolName: string): Record<string, unknown> {
  switch (toolName) {
    // SplineROITool の既定は CatmullRom（曲線）なので、ポリゴンには直線を明示する
    case CONTOUR_TOOL_NAMES.polygon:
    case CONTOUR_TOOL_NAMES.polyline:
      return { spline: { type: SPLINE_TYPE_LINEAR } };
    // フリーハンドは「必ず閉じる／決して閉じない」を分ける
    case CONTOUR_TOOL_NAMES.freehand:
      return { allowOpenContours: false };
    case CONTOUR_TOOL_NAMES.freeLine:
      return { allowOpenContours: true };
    default:
      return {};
  }
}

/** 輪郭系ツール（ポリゴン/フリーハンド、および Cornerstone 標準の輪郭ツール）か。純関数。 */
export function isContourTool(toolName: string): boolean {
  const t = (toolName ?? "").toLowerCase();
  return (
    CLOSED_CONTOUR_TOOLS.includes(toolName) ||
    OPEN_CONTOUR_TOOLS.includes(toolName) ||
    t.includes("freehand") ||
    t.includes("spline") ||
    t.includes("contour") ||
    t.includes("livewire")
  );
}

/** そのツールが「閉じた輪郭」を作るか。純関数（テスト対象）。 */
export function isClosedContourTool(toolName: string): boolean {
  return CLOSED_CONTOUR_TOOLS.includes(toolName);
}

/** そのツールが「開いた線」を作るか。純関数（テスト対象）。 */
export function isOpenContourTool(toolName: string): boolean {
  return OPEN_CONTOUR_TOOLS.includes(toolName);
}

/** スプライン Fit を適用できるツールか。純関数（テスト対象）。 */
export function supportsSplineFit(toolName: string): boolean {
  return SPLINE_FIT_TOOLS.includes(toolName);
}

/** スプライン Fit の状態から、Cornerstone に渡す補間方法を決める。純関数（テスト対象）。 */
export function splineTypeFor(splineFit: boolean): string {
  return splineFit ? SPLINE_CURVE : SPLINE_LINEAR;
}

/**
 * その ROI にスプライン Fit を適用できるか（ポリゴン系かつスプライン情報を持つ）。
 *
 * <p>**モードではなく ROI の属性**として扱う。描くときに決めさせると、後から
 * 「この輪郭はどっちだったか」が分からなくなるため。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canSplineFit(annotation: any): boolean {
  const tool = annotation?.metadata?.toolName as string | undefined;
  return !!tool && supportsSplineFit(tool) && !!annotation?.data?.spline;
}

/** その ROI が曲線補間になっているか。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isSplineFitted(annotation: any): boolean {
  return annotation?.data?.spline?.type === SPLINE_CURVE;
}

/** ツールグループに属さない予備インスタンス（補間インスタンスの生成にだけ使う）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const spareTools = new Map<string, any>();

/**
 * ツール名からツール実体を引く（既定の解決方法）。
 *
 * <p>まず ToolGroup を探し、**見つからなければ自前のクラスから予備インスタンスを作る**。
 * ROI の復元はツールグループの用意より先に走ることがあり、そこで解決できないと
 * 補間インスタンスを作れずに描画・当たり判定で落ちる（実機で踏んだ）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function defaultResolveTool(toolName: string): any | null {
  for (const tg of ToolGroupManager.getAllToolGroups?.() ?? []) {
    const group = tg as unknown as { getToolInstance?: (name: string) => unknown };
    const inst = group.getToolInstance?.(toolName);
    if (inst) return inst;
  }
  const spare = spareTools.get(toolName);
  if (spare) return spare;
  const Ctor =
    toolName === CONTOUR_TOOL_NAMES.polygon
      ? PolygonRoiTool
      : toolName === CONTOUR_TOOL_NAMES.polyline
        ? PolylineRoiTool
        : null;
  if (!Ctor) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inst = new (Ctor as any)({ configuration: contourToolConfig(toolName) });
    spareTools.set(toolName, inst);
    return inst;
  } catch {
    return null;
  }
}

/**
 * ROI 1 件の補間方法を切り替える。**制御点はそのまま**で、補間だけ張り替える。
 *
 * <p>補間インスタンスは**ツール自身に作らせる**（`createSplineObjectFromType`）。
 * 理由: ①`_updateSplineInstance` は既存インスタンスを使い回すので type を書くだけでは形が変わらない
 * ②インスタンスを消すだけだと、再描画前のヒットテスト（`isPointNearCurve`）が
 * undefined を触って落ちる（実機で踏んだ）。
 *
 * @returns 変更したら true（対象外・変化なしは false）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setSplineFitOn(annotation: any, enabled: boolean, resolveTool = defaultResolveTool): boolean {
  if (!canSplineFit(annotation)) return false;
  const type = splineTypeFor(enabled);
  if (annotation.data.spline.type === type) return false;
  const tool = resolveTool(annotation.metadata.toolName);
  if (typeof tool?.createSplineObjectFromType === "function") {
    // 正規の生成経路（type / instance / resolution を一式そろえてくれる）
    tool.createSplineObjectFromType(annotation, type);
  } else {
    // ツールを引けない場合でも type だけは残す（**インスタンスは消さない**。
    // 消すと次の描画までの間にヒットテストが落ちる）。
    annotation.data.spline.type = type;
  }
  annotation.invalidated = true;
  return true;
}

/**
 * 複数 ROI へのスプライン Fit のトグル。
 *
 * <p>**全部が曲線なら直線へ、そうでなければ曲線へ**（混在は曲線に揃える）。
 * 対象外（楕円・矩形・フリーハンド等）は黙って無視する。
 *
 * @returns 適用した件数と、適用後の状態（対象が無ければ `enabled: null`）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toggleSplineFit(annotations: any[]): { applied: number; enabled: boolean | null } {
  const targets = annotations.filter(canSplineFit);
  if (targets.length === 0) return { applied: 0, enabled: null };
  const enabled = !targets.every(isSplineFitted);
  let applied = 0;
  for (const ann of targets) if (setSplineFitOn(ann, enabled)) applied++;
  return { applied, enabled };
}

/** いま選択されている ROI（Cornerstone の annotation selection）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function selectedAnnotations(): any[] {
  let uids: string[] = [];
  try {
    uids = csAnnotation.selection.getAnnotationsSelected() ?? [];
  } catch {
    return [];
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const out: any[] = [];
  for (const uid of uids) {
    try {
      const ann = csAnnotation.state.getAnnotation(uid);
      if (ann) out.push(ann);
    } catch {
      // 取得できないものは無視（別ウィンドウで消えた等）
    }
  }
  return out;
}

/**
 * スプライン系ツールの ROI に**補間インスタンスを用意する**（復元直後に必ず呼ぶ）。
 *
 * <p>スプライン系のアノテーションは `data.spline = { type, instance, resolution }` を前提に
 * 描画・当たり判定が書かれている（`renderAnnotationInstance` が `type` を、
 * `isPointNearTool` が `instance` を読む）。保存形から組み立てただけの ROI は
 * **インスタンスを持たないので、復元した瞬間に描画で落ちる**（実機で踏んだ）。
 *
 * @returns 用意した（または既にあった）なら true
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ensureSplineInstance(annotation: any, resolveTool = defaultResolveTool): boolean {
  const tool = annotation?.metadata?.toolName as string | undefined;
  if (!tool || !supportsSplineFit(tool)) return false;
  if (!annotation.data) return false;
  // 輪郭の入れ物が無いと `_updateSplineInstance` が `data.contour.closed` を読んで落ちる。
  // 落ちるのは**描画ループの中**なので、以後 ROI が一切描けなくなる（実機で踏んだ）。
  if (!annotation.data.contour) {
    annotation.data.contour = { polyline: [], closed: !annotation.data.isOpenContour };
  }
  const current = annotation.data.spline;
  if (current?.instance) return true;
  const type = typeof current?.type === "string" ? current.type : SPLINE_TYPE_LINEAR;
  const instance = resolveTool(tool);
  if (typeof instance?.createSplineObjectFromType === "function") {
    instance.createSplineObjectFromType(annotation, type);
    return true;
  }
  // ツールを引けない場合でも type は残す（描画は次の機会に整う）
  annotation.data.spline = { ...(current ?? {}), type };
  return false;
}

/** UID からアノテーションを引く（見つからなければ null）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function annotationByUid(uid: string): any | null {
  try {
    return csAnnotation.state.getAnnotation(uid) ?? null;
  } catch {
    return null;
  }
}

/**
 * 画面座標（clientX/clientY）の下にある ROI を返す。無ければ null。
 *
 * <p>右クリックメニューの対象を決めるのに使う。**当たらなければ何も出さない**
 * （空きスペースの右ドラッグ Zoom を邪魔しないため）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function annotationAtClientPoint(element: HTMLDivElement, clientX: number, clientY: number): any | null {
  const rect = element.getBoundingClientRect();
  const canvasPoint: [number, number] = [clientX - rect.left, clientY - rect.top];
  try {
    return getAnnotationNearPoint(element, canvasPoint) ?? null;
  } catch {
    return null;
  }
}

/** 全ビューポートへ再描画を促す。 */
export function renderAnnotations(): void {
  for (const engine of getRenderingEngines() ?? []) {
    const ids = (engine.getViewports() ?? []).map((v: { id: string }) => v.id);
    if (ids.length) triggerAnnotationRenderForViewportIds(ids);
  }
}

/**
 * 描き終わりに輪郭を「開いたまま」へ矯正する。
 *
 * <p>Cornerstone は閉じる方向にしか寄せてくれない（spline はダブルクリックで必ず閉じ、
 * freehand は始点付近で閉じる）。開く方の 2 ツールは、終了イベントを拾って
 * `contour.closed` を落とす。**面積が出てしまうと「線を引いたのに面積が出る」ので必ず落とす**。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function forceOpenAfterFinish(tool: any): void {
  const original = tool._endCallback;
  if (typeof original !== "function") return;
  tool._endCallback = (evt: unknown, ...rest: unknown[]) => {
    const annotation = tool.editData?.annotation;
    const result = original.call(tool, evt, ...rest);
    openContour(annotation);
    return result;
  };
}

/**
 * **開いたポリラインでも統計の textBox を描かせる。**
 *
 * <p>`SplineROITool._renderStats` は先頭で `if (!data.spline.instance.closed || !visibility) return;`
 * と抜けるため、**`configuration.getTextLines` を差し替えても開いた輪郭には何も出ない**
 * （`fw/roi-stats-design.md` §4.7）。開いた線にも「線長・線上の画素統計」という測れる量が
 * あるので、閉じているかの判定だけを外した実装へ差し替える。
 *
 * <p>`_renderStats` はコンストラクタでインスタンスに代入されるアロー関数なので、
 * サブクラスのコンストラクタから差し替えられる（{@link forceOpenAfterFinish} と同じ手口）。
 *
 * <p>🔴 **上流の内部実装に依存している。** `@cornerstonejs/tools` を上げたらここが最初に壊れる。
 * 差し替えが刺さったかは `roiContourTools.test.ts` が見ている。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function forceTextBoxOnOpenContour(tool: any): boolean {
  if (typeof tool?._renderStats !== "function") return false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tool._renderStats = (annotation: any, viewport: any, svgDrawingHelper: any, textboxStyle: any) => {
    const data = annotation?.data;
    if (!data || !textboxStyle?.visibility) return;
    const textLines = tool.configuration?.getTextLines?.(data, tool.getTargetId(viewport));
    if (!textLines || textLines.length === 0) return;
    const canvasCoordinates = (data.handles?.points ?? []).map((p: number[]) => viewport.worldToCanvas(p));
    if (canvasCoordinates.length < 2) return;
    if (!data.handles.textBox.hasMoved) {
      data.handles.textBox.worldPosition = viewport.canvasToWorld(
        csDrawingUtils.getTextBoxCoordsCanvas(canvasCoordinates),
      );
    }
    const textBoxPosition = viewport.worldToCanvas(data.handles.textBox.worldPosition);
    const box = csDrawing.drawLinkedTextBox(
      svgDrawingHelper,
      annotation.annotationUID ?? "",
      "textBox",
      textLines,
      textBoxPosition,
      canvasCoordinates,
      {},
      textboxStyle,
    );
    const { x: left, y: top, width, height } = box;
    data.handles.textBox.worldBoundingBox = {
      topLeft: viewport.canvasToWorld([left, top]),
      topRight: viewport.canvasToWorld([left + width, top]),
      bottomLeft: viewport.canvasToWorld([left, top + height]),
      bottomRight: viewport.canvasToWorld([left + width, top + height]),
    };
  };
  return true;
}

/** アノテーションを開いた輪郭にする（純粋な後処理。テストから直接呼べる形にしてある）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function openContour(annotation: any): void {
  if (!annotation?.data) return;
  if (annotation.data.contour) {
    annotation.data.contour.closed = false;
    // polyline は閉じた形で作られている場合があるので、そのまま残すと面として描かれる
    if (annotation.data.spline?.instance) annotation.data.spline.instance.closed = false;
  }
  annotation.data.isOpenContour = true;
  annotation.invalidated = true;
}

// ---------------------------------------------------------------------------------------------
// 点の追加・削除 / 続きを描く / つなぐ（ポリゴン系＝SplineROITool 派生のみ）
//
// 制御点の正は `data.handles.points`（描画のたびに `contour.polyline` と補間が作り直される）。
// フリーハンド・フリーラインは点が密なので対象外。
// ---------------------------------------------------------------------------------------------

/** 点の編集（追加・削除）ができる ROI か（ポリゴン / ポリゴンライン）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function canEditPoints(annotation: any): boolean {
  const tool = annotation?.metadata?.toolName as string | undefined;
  return !!tool && supportsSplineFit(tool) && Array.isArray(annotation?.data?.handles?.points);
}

/** 開いたポリゴンライン（続きを描く・つなぐの対象）か。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isOpenPolyline(annotation: any): boolean {
  return (
    annotation?.metadata?.toolName === CONTOUR_TOOL_NAMES.polyline &&
    Array.isArray(annotation?.data?.handles?.points) &&
    annotation?.data?.contour?.closed !== true
  );
}

/** 制御点の最小数（ポリゴン 3、ポリゴンライン 2）。 */
export function minControlPoints(closed: boolean): number {
  return closed ? 3 : 2;
}

/** 点（canvas px）がハンドルに当たったとみなす距離。 */
export const POINT_HIT_PX = 10;
/** 「点を追加」で、線からこれ以上離れた位置は断る距離（canvas px）。 */
export const ADD_POINT_MAX_PX = 20;

/**
 * 折れ線上で `p` に最も近い位置を返す。閉じているときは終点→始点の辺も数える。純関数。
 * `t` は辺 `segIndex`（pts[segIndex]→pts[segIndex+1]、閉の最終辺は pts[n-1]→pts[0]）上の 0〜1。
 */
export function closestOnPolyline(
  pts: readonly (readonly number[])[],
  p: readonly number[],
  closed: boolean,
): { segIndex: number; t: number; distance: number } | null {
  const n = pts.length;
  if (n < 2) return null;
  const segCount = closed ? n : n - 1;
  let best: { segIndex: number; t: number; distance: number } | null = null;
  for (let i = 0; i < segCount; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    let dd = 0;
    let ap = 0;
    for (let k = 0; k < a.length; k++) {
      const d = b[k] - a[k];
      dd += d * d;
      ap += (p[k] - a[k]) * d;
    }
    const t = dd > 0 ? Math.min(1, Math.max(0, ap / dd)) : 0;
    let dist2 = 0;
    for (let k = 0; k < a.length; k++) {
      const q = a[k] + (b[k] - a[k]) * t;
      dist2 += (p[k] - q) * (p[k] - q);
    }
    const distance = Math.sqrt(dist2);
    if (!best || distance < best.distance) best = { segIndex: i, t, distance };
  }
  return best;
}

/** 辺 `segIndex` の `t` の位置に点を挿入した新しい配列。純関数。 */
export function insertPointAt(pts: readonly number[][], segIndex: number, t: number): number[][] {
  const n = pts.length;
  const a = pts[segIndex];
  const b = pts[(segIndex + 1) % n];
  const q = a.map((v, k) => v + (b[k] - v) * t);
  const out = pts.map((x) => [...x]);
  out.splice(segIndex + 1, 0, q);
  return out;
}

/** `index` の点を除いた新しい配列。最小点数を下回るときは null。純関数。 */
export function removePointAt(pts: readonly number[][], index: number, closed: boolean): number[][] | null {
  if (index < 0 || index >= pts.length) return null;
  if (pts.length - 1 < minControlPoints(closed)) return null;
  return pts.filter((_, i) => i !== index).map((x) => [...x]);
}

/** `p` に最も近い点の番号（`maxDist` 以内。無ければ -1）。純関数。 */
export function nearestPointIndex(pts: readonly (readonly number[])[], p: readonly number[], maxDist: number): number {
  let best = -1;
  let bestD = maxDist;
  for (let i = 0; i < pts.length; i++) {
    let d2 = 0;
    for (let k = 0; k < p.length; k++) d2 += (pts[i][k] - p[k]) * (pts[i][k] - p[k]);
    const d = Math.sqrt(d2);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * 開いた折れ線 2 本を 1 本につなぐ。純関数。
 * 4 通りの端点距離（a 始/終 × b 始/終）で最も近い組を選び、a→b の順に向きをそろえて連結する。
 * 接する 2 点が同じ位置なら 1 点にまとめる。
 */
export function mergeOpenPolylines(a: readonly number[][], b: readonly number[][]): number[][] {
  const dist = (p: readonly number[], q: readonly number[]) => Math.hypot(...p.map((v, k) => v - q[k]));
  const aEnd = a[a.length - 1];
  const bEnd = b[b.length - 1];
  const cands = [
    { d: dist(aEnd, b[0]), flipA: false, flipB: false },
    { d: dist(aEnd, bEnd), flipA: false, flipB: true },
    { d: dist(a[0], b[0]), flipA: true, flipB: false },
    { d: dist(a[0], bEnd), flipA: true, flipB: true },
  ];
  const best = cands.reduce((m, c) => (c.d < m.d ? c : m));
  const aa = (best.flipA ? [...a].reverse() : [...a]).map((x) => [...x]);
  const bb = (best.flipB ? [...b].reverse() : [...b]).map((x) => [...x]);
  if (best.d === 0) bb.shift();
  return [...aa, ...bb];
}

function viewportOf(element: HTMLDivElement) {
  return getEnabledElement(element)?.viewport ?? null;
}

/** 点の編集の結果。ok 以外は画面に理由を出す。 */
export type PointEditResult = "ok" | "unsupported" | "far" | "noHandle" | "min";

/** 変更を元に戻せるよう、注釈メモで挟んで制御点を差し替える。 */
function replaceControlPoints(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotation: any,
  element: HTMLDivElement,
  points: number[][],
): void {
  const tool = defaultResolveTool(annotation.metadata.toolName);
  try {
    AnnotationTool.createAnnotationMemo(element, annotation);
  } catch {
    // メモを作れなくても編集は進める（元に戻せないだけ）
  }
  annotation.data.handles.points = points;
  annotation.invalidated = true;
  try {
    tool?.doneEditMemo?.();
  } catch {
    // 同上
  }
  renderAnnotations();
}

/** 画面座標を、要素内の canvas 座標へ。 */
function clientToCanvas(element: HTMLDivElement, clientX: number, clientY: number): [number, number] {
  const rect = element.getBoundingClientRect();
  return [clientX - rect.left, clientY - rect.top];
}

/** 制御点を canvas 座標へ写す。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function controlPointsOnCanvas(annotation: any, vp: NonNullable<ReturnType<typeof viewportOf>>): number[][] {
  return (annotation.data.handles.points as number[][]).map(
    (w) => vp.worldToCanvas(w as [number, number, number]) as number[],
  );
}

/** クリック位置（画面座標）に最も近い辺上へ制御点を足す。 */
export function addPolygonPoint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotation: any,
  element: HTMLDivElement,
  clientX: number,
  clientY: number,
): PointEditResult {
  if (!canEditPoints(annotation)) return "unsupported";
  const vp = viewportOf(element);
  if (!vp) return "unsupported";
  const closed = annotation.data.contour?.closed === true;
  const hit = closestOnPolyline(
    controlPointsOnCanvas(annotation, vp),
    clientToCanvas(element, clientX, clientY),
    closed,
  );
  if (!hit || hit.distance > ADD_POINT_MAX_PX) return "far";
  replaceControlPoints(annotation, element, insertPointAt(annotation.data.handles.points, hit.segIndex, hit.t));
  return "ok";
}

/** クリック位置（画面座標）の下にある制御点を消す。 */
export function removePolygonPoint(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotation: any,
  element: HTMLDivElement,
  clientX: number,
  clientY: number,
): PointEditResult {
  if (!canEditPoints(annotation)) return "unsupported";
  const vp = viewportOf(element);
  if (!vp) return "unsupported";
  const closed = annotation.data.contour?.closed === true;
  const index = nearestPointIndex(
    controlPointsOnCanvas(annotation, vp),
    clientToCanvas(element, clientX, clientY),
    POINT_HIT_PX,
  );
  if (index < 0) return "noHandle";
  const next = removePointAt(annotation.data.handles.points, index, closed);
  if (!next) return "min";
  replaceControlPoints(annotation, element, next);
  return "ok";
}

/** 右クリック位置の下に制御点があるか（メニューの「この点を削除」の有効判定）。 */
export function hasPointAt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  annotation: any,
  element: HTMLDivElement,
  clientX: number,
  clientY: number,
): boolean {
  if (!canEditPoints(annotation)) return false;
  const vp = viewportOf(element);
  if (!vp) return false;
  return (
    nearestPointIndex(controlPointsOnCanvas(annotation, vp), clientToCanvas(element, clientX, clientY), POINT_HIT_PX) >= 0
  );
}

/**
 * 確定済みの開いたポリゴンラインを、末尾から描き継ぐ。
 *
 * <p>スプラインツール自身の描画状態を立て直す（`editData` / `isDrawing` / `_activateDraw`）。
 * 以後のクリックは `handles.points` の末尾へ足され、ダブルクリックで再び確定する
 * （確定後は {@link forceOpenAfterFinish} が開いたままに戻す）。
 * 🔴 上流の private メソッドに依存する（`@cornerstonejs/tools` を上げたらここを確認）。
 *
 * @returns 描画を再開できたら true
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function continuePolyline(annotation: any, element: HTMLDivElement): boolean {
  if (!isOpenPolyline(annotation)) return false;
  const vp = viewportOf(element);
  const tool = defaultResolveTool(annotation.metadata.toolName);
  if (!vp || typeof tool?._activateDraw !== "function") return false;
  if (tool.isDrawing) return false;
  tool.editData = { annotation, viewportIdsToRender: [vp.id], newAnnotation: false };
  tool.isDrawing = true;
  annotation.highlighted = true;
  tool._activateDraw(element);
  renderAnnotations();
  return true;
}

/** つなぐの結果。 */
export type JoinResult = "ok" | "count" | "kind" | "image";

/**
 * 選択中の開いたポリゴンライン 2 本を 1 本につなぐ。1 本目へ点を集め、2 本目は消す。
 * 同じ画像上の 2 本だけ。フリーラインなど別の種類が混じるときは断る。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function joinPolylines(annotations: any[]): JoinResult {
  if (annotations.length !== 2) return "count";
  const [a, b] = annotations;
  if (!isOpenPolyline(a) || !isOpenPolyline(b)) return "kind";
  if (a.metadata?.referencedImageId !== b.metadata?.referencedImageId) return "image";
  a.data.handles.points = mergeOpenPolylines(a.data.handles.points, b.data.handles.points);
  a.invalidated = true;
  csAnnotation.state.removeAnnotation(b.annotationUID);
  renderAnnotations();
  return "ok";
}
