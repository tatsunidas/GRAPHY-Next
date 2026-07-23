/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 1 タイル分のビューポート（StackViewport）＋4隅オーバレイ／スケールバーを内包する部品。
// 共有 RenderingEngine の 1 viewport を担当し、W/L・トランスフォーム・スライス送り・PNG 保存を提供する。
// P4.4 で複数タイル対応のため、旧 viewer.ts の per-viewport ロジックをここへ分離した。
import { Enums, metaData, type Types, type RenderingEngine } from "@cornerstonejs/core";
import dicomImageLoader from "@cornerstonejs/dicom-image-loader";
import type { ImageRec } from "./dicomdir";
import { resolveOverlay, isCalibrated, pixelSpacingColumn } from "./overlay";
import { computeScaleBar } from "./scalebar";
import { applyTransform, readTransform, FIT_TRANSFORM } from "./transform";

const { ViewportType } = Enums;

/** 現在の W/L（ウィンドウ中心/幅）。 */
export interface WindowLevel {
  center: number;
  width: number;
}

/** タイル 1 枚。DOM（viewport＋オーバレイ＋スケールバー）を自前で構築する。 */
export class ViewportPanel {
  readonly viewportId: string;
  readonly root: HTMLDivElement;
  private engine: RenderingEngine;
  private viewportEl: HTMLDivElement;
  private overlayTL: HTMLDivElement;
  private overlayTR: HTMLDivElement;
  private overlayBL: HTMLDivElement;
  private overlayBR: HTMLDivElement;
  private scalebarBar: HTMLDivElement;
  private scalebarLabel: HTMLDivElement;
  private imageCount = 0;
  private boundRefresh: () => void;
  /** 画像・W/L・カメラ変更時に UI（スライダ等）を同期させる外部コールバック。 */
  onChange: (() => void) | null = null;

  constructor(engine: RenderingEngine, viewportId: string, parent: HTMLElement) {
    this.engine = engine;
    this.viewportId = viewportId;
    this.boundRefresh = () => {
      this.emitOverlay();
      this.onChange?.();
    };

    const mk = (cls: string): HTMLDivElement => {
      const d = document.createElement("div");
      d.className = cls;
      return d;
    };
    this.root = mk("panel");
    this.viewportEl = mk("panel-viewport");
    this.overlayTL = mk("overlay tl");
    this.overlayTR = mk("overlay tr");
    this.overlayBL = mk("overlay bl");
    this.overlayBR = mk("overlay br");
    const sb = mk("scalebar");
    this.scalebarBar = mk("scalebar-bar");
    this.scalebarLabel = mk("scalebar-label");
    sb.append(this.scalebarBar, this.scalebarLabel);
    this.root.append(
      this.viewportEl,
      this.overlayTL,
      this.overlayTR,
      this.overlayBL,
      this.overlayBR,
      sb,
    );
    parent.appendChild(this.root);

    this.engine.enableElement({
      viewportId,
      type: ViewportType.STACK,
      element: this.viewportEl,
    });

    // オーバレイ更新はこの panel の要素に閉じたイベントで（複数タイルでも混線しない）。
    this.viewportEl.addEventListener(Enums.Events.IMAGE_RENDERED, this.boundRefresh);
    this.viewportEl.addEventListener(Enums.Events.STACK_NEW_IMAGE, this.boundRefresh);
    this.viewportEl.addEventListener(Enums.Events.VOI_MODIFIED, this.boundRefresh);
    this.viewportEl.addEventListener(Enums.Events.CAMERA_MODIFIED, this.boundRefresh);
  }

  private viewport(): Types.IStackViewport {
    return this.engine.getViewport(this.viewportId) as Types.IStackViewport;
  }

  /** viewport を再描画（注釈の追加/削除後など）。 */
  render(): void {
    try {
      this.viewport().render();
    } catch {
      /* viewport 未準備 */
    }
  }

  /** オーバレイ／スケールバーを再計算（リサイズ後など）。 */
  refresh(): void {
    this.emitOverlay();
  }

  /** この panel をアクティブ表示（枠ハイライト）に。 */
  setActive(active: boolean): void {
    this.root.classList.toggle("active", active);
  }

  /** 1 シリーズの画像を表示する。 */
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

  /** 空表示（シリーズ未割当のタイル）。 */
  hasSeries(): boolean {
    return this.imageCount > 0;
  }

  resetView(): void {
    const vp = this.viewport();
    vp.resetCamera();
    vp.resetProperties();
    vp.render();
    this.emitOverlay();
  }

  fit(): void {
    applyTransform(this.viewport(), FIT_TRANSFORM);
    this.emitOverlay();
  }

  actualSize(): void {
    const vp = this.viewport();
    const y = this.viewportEl.clientHeight / 2;
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
    const vp = this.viewport();
    applyTransform(vp, { rotation: (readTransform(vp).rotation + 90) % 360 });
    this.emitOverlay();
  }

