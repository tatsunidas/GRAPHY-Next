/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Portable 2D Viewer マネージャ — 共有 RenderingEngine ＋共有 ToolGroup を持ち、
// 1×1 / 2×1 / 2×2 のタイルレイアウトで複数の ViewportPanel を並べる（P4.4）。
// W/L・トランスフォーム・スライス送り・PNG はアクティブなタイルへ委譲。計測ツールは
// 共有 ToolGroup 経由で「ドラッグしたタイル」に効く。ローカル File は dicom-image-loader の
// fileManager.add() で `dicomfile:` imageId 化して読む（サーバ不要）。
import { RenderingEngine, init as coreInit } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  LengthTool,
  AngleTool,
  EllipticalROITool,
  RectangleROITool,
  ProbeTool,
  annotation,
  Enums as ToolEnums,
} from "@cornerstonejs/tools";
import type { ImageRec } from "./dicomdir";
import { ViewportPanel } from "./panel";

export type { WindowLevel } from "./panel";

const { MouseBindings } = ToolEnums;

const ENGINE_ID = "portable-engine";
const TOOLGROUP_ID = "portable-toolgroup";

/** レイアウト定義（行×列）。 */
export interface Layout {
  rows: number;
  cols: number;
}
export const LAYOUTS: Record<string, Layout> = {
  "1x1": { rows: 1, cols: 1 },
  "2x1": { rows: 1, cols: 2 },
  "2x2": { rows: 2, cols: 2 },
};

/** 左ドラッグに割り当てられる計測ツール名（"" = W/L に戻す）。 */
export const MEASURE_TOOLS = [
  LengthTool.toolName,
  AngleTool.toolName,
  EllipticalROITool.toolName,
  RectangleROITool.toolName,
  ProbeTool.toolName,
];

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
      addTool(LengthTool);
      addTool(AngleTool);
      addTool(EllipticalROITool);
      addTool(RectangleROITool);
      addTool(ProbeTool);
    })();
  }
  return initPromise;
}

export class PortableViewer {
  private engine: RenderingEngine | null = null;
  private grid: HTMLElement;
  private panels: ViewportPanel[] = [];
  private activeIndex = 0;
  private layout: Layout = LAYOUTS["1x1"];
  private nextVpSeq = 0;
  /** 各タイルへ最後に割当てたシリーズ画像（レイアウト変更時の再表示用）。 */
  private panelImages: (ImageRec[] | null)[] = [];
  private measureTool = "";
  /** アクティブタイルの状態変化（画像/W-L/カメラ）を UI へ伝えるコールバック。 */
  onChange: (() => void) | null = null;
  /** アクティブタイルが切り替わったときのコールバック。 */
  onActiveChange: (() => void) | null = null;

  constructor(grid: HTMLElement) {
    this.grid = grid;
  }

  async setup(): Promise<void> {
    await ensureInit();
    this.engine = new RenderingEngine(ENGINE_ID);
    this.ensureToolGroup();
    await this.setLayout(LAYOUTS["1x1"]);
  }

