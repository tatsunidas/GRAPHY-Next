/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Portable 2D Viewer — Cornerstone3D StackViewport の薄いラッパ。
// 本体 viewer（frontend/src/viewer）とは独立した最小構成: 単一シリーズを StackViewport で表示し、
// W/L・スタック送り・Zoom/Pan・Reset を提供する。ローカル File は dicom-image-loader の
// fileManager.add() で `dicomfile:` imageId 化して読む（サーバ不要）。
import { RenderingEngine, Enums, eventTarget, init as coreInit, type Types } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  Enums as ToolEnums,
} from "@cornerstonejs/tools";
import type { ImageRec } from "./dicomdir";

const { ViewportType } = Enums;
const { MouseBindings } = ToolEnums;

const ENGINE_ID = "portable-engine";
const VIEWPORT_ID = "portable-viewport";
const TOOLGROUP_ID = "portable-toolgroup";

export interface OverlayInfo {
  imageIndex: number;
  imageCount: number;
  windowWidth: number;
  windowCenter: number;
  zoom: number;
}

let initPromise: Promise<void> | null = null;

/** 冪等な初期化（core + dicom-image-loader + tools）。 */
export function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      await coreInit();
      const maxWebWorkers = Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
      dicomImageLoader.init({ maxWebWorkers });
      toolsInit();
      addTool(WindowLevelTool);
      addTool(PanTool);
      addTool(ZoomTool);
      addTool(StackScrollTool);
    })();
  }
  return initPromise;
}

export class PortableViewer {
  private engine: RenderingEngine | null = null;
  private element: HTMLDivElement;
  private onOverlay: (info: OverlayInfo) => void;
  private imageCount = 0;
  private boundRefresh: () => void;

  constructor(element: HTMLDivElement, onOverlay: (info: OverlayInfo) => void) {
    this.element = element;
    this.onOverlay = onOverlay;
    this.boundRefresh = () => this.emitOverlay();
  }

  async setup(): Promise<void> {
    await ensureInit();
    this.engine = new RenderingEngine(ENGINE_ID);
    this.engine.enableElement({
      viewportId: VIEWPORT_ID,
      type: ViewportType.STACK,
      element: this.element,
    });

    // ツールグループ: W/L(左)・Pan(中)・Zoom(右)・スタック送り(ホイール)。
    let group = ToolGroupManager.getToolGroup(TOOLGROUP_ID);
    if (!group) {
      group = ToolGroupManager.createToolGroup(TOOLGROUP_ID)!;
      group.addTool(WindowLevelTool.toolName);
      group.addTool(PanTool.toolName);
      group.addTool(ZoomTool.toolName);
      group.addTool(StackScrollTool.toolName);
      group.setToolActive(WindowLevelTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Primary }],
      });
      group.setToolActive(PanTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Auxiliary }],
      });
      group.setToolActive(ZoomTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Secondary }],
      });
      group.setToolActive(StackScrollTool.toolName, {
        bindings: [{ mouseButton: MouseBindings.Wheel }],
      });
    }
    group.addViewport(VIEWPORT_ID, ENGINE_ID);

    // オーバレイ更新: 画像描画・W/L 変更・スタック送りで。
    this.element.addEventListener(Enums.Events.IMAGE_RENDERED, this.boundRefresh);
    eventTarget.addEventListener(Enums.Events.STACK_NEW_IMAGE, this.boundRefresh);
    eventTarget.addEventListener(Enums.Events.VOI_MODIFIED, this.boundRefresh);
  }

  /** 1 シリーズの画像を表示する。File を dicomfile: imageId 化して StackViewport に流す。 */
  async showSeries(images: ImageRec[]): Promise<void> {
    if (!this.engine) throw new Error("setup() を先に呼んでください");
    const imageIds = images
      .filter((im) => im.file)
      .map((im) => dicomImageLoader.wadouri.fileManager.add(im.file!));
    this.imageCount = imageIds.length;
    const vp = this.engine.getViewport(VIEWPORT_ID) as Types.IStackViewport;
    if (imageIds.length === 0) {
      throw new Error("表示できるファイルがありません（DICOMDIR の参照先が見つかりません）");
    }
    await vp.setStack(imageIds, 0);
    vp.resetCamera();
    vp.render();
    this.emitOverlay();
  }

  resetView(): void {
    if (!this.engine) return;
    const vp = this.engine.getViewport(VIEWPORT_ID) as Types.IStackViewport;
    vp.resetCamera();
    vp.resetProperties();
    vp.render();
    this.emitOverlay();
  }

  resize(): void {
    this.engine?.resize(true, false);
  }

  private emitOverlay(): void {
    if (!this.engine) return;
    const vp = this.engine.getViewport(VIEWPORT_ID) as Types.IStackViewport;
    if (!vp) return;
    const voi = vp.getProperties().voiRange;
    let ww = 0;
    let wc = 0;
    if (voi) {
      ww = voi.upper - voi.lower;
      wc = (voi.upper + voi.lower) / 2;
    }
    const zoom = vp.getZoom ? vp.getZoom() : 1;
    this.onOverlay({
      imageIndex: vp.getCurrentImageIdIndex(),
      imageCount: this.imageCount,
      windowWidth: Math.round(ww),
      windowCenter: Math.round(wc),
      zoom: Math.round(zoom * 100) / 100,
    });
  }

  destroy(): void {
    this.element.removeEventListener(Enums.Events.IMAGE_RENDERED, this.boundRefresh);
    eventTarget.removeEventListener(Enums.Events.STACK_NEW_IMAGE, this.boundRefresh);
    eventTarget.removeEventListener(Enums.Events.VOI_MODIFIED, this.boundRefresh);
    this.engine?.destroy();
    this.engine = null;
  }
}
