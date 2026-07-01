/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 2D Wand（輝度ベースの単一スライス flood fill）。GRAPHY の 2D Wand（ImageJ Wand）相当。
 *
 * Cornerstone3D は growCut ベースの領域成長（`RegionSegment(Plus)Tool`）を持つが **3D 専用**で、
 * `PaintFillTool` は labelmap の bucket fill（輝度非依存）。単一スライスの輝度 flood は既製が無いため自作する。
 *
 * 実装: クリック地点をシードに、現在スライスの **source 画素輝度**が「シード値 ± トレランス」に収まる連結画素を
 * `utilities.segmentation.floodFill`（PaintFill と同じ探索器）で 2D 走査し、アクティブマスクの
 * アクティブ segment index に書き込む。設計 `fw/segmentation-tools-design.md`（P2）。
 */
import { getEnabledElement, cache, metaData, utilities as csUtils } from "@cornerstonejs/core";
import { BaseTool, segmentation as csSeg, utilities as csToolsUtilities } from "@cornerstonejs/tools";
import { getSegEditTarget } from "./roiMaskStore";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyObj = Record<string, any>;
const floodFill = (csToolsUtilities as AnyObj).segmentation.floodFill as (
  getter: (x: number, y: number) => number,
  seed: [number, number],
  options: AnyObj,
) => { flooded: [number, number][] };

const DEFAULT_THRESHOLD = 50;

export class Wand2DTool extends BaseTool {
  static toolName = "GraphyWand2D";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(props: AnyObj = {}) {
    super(props, {
      supportedInteractionTypes: ["Mouse"],
      configuration: { threshold: DEFAULT_THRESHOLD, diagonals: true },
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async preMouseDownCallback(evt: AnyObj): Promise<boolean> {
    const { element, currentPoints } = evt.detail;
    const world = currentPoints.world as [number, number, number];
    try {
      const { viewport } = getEnabledElement(element) as AnyObj;
      this.flood(viewport, world);
    } catch (e) {
      console.warn("[wand2d] flood failed", e);
    }
    return true; // クリック確定（ドラッグ無し）でイベント消費。
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private flood(viewport: AnyObj, world: [number, number, number]): void {
    const target = getSegEditTarget();
    if (!target.segmentationId) return;
    const segId = target.segmentationId;
    const segIndex = target.segmentIndex || 1;

    const refImageId: string | undefined = viewport.getCurrentImageId?.();
    if (!refImageId) return;
    const srcImg = cache.getImage(refImageId) as AnyObj | undefined;
    if (!srcImg) return;
    const px = srcImg.getPixelData() as ArrayLike<number>;
    const plane: AnyObj = metaData.get("imagePlaneModule", refImageId) ?? {};
    const cols = Number(srcImg.columns ?? plane.columns);
    const rows = Number(srcImg.rows ?? plane.rows);
    if (!cols || !rows) return;

    // シード画素（worldToImageCoords は [x=列, y=行] を返す）。
    const ic = csUtils.worldToImageCoords(refImageId, world) as [number, number] | undefined;
    if (!ic) return;
    const sx = Math.round(ic[0]);
    const sy = Math.round(ic[1]);
    if (sx < 0 || sy < 0 || sx >= cols || sy >= rows) return;

    // 対象スライスの labelmap 画像（source スタックと同順）。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const labelmapIds = (csSeg as any).getLabelmapImageIds?.(segId) as string[] | undefined;
    if (!labelmapIds?.length) return;
    const stack = (viewport.getImageIds?.() as string[] | undefined) ?? [];
    const z = stack.indexOf(refImageId);
    if (z < 0 || z >= labelmapIds.length) return;
    const lmImg = cache.getImage(labelmapIds[z]) as AnyObj | undefined;
    const vm = lmImg?.voxelManager;
    if (!vm) return;

    // floodFill は seed の値（startNode）を内部で取得し equals(node, startNode) で判定するため、
    // ここで seed 値を別途保持する必要はない。
    const tol = Number(this.configuration.threshold ?? DEFAULT_THRESHOLD);
    const result = floodFill(
      (x: number, y: number) => px[y * cols + x] as number,
      [sx, sy],
      {
        diagonals: this.configuration.diagonals !== false,
        // 範囲外を除外（filter は false で近傍をスキップ）。
        filter: (args: number[]) => {
          const [x, y] = args;
          return x >= 0 && x < cols && y >= 0 && y < rows;
        },
        // シード値 ± トレランス内で連結。
        equals: (a: number, b: number) => Math.abs(a - b) <= tol,
      },
    );
    for (const [x, y] of result.flooded) vm.setAtIndex(y * cols + x, segIndex);
    csSeg.triggerSegmentationEvents.triggerSegmentationDataModified(segId, [z], segIndex);
  }
}