  flipH(): void {
    const vp = this.viewport();
    applyTransform(vp, { flipHorizontal: !readTransform(vp).flipHorizontal });
    this.emitOverlay();
  }

  flipV(): void {
    const vp = this.viewport();
    applyTransform(vp, { flipVertical: !readTransform(vp).flipVertical });
    this.emitOverlay();
  }

  invert(): void {
    const vp = this.viewport();
    const cur = vp.getProperties().invert ?? false;
    vp.setProperties({ invert: !cur });
    vp.render();
    this.emitOverlay();
  }

  // ── W/L ────────────────────────────────────────────────────────────────
  setWL(center: number, width: number): void {
    if (!Number.isFinite(center) || !(width > 0)) return;
    const vp = this.viewport();
    const half = width / 2;
    vp.setProperties({ voiRange: { lower: center - half, upper: center + half } });
    vp.render();
    this.emitOverlay();
  }

  getWL(): WindowLevel | null {
    const voi = this.viewport().getProperties().voiRange;
    if (!voi) return null;
    return { center: Math.round((voi.upper + voi.lower) / 2), width: Math.round(voi.upper - voi.lower) };
  }

  defaultWL(): void {
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

  // ── スライス送り ──────────────────────────────────────────────────────
  imageIndex(): number {
    return this.viewport().getCurrentImageIdIndex();
  }

  imageTotal(): number {
    return this.imageCount;
  }

  async setImageIndex(index: number): Promise<void> {
    if (this.imageCount === 0) return;
    const i = Math.max(0, Math.min(this.imageCount - 1, Math.round(index)));
    if (i === this.viewport().getCurrentImageIdIndex()) return;
    await this.viewport().setImageIdIndex(i);
  }

  // ── PNG 保存 ───────────────────────────────────────────────────────────
  savePng(filename: string): void {
    const vp = this.viewport();
    const src = vp.getCanvas();
    if (!src) return;
    const out = document.createElement("canvas");
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext("2d");
    if (!ctx) return;
    ctx.drawImage(src, 0, 0);
    this.burnOverlays(ctx, src.width / this.viewportEl.clientWidth);
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
    draw(this.overlayTL.textContent ?? "", pad, true, false);
    draw(this.overlayTR.textContent ?? "", W - pad, true, true);
    draw(this.overlayBL.textContent ?? "", pad, false, false);
    draw(this.overlayBR.textContent ?? "", W - pad, false, true);
    if (this.scalebarBar.style.display !== "none") {
      const barPx = (parseFloat(this.scalebarBar.style.width) || 0) * scale;
      const cx = W / 2;
      const by = H - 8 * scale;
      ctx.strokeStyle = this.scalebarBar.dataset.calibrated === "false" ? "#ff9f43" : "#d9f000";
      ctx.lineWidth = 3 * scale;
      ctx.beginPath();
      ctx.moveTo(cx - barPx / 2, by);
      ctx.lineTo(cx + barPx / 2, by);
      ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle;
      ctx.textAlign = "center";
      ctx.fillText(this.scalebarLabel.textContent ?? "", cx, by - fs * 1.6);
    }
    ctx.shadowBlur = 0;
  }

  private emitOverlay(): void {
    let vp: Types.IStackViewport;
    try {
      vp = this.viewport();
    } catch {
      return;
    }
    if (!vp) return;
    const imageId = vp.getCurrentImageId();

    const resolved = resolveOverlay(imageId);
    this.overlayTL.textContent = resolved.topLeft.join("\n");
    this.overlayTR.textContent = resolved.topRight.join("\n");
    this.overlayBL.textContent = resolved.bottomLeft.join("\n");

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
    this.overlayBR.textContent = lines.join("\n");

    const bar = computeScaleBar(vp, this.viewportEl, isCalibrated(imageId));
    if (bar) {
      this.scalebarBar.style.width = `${Math.round(bar.lengthPx)}px`;
      this.scalebarBar.style.display = "block";
      this.scalebarLabel.textContent = bar.label;
      this.scalebarBar.dataset.calibrated = String(bar.calibrated);
    } else {
      this.scalebarBar.style.display = "none";
      this.scalebarLabel.textContent = "";
    }
  }

  /** この panel のリソースを解放（イベント解除＋viewport 無効化＋DOM 除去）。 */
  destroy(): void {
    this.viewportEl.removeEventListener(Enums.Events.IMAGE_RENDERED, this.boundRefresh);
    this.viewportEl.removeEventListener(Enums.Events.STACK_NEW_IMAGE, this.boundRefresh);
    this.viewportEl.removeEventListener(Enums.Events.VOI_MODIFIED, this.boundRefresh);
    this.viewportEl.removeEventListener(Enums.Events.CAMERA_MODIFIED, this.boundRefresh);
    try {
      this.engine.disableElement(this.viewportId);
    } catch {
      /* ignore */
    }
    this.root.remove();
  }
}
