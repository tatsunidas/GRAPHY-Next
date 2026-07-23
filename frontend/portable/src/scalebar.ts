/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 本体 frontend/src/viewer/scaleBar.ts からの移植（vanilla・依存は cornerstone のみ）。
// FOV（ズーム）に応じて長さを自動調整するスケールバーを算出する。
import { type Types } from "@cornerstonejs/core";

export interface ScaleBar {
  /** 画面上のバー長(px) */
  lengthPx: number;
  /** ラベル（例 "5 cm" / "200 px"） */
  label: string;
  /** 校正済み(PixelSpacing あり)か。色分け用。 */
  calibrated: boolean;
}

function dist(a: Types.Point3, b: Types.Point3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 1,2,5 × 10^n のうち x 以下で最大の「きりのよい」値。 */
function niceNumber(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return 0;
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const f = x / base;
  const nice = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return nice * base;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

/**
 * 画面水平方向に span(px) 離れた 2 点を canvasToWorld で world 化し、1 canvas px あたりの
 * world 量を得る（zoom/回転に追従）。world は校正あり=mm、校正なし=画像ピクセル(spacing=1)。
 * 目標 ~120px に収まる「きりのよい」長さのバー長・ラベルを返す。
 */
export function computeScaleBar(
  viewport: Types.IStackViewport,
  element: HTMLElement,
  calibrated: boolean,
): ScaleBar | null {
  try {
    const w = element.clientWidth;
    const h = element.clientHeight;
    if (!w || !h) return null;
    const y = h / 2;
    const span = Math.max(20, Math.min(120, w * 0.3));
    const p0 = viewport.canvasToWorld([0, y]);
    const p1 = viewport.canvasToWorld([span, y]);
    const worldPerPx = dist(p0, p1) / span; // mm/px もしくは imgpx/px
    if (!(worldPerPx > 0) || !Number.isFinite(worldPerPx)) return null;

    const targetPx = Math.max(40, Math.min(140, w * 0.3));
    const niceWorld = niceNumber(targetPx * worldPerPx);
    if (!(niceWorld > 0)) return null;
    const lengthPx = niceWorld / worldPerPx;

    const label = calibrated
      ? niceWorld >= 10
        ? `${fmt(niceWorld / 10)} cm`
        : `${fmt(niceWorld)} mm`
      : `${fmt(niceWorld)} px`;

    return { lengthPx, label, calibrated };
  } catch {
    return null;
  }
}
