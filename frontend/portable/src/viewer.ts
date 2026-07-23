/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Portable 2D Viewer — Cornerstone3D StackViewport の薄いラッパ。
// 本体 viewer（frontend/src/viewer）とは独立した最小構成: 単一シリーズを StackViewport で表示し、
// W/L・スタック送り・Zoom/Pan・回転/反転/諧調反転・Fit/実寸・4 隅オーバレイ・スケールバーを提供する。
// ローカル File は dicom-image-loader の fileManager.add() で `dicomfile:` imageId 化して読む（サーバ不要）。
import { RenderingEngine, Enums, eventTarget, metaData, init as coreInit, type Types } from "@cornerstonejs/core";
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
import { resolveOverlay, isCalibrated, pixelSpacingColumn } from "./overlay";
import { computeScaleBar } from "./scalebar";
import { applyTransform, readTransform, FIT_TRANSFORM } from "./transform";

const { ViewportType } = Enums;
const { MouseBindings } = ToolEnums;

const ENGINE_ID = "portable-engine";
const VIEWPORT_ID = "portable-viewport";
const TOOLGROUP_ID = "portable-toolgroup";

/** 画像上オーバレイ／スケールバーの DOM 参照一式。 */
export interface ViewerElements {
  viewport: HTMLDivElement;
  overlayTL: HTMLElement;
  overlayTR: HTMLElement;
  overlayBL: HTMLElement;
  overlayBR: HTMLElement;
  scalebarBar: HTMLElement;
  scalebarLabel: HTMLElement;
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

/** 現在の W/L（ウィンドウ中心/幅）。 */
export interface WindowLevel {
  center: number;
  width: number;
}

export class PortableViewer {
  private engine: RenderingEngine | null = null;
  private els: ViewerElements;
  private imageCount = 0;
  private boundRefresh: () => void;
  /** 画像・W/L・カメラ変更時に UI（スライダ/入力欄）を同期させる外部コールバック。 */
  onChange: (() => void) | null = null;

  constructor(els: ViewerElements) {
    this.els = els;
    this.boundRefresh = () => {
      this.emitOverlay();
      this.onChange?.();
    };
  }

