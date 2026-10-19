/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * つなぎ合わせ結果の MIP（AX・SAG・COR）を 3 枚の canvas に描く。
 * 画素値は 3 枚をまとめた最小〜最大で 0〜255 に落とす（覆われない画素は黒）。物理寸法（mm）の比で表示する。
 */
import { useEffect, useRef } from "react";
import type { MipImages } from "../viewer/volumeStitch";

interface View {
  key: "ax" | "sag" | "cor";
  label: string;
  /** 画素数（幅, 高さ）と、1 画素の大きさ [mm]（幅, 高さ）。 */
  w: number;
  h: number;
  sx: number;
  sy: number;
  data: Float32Array;
  /** 行を上下反転して描く（k が大きい方を上にする断面）。 */
  flip: boolean;
}

function views(m: MipImages, sp: readonly [number, number, number], labels: { ax: string; sag: string; cor: string }): View[] {
  const [nx, ny, nz] = m.dims;
  return [
    { key: "ax", label: labels.ax, w: nx, h: ny, sx: sp[0], sy: sp[1], data: m.ax, flip: false },
    { key: "sag", label: labels.sag, w: ny, h: nz, sx: sp[1], sy: sp[2], data: m.sag, flip: true },
    { key: "cor", label: labels.cor, w: nx, h: nz, sx: sp[0], sy: sp[2], data: m.cor, flip: true },
  ];
}

function range(vs: View[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of vs) {
    for (let n = 0; n < v.data.length; n++) {
      const x = v.data[n];
      if (x < lo) lo = x;
      if (x > hi) hi = x;
    }
  }
  return Number.isFinite(lo) && hi > lo ? [lo, hi] : [0, 1];
}

function Canvas({ v, lo, hi, box }: { v: View; lo: number; hi: number; box: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext("2d");
    if (!c || !ctx) return;
    const img = ctx.createImageData(v.w, v.h);
    const scale = 255 / (hi - lo);
    for (let r = 0; r < v.h; r++) {
      const src = v.flip ? v.h - 1 - r : r;
      for (let i = 0; i < v.w; i++) {
        const x = v.data[src * v.w + i];
        const g = Number.isNaN(x) ? 0 : Math.max(0, Math.min(255, Math.round((x - lo) * scale)));
        const o = (r * v.w + i) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = g;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [v, lo, hi]);
  // 長い辺が box に収まる倍率（物理寸法の比を保つ）。
  const wmm = v.w * v.sx;
  const hmm = v.h * v.sy;
  const k = box / Math.max(wmm, hmm);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <div style={{ width: box, height: box, display: "flex", alignItems: "center", justifyContent: "center", background: "#000" }}>
        <canvas
          ref={ref}
          width={v.w}
          height={v.h}
          data-testid={`stitch-mip-${v.key}`}
          data-px={`${v.w}x${v.h}`}
          style={{ width: wmm * k, height: hmm * k, imageRendering: "pixelated" }}
        />
      </div>
      <span style={{ fontSize: 11, color: "#8a98a6" }}>{v.label}</span>
    </div>
  );
}

export function StitchMip({
  mip,
  spacing,
  box,
  labels,
  busy,
}: {
  mip: MipImages | null;
  spacing: readonly [number, number, number] | null;
  box: number;
  labels: { ax: string; sag: string; cor: string };
  busy: boolean;
}) {
  const vs = mip && spacing ? views(mip, spacing, labels) : null;
  const [lo, hi] = vs ? range(vs) : [0, 1];
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 6, opacity: busy ? 0.6 : 1 }} data-testid="stitch-mip" data-busy={busy}>
      {vs
        ? vs.map((v) => <Canvas key={v.key} v={v} lo={lo} hi={hi} box={box} />)
        : [0, 1, 2].map((n) => <div key={n} style={{ width: box, height: box, background: "#000" }} />)}
    </div>
  );
}
