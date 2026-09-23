/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 1 枚の画素配列をグレースケールで描くだけの部品（`fw/angio-design.md` §6.18）。
 *
 * <p>🔴 **VOI を指定できることが要点。** 既定は min/max 正規化（見えればよい）だが、
 * **差分画像をフレームごとに自動調整すると、明るさが変わってフレーム間で見比べられない**。
 * 2D Viewer 本体と同じ窓で出したいときは `voi` を渡す。
 */
import React, { useEffect, useMemo, useRef } from "react";

export interface CanvasSlice {
  values: Float32Array;
  width: number;
  height: number;
}

export interface SliceVoi {
  windowCenter: number;
  windowWidth: number;
}

/** 画素 → 0..255。`voi` があればそれ、無ければ min/max で正規化する。 */
function toGray(values: Float32Array, voi?: SliceVoi | null): Uint8ClampedArray {
  const out = new Uint8ClampedArray(values.length);
  if (voi && voi.windowWidth > 0) {
    const lo = voi.windowCenter - voi.windowWidth / 2;
    const span = voi.windowWidth;
    for (let i = 0; i < values.length; i++) out[i] = ((values[i] - lo) / span) * 255;
    return out;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  for (let i = 0; i < values.length; i++) out[i] = ((values[i] - min) / span) * 255;
  return out;
}

export function SliceCanvas({
  slice,
  size,
  voi,
  testId,
  style,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  canvasRef,
}: {
  slice: CanvasSlice;
  /** 長辺をこの大きさに収める [px]。 */
  size: number;
  voi?: SliceVoi | null;
  testId?: string;
  style?: React.CSSProperties;
  onMouseDown?: React.MouseEventHandler<HTMLCanvasElement>;
  onMouseMove?: React.MouseEventHandler<HTMLCanvasElement>;
  onMouseUp?: React.MouseEventHandler<HTMLCanvasElement>;
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
}) {
  const ownRef = useRef<HTMLCanvasElement | null>(null);
  const ref = canvasRef ?? ownRef;

  const view = useMemo(() => {
    const scale = Math.min(size / slice.width, size / slice.height);
    return { dw: Math.round(slice.width * scale), dh: Math.round(slice.height * scale) };
  }, [slice.width, slice.height, size]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const gray = toGray(slice.values, voi);
    const img = ctx.createImageData(slice.width, slice.height);
    for (let i = 0; i < gray.length; i++) {
      img.data[i * 4] = gray[i];
      img.data[i * 4 + 1] = gray[i];
      img.data[i * 4 + 2] = gray[i];
      img.data[i * 4 + 3] = 255;
    }
    const off = document.createElement("canvas");
    off.width = slice.width;
    off.height = slice.height;
    off.getContext("2d")?.putImageData(img, 0, 0);
    canvas.width = view.dw;
    canvas.height = view.dh;
    ctx.clearRect(0, 0, view.dw, view.dh);
    ctx.drawImage(off, 0, 0, view.dw, view.dh);
  }, [slice, voi, view, ref]);

  return (
    <canvas
      ref={(el) => { ref.current = el; }}
      data-testid={testId}
      style={{
        border: "1px solid #2c3742",
        display: "block",
        // 🚨 パネルは flex 列なので、これが無いと潰れる（§6.14.3 と同じ罠）。
        flexShrink: 0,
        ...style,
      }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onMouseLeave={onMouseUp}
    />
  );
}
