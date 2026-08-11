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
 * <p>**スプライン Fit** は、ポリゴン系（閉・開の両方）の補間方法を直線 ↔ Catmull-Rom で切り替える。
 * 新規に描くものへ効くのに加え、**既にある輪郭も変換できる**（同じ制御点のまま曲線に張り替える）。
 */
import {
  PlanarFreehandROITool,
  SplineROITool,
  ToolGroupManager,
  annotation as csAnnotation,
} from "@cornerstonejs/tools";
import { triggerAnnotationRenderForViewportIds } from "@cornerstonejs/tools/utilities";
import { getRenderingEngines } from "@cornerstonejs/core";

/** 直線補間（＝ポリゴン）。Cornerstone の `SplineTypesEnum.Linear` と同じ値。 */
const SPLINE_LINEAR = "LINEAR";
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

let splineFitEnabled = false;

/** スプライン Fit が有効か。 */
export function isSplineFit(): boolean {
  return splineFitEnabled;
}

/**
 * スプライン Fit を切り替える。
 *
 * @param enabled  true で曲線補間（Catmull-Rom）、false で直線（ポリゴン）
 * @param applyToExisting 既にある**ポリゴン系の輪郭**も張り替えるか（既定 true）
 */
export function setSplineFit(enabled: boolean, applyToExisting = true): void {
  splineFitEnabled = enabled;
  const type = splineTypeFor(enabled);

  // これから描くもの: 各ツールグループの設定を更新する
  for (const id of ToolGroupManager.getAllToolGroups?.() ?? []) {
    const tg = id as unknown as {
      setToolConfiguration?: (name: string, config: unknown, overwrite?: boolean) => void;
      getToolInstance?: (name: string) => unknown;
    };
    for (const name of SPLINE_FIT_TOOLS) {
      if (!tg.getToolInstance?.(name)) continue;
      tg.setToolConfiguration?.(name, { spline: { type } }, false);
    }
  }

  if (applyToExisting) applySplineFitToExisting(type);
}

/** 既存のポリゴン系アノテーションを張り替える（制御点はそのまま）。 */
function applySplineFitToExisting(type: string): void {
  let changed = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let all: any[] = [];
  try {
    all = csAnnotation.state.getAllAnnotations() as unknown[] as any[];
  } catch {
    return;
  }
  for (const ann of all) {
    const tool = ann?.metadata?.toolName as string | undefined;
    if (!tool || !supportsSplineFit(tool)) continue;
    if (!ann.data?.spline) continue;
    ann.data.spline.type = type;
    // インスタンスは type から作り直させる（残っていると古いクラスで描かれる）
    delete ann.data.spline.instance;
    ann.invalidated = true;
    changed = true;
  }
  if (!changed) return;
  for (const engine of getRenderingEngines() ?? []) {
    const viewports = engine.getViewports() ?? [];
    const ids = viewports.map((v: { id: string }) => v.id);
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
