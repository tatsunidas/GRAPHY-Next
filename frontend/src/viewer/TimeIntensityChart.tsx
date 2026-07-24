/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useMemo } from "react";
import type { TimeSeriesPoint } from "./videoRoiAnalysis";

/**
 * 動画グローバル ROI の時系列（平均輝度 vs フレーム）を描く軽量インライン SVG チャート。
 * 単一系列（luma）。フレーム軸（下）・輝度軸（左, 0..255）。依存ライブラリなし。
 */
export function TimeIntensityChart({
  series,
  width = 860,
  height = 200,
  frameLabel,
  intensityLabel,
}: {
  series: TimeSeriesPoint[];
  width?: number;
  height?: number;
  frameLabel: string;
  intensityLabel: string;
}) {
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const iw = Math.max(1, width - pad.l - pad.r);
  const ih = Math.max(1, height - pad.t - pad.b);

  const { path, yMax, yMin, xMax } = useMemo(() => {
    const n = series.length;
    const xM = Math.max(1, n);
    // 輝度は 0..255 固定軸だと変動が潰れやすいので、データ範囲に少し余白を足した自動軸にする。
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of series) {
      lo = Math.min(lo, p.meanY);
      hi = Math.max(hi, p.meanY);
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      lo = 0;
      hi = 255;
    }
    if (hi - lo < 1) {
      lo = Math.max(0, lo - 1);
      hi = Math.min(255, hi + 1);
    }
    const pa = Math.max(1, (hi - lo) * 0.08);
    const yLo = Math.max(0, lo - pa);
    const yHi = Math.min(255, hi + pa);
    const sx = (frame: number) => pad.l + (xM <= 1 ? 0 : ((frame - 1) / (xM - 1)) * iw);
    const sy = (y: number) => pad.t + ih - ((y - yLo) / Math.max(1e-6, yHi - yLo)) * ih;
    const d = series.map((p, idx) => `${idx === 0 ? "M" : "L"}${sx(p.frame).toFixed(1)},${sy(p.meanY).toFixed(1)}`).join(" ");
    return { path: d, yMax: yHi, yMin: yLo, xMax: xM };
  }, [series, iw, ih, pad.l, pad.t]);

  const yTicks = [yMin, (yMin + yMax) / 2, yMax];
  const xTicks = Array.from(new Set([1, Math.ceil(xMax / 2), xMax])).filter((v) => v >= 1);

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${intensityLabel} / ${frameLabel}`}
      style={{ display: "block", maxWidth: width }}
    >
      {/* プロット枠 */}
      <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="#fafbfc" stroke="#e2e7ee" />
      {/* Y グリッド＋目盛 */}
      {yTicks.map((v, i) => {
        const y = pad.t + ih - ((v - yMin) / Math.max(1e-6, yMax - yMin)) * ih;
        return (
          <g key={`y${i}`}>
            <line x1={pad.l} y1={y} x2={pad.l + iw} y2={y} stroke="#eef1f5" />
            <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#889">
              {v.toFixed(0)}
            </text>
          </g>
        );
      })}
      {/* X 目盛 */}
      {xTicks.map((f, i) => {
        const x = pad.l + (xMax <= 1 ? 0 : ((f - 1) / (xMax - 1)) * iw);
        return (
          <text key={`x${i}`} x={x} y={pad.t + ih + 15} textAnchor="middle" fontSize={10} fill="#889">
            {f}
          </text>
        );
      })}
      {/* 系列ライン */}
      <path d={path} fill="none" stroke="#0b5cad" strokeWidth={1.6} />
      {/* 軸ラベル */}
      <text x={pad.l + iw / 2} y={height - 2} textAnchor="middle" fontSize={11} fill="#667">
        {frameLabel}
      </text>
      <text x={12} y={pad.t + ih / 2} textAnchor="middle" fontSize={11} fill="#667" transform={`rotate(-90 12 ${pad.t + ih / 2})`}>
        {intensityLabel}
      </text>
    </svg>
  );
}