  async setup(): Promise<void> {
    await ensureInit();
    this.engine = new RenderingEngine(ENGINE_ID);
    this.engine.enableElement({
      viewportId: VIEWPORT_ID,
      type: ViewportType.STACK,
      element: this.els.viewport,
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

    // オーバレイ更新: 画像描画・W/L 変更・スタック送り・カメラ変更で。
    this.els.viewport.addEventListener(Enums.Events.IMAGE_RENDERED, this.boundRefresh);
    eventTarget.addEventListener(Enums.Events.STACK_NEW_IMAGE, this.boundRefresh);
    eventTarget.addEventListener(Enums.Events.VOI_MODIFIED, this.boundRefresh);
    eventTarget.addEventListener(Enums.Events.CAMERA_MODIFIED, this.boundRefresh);
  }

  /** 1 シリーズの画像を表示する。File を dicomfile: imageId 化して StackViewport に流す。 */
  async showSeries(images: ImageRec[]): Promise<void> {
    const vp = this.viewport();
    const imageIds = images
      .filter((im) => im.file)
      .map((im) => dicomImageLoader.wadouri.fileManager.add(im.file!));
    this.imageCount = imageIds.length;
    if (imageIds.length === 0) {
      throw new Error("表示できるファイルがありません（DICOMDIR の参照先が見つかりません）");
    }
    await vp.setStack(imageIds, 0);
    vp.resetCamera();
    vp.render();
    this.emitOverlay();
  }

  /** 表示を完全リセット（カメラ＋W/L＋変換）。 */
  resetView(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    vp.resetCamera();
    vp.resetProperties();
    vp.render();
    this.emitOverlay();
  }

  /** ウィンドウに合わせる（zoom/pan/回転/反転を Fit へ。W/L は保持）。 */
  fit(): void {
    if (!this.engine) return;
    applyTransform(this.viewport(), FIT_TRANSFORM);
    this.emitOverlay();
  }

  /** 実寸（1 CSS px = 1 画像 px）。 */
  actualSize(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    const el = this.els.viewport;
    const y = el.clientHeight / 2;
    const p0 = vp.canvasToWorld([0, y]);
    const p1 = vp.canvasToWorld([1, y]);
    const worldPerPx = Math.hypot(p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]);
    const spacing = pixelSpacingColumn(vp.getCurrentImageId());
    if (!(worldPerPx > 0) || !(spacing > 0)) return;
    const cur = readTransform(vp).zoom;
    applyTransform(vp, { zoom: cur * (worldPerPx / spacing) });
    this.emitOverlay();
  }

  rotate90(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    applyTransform(vp, { rotation: (readTransform(vp).rotation + 90) % 360 });
    this.emitOverlay();
  }

  flipH(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    applyTransform(vp, { flipHorizontal: !readTransform(vp).flipHorizontal });
    this.emitOverlay();
  }

  flipV(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    applyTransform(vp, { flipVertical: !readTransform(vp).flipVertical });
    this.emitOverlay();
  }

  /** 諧調反転（白黒反転）トグル。 */
  invert(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    const cur = vp.getProperties().invert ?? false;
    vp.setProperties({ invert: !cur });
    vp.render();
    this.emitOverlay();
  }

  // ── W/L ─────────────────────────────────────────────────────────────────
  /** W/L を設定（center/width → voiRange）。 */
  setWL(center: number, width: number): void {
    if (!this.engine || !Number.isFinite(center) || !(width > 0)) return;
    const vp = this.viewport();
    const half = width / 2;
    vp.setProperties({ voiRange: { lower: center - half, upper: center + half } });
    vp.render();
    this.emitOverlay();
  }

  /** 現在の W/L を返す（未設定なら null）。 */
  getWL(): WindowLevel | null {
    if (!this.engine) return null;
    const voi = this.viewport().getProperties().voiRange;
    if (!voi) return null;
    return { center: Math.round((voi.upper + voi.lower) / 2), width: Math.round(voi.upper - voi.lower) };
  }

  /** 既定（DICOM の WindowCenter/Width）に戻す。無ければ resetProperties。 */
  defaultWL(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    const imageId = vp.getCurrentImageId();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const voi = imageId ? (metaData.get("voiLutModule", imageId) as any) : null;
    let wc = voi?.windowCenter;
    let ww = voi?.windowWidth;
    if (Array.isArray(wc)) wc = wc[0];
    if (Array.isArray(ww)) ww = ww[0];
    if (Number.isFinite(wc) && ww > 0) {
      this.setWL(Number(wc), Number(ww));
    } else {
      vp.resetProperties();
      vp.render();
      this.emitOverlay();
    }
  }

  // ── スライス送り ─────────────────────────────────────────────────────────
  imageIndex(): number {
    return this.engine ? this.viewport().getCurrentImageIdIndex() : 0;
  }

  imageTotal(): number {
    return this.imageCount;
  }

  /** インデックス指定でスライスを表示（範囲外はクランプ）。 */
  async setImageIndex(index: number): Promise<void> {
    if (!this.engine || this.imageCount === 0) return;
    const i = Math.max(0, Math.min(this.imageCount - 1, Math.round(index)));
    if (i === this.viewport().getCurrentImageIdIndex()) return;
    await this.viewport().setImageIdIndex(i);
  }

  // ── PNG 保存 ─────────────────────────────────────────────────────────────
  /** 現在ビューを PNG で保存（オーバレイ／スケールバー焼き込み）。 */
  savePng(filename: string): void {
    if (!this.engine) return;
    const vp = this.viewport();
    const src = vp.getCanvas();
    if (!src) return;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(src, 0, 0);
    this.burnOverlays(ctx, src.width / this.els.viewport.clientWidth);
    out.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  }

  /** オーバレイ4隅とスケールバーを出力 canvas に描画（scale = デバイスpx/CSSpx）。 */
  private burnOverlays(ctx: CanvasRenderingContext2D, scale: number): void {
    const W = ctx.canvas.width;
    const H = ctx.canvas.height;
    const pad = 10 * scale;
    const fs = 12 * scale;
    ctx.font = `${fs}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textBaseline = "top";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 3 * scale;
    ctx.fillStyle = "#d9f000";
    const draw = (text: string, x: number, top: boolean, right: boolean) => {
      if (!text) return;
      const lines = text.split("\n");
      ctx.textAlign = right ? "right" : "left";
      lines.forEach((ln, i) => {
        const y = top ? pad + i * fs * 1.4 : H - pad - (lines.length - i) * fs * 1.4;
        ctx.fillText(ln, x, y);
      });
    };
    draw(this.els.overlayTL.textContent ?? "", pad, true, false);
    draw(this.els.overlayTR.textContent ?? "", W - pad, true, true);
    draw(this.els.overlayBL.textContent ?? "", pad, false, false);
    draw(this.els.overlayBR.textContent ?? "", W - pad, false, true);
    // スケールバー（下辺中央）。
    if (this.els.scalebarBar.style.display !== "none") {
      const barCssPx = parseFloat(this.els.scalebarBar.style.width) || 0;
      const barPx = barCssPx * scale;
      const cx = W / 2;
      const by = H - 8 * scale;
      ctx.strokeStyle = this.els.scalebarBar.dataset.calibrated === "false" ? "#ff9f43" : "#d9f000";
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.moveTo(cx - barPx / 2, by);
      ctx.lineTo(cx + barPx / 2, by);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.textAlign = "center";
      ctx.fillText(this.els.scalebarLabel.textContent ?? "", cx, by - fs * 1.6);
    }
    ctx.shadowBlur = 0;
  }

  resize(): void {
    this.engine?.resize(true, false);
    this.emitOverlay();
  }

  private viewport(): Types.IStackViewport {
    if (!this.engine) throw new Error("setup() を先に呼んでください");
    return this.engine.getViewport(VIEWPORT_ID) as Types.IStackViewport;
  }

  private emitOverlay(): void {
    if (!this.engine) return;
    const vp = this.viewport();
    if (!vp) return;
    const imageId = vp.getCurrentImageId();

    // タグ由来の 3 隅。
    const resolved = resolveOverlay(imageId);
    this.els.overlayTL.textContent = resolved.topLeft.join("\n");
    this.els.overlayTR.textContent = resolved.topRight.join("\n");
    this.els.overlayBL.textContent = resolved.bottomLeft.join("\n");

    // 動的値（右下）: Image i/N・W/L・Zoom。
    const voi = vp.getProperties().voiRange;
    const lines: string[] = [];
    if (this.imageCount > 0) lines.push(`Image ${vp.getCurrentImageIdIndex() + 1} / ${this.imageCount}`);
    if (voi) {
      const ww = Math.round(voi.upper - voi.lower);
      const wc = Math.round((voi.upper + voi.lower) / 2);
      lines.push(`W ${ww}  L ${wc}`);
    }
    const zoom = vp.getZoom ? Math.round(vp.getZoom() * 100) / 100 : 1;
    lines.push(`Zoom ${zoom}×`);
    this.els.overlayBR.textContent = lines.join("\n");

    // スケールバー。
    const bar = computeScaleBar(vp, this.els.viewport, isCalibrated(imageId));
    if (bar) {
      this.els.scalebarBar.style.width = `${Math.round(bar.lengthPx)}px`;
      this.els.scalebarBar.style.display = "block";
      this.els.scalebarLabel.textContent = bar.label;
      this.els.scalebarBar.dataset.calibrated = String(bar.calibrated);
    } else {
      this.els.scalebarBar.style.display = "none";
      this.els.scalebarLabel.textContent = "";
    }
  }

  destroy(): void {
    this.els.viewport.removeEventListener(Enums.Events.IMAGE_RENDERED, this.boundRefresh);
    eventTarget.removeEventListener(Enums.Events.STACK_NEW_IMAGE, this.boundRefresh);
    eventTarget.removeEventListener(Enums.Events.VOI_MODIFIED, this.boundRefresh);
    eventTarget.removeEventListener(Enums.Events.CAMERA_MODIFIED, this.boundRefresh);
    this.engine?.destroy();
    this.engine = null;
  }
}