  private ensureToolGroup(): void {
    let group = ToolGroupManager.getToolGroup(TOOLGROUP_ID);
    if (group) return;
    group = ToolGroupManager.createToolGroup(TOOLGROUP_ID)!;
    group.addTool(WindowLevelTool.toolName);
    group.addTool(PanTool.toolName);
    group.addTool(ZoomTool.toolName);
    group.addTool(StackScrollTool.toolName);
    for (const tn of MEASURE_TOOLS) {
      group.addTool(tn);
      group.setToolPassive(tn);
    }
    group.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
    group.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    group.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    group.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] });
  }

  private group() {
    return ToolGroupManager.getToolGroup(TOOLGROUP_ID);
  }

  // ── レイアウト ────────────────────────────────────────────────────────
  currentLayout(): Layout {
    return this.layout;
  }

  /** タイルレイアウトを切替（既存タイルのシリーズ割当は可能な範囲で引き継ぐ）。 */
  async setLayout(layout: Layout): Promise<void> {
    if (!this.engine) return;
    const group = this.group();
    // 既存タイルを片付け（割当画像は保持済み）。
    const preserved = this.panelImages.slice();
    for (const p of this.panels) {
      group?.removeViewports(ENGINE_ID, p.viewportId);
      p.destroy();
    }
    this.panels = [];

    this.layout = layout;
    this.grid.style.setProperty("--rows", String(layout.rows));
    this.grid.style.setProperty("--cols", String(layout.cols));

    const count = layout.rows * layout.cols;
    for (let i = 0; i < count; i++) {
      const vpId = `portable-vp-${this.nextVpSeq++}`;
      const panel = new ViewportPanel(this.engine, vpId, this.grid);
      panel.onChange = () => this.onChange?.();
      panel.root.addEventListener("pointerdown", () => this.setActiveIndex(i));
      group?.addViewport(vpId, ENGINE_ID);
      this.panels.push(panel);
    }
    this.panelImages = new Array(count).fill(null);
    this.activeIndex = 0;
    this.applyActiveHighlight();

    // 割当済みシリーズを新レイアウトへ再表示（先頭から min(旧,新) 枚）。
    await this.restore(preserved);
  }

  private async restore(preserved: (ImageRec[] | null)[]): Promise<void> {
    for (let i = 0; i < this.panels.length && i < preserved.length; i++) {
      const imgs = preserved[i];
      if (imgs && imgs.length) {
        try {
          await this.panels[i].showSeries(imgs);
          this.panelImages[i] = imgs;
        } catch {
          /* ignore */
        }
      }
    }
  }

  // ── アクティブタイル ──────────────────────────────────────────────────
  private applyActiveHighlight(): void {
    this.panels.forEach((p, i) => p.setActive(i === this.activeIndex && this.panels.length > 1));
  }

  setActiveIndex(i: number): void {
    if (i < 0 || i >= this.panels.length || i === this.activeIndex) {
      if (i === this.activeIndex) return;
    }
    this.activeIndex = Math.max(0, Math.min(this.panels.length - 1, i));
    this.applyActiveHighlight();
    this.onActiveChange?.();
  }

  active(): ViewportPanel | null {
    return this.panels[this.activeIndex] ?? null;
  }

  panelCount(): number {
    return this.panels.length;
  }

  // ── シリーズ表示 ──────────────────────────────────────────────────────
  /** アクティブタイルにシリーズを表示する。 */
  async showSeriesInActive(images: ImageRec[]): Promise<void> {
    const panel = this.active();
    if (!panel) return;
    await panel.showSeries(images);
    this.panelImages[this.activeIndex] = images;
  }

  // ── 計測（共有 ToolGroup） ────────────────────────────────────────────
  setMeasureTool(toolName: string): void {
    const group = this.group();
    if (!group) return;
    const measure = MEASURE_TOOLS.includes(toolName) ? toolName : "";
    this.measureTool = measure;
    for (const tn of MEASURE_TOOLS) {
      if (tn !== measure) group.setToolPassive(tn);
    }
    if (measure) {
      group.setToolPassive(WindowLevelTool.toolName);
      group.setToolActive(measure, { bindings: [{ mouseButton: MouseBindings.Primary }] });
    } else {
      group.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
    }
  }

  currentMeasureTool(): string {
    return this.measureTool;
  }

  clearAnnotations(): void {
    annotation.state.removeAllAnnotations();
    this.panels.forEach((p) => p.render());
  }

  deleteSelected(): number {
    const sel = annotation.selection.getAnnotationsSelected();
    for (const uid of sel) {
      try {
        annotation.state.removeAnnotation(uid);
      } catch {
        /* ignore */
      }
    }
    if (sel.length) this.panels.forEach((p) => p.render());
    return sel.length;
  }

  resize(): void {
    this.engine?.resize(true, false);
    this.panels.forEach((p) => p.refresh());
  }

  destroy(): void {
    for (const p of this.panels) p.destroy();
    this.panels = [];
    this.engine?.destroy();
    this.engine = null;
  }
}
