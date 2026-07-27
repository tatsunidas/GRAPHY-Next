/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useMemo } from "react";
import type { TimeSeriesPoint } from "./videoRoiAnalysis";

/**
 * 動画グローバル ROI の時系列（平均輝度 vs フレーム）を描く軽量インライン SVG チャート。依存ライブラリなし。
 * 主系列は luma（平均輝度）。オプションで min–max 帯（`showBand`）と per-channel R/G/B ライン（`showChannels`）を重ねる。
 * Y 軸はデータ範囲＋余白の自動軸（表示中の全系列を含む）。
 */
export function TimeIntensityChart({
  series,
  width = 860,
  height = 200,
  frameLabel,
  intensityLabel,
  showBand = true,
  showChannels = false,
}: {
  series: TimeSeriesPoint[];
  width?: number;
  height?: number;
  frameLabel: string;
  intensityLabel: string;
  showBand?: boolean;
  showChannels?: boolean;
}) {
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const iw = Math.max(1, width - pad.l - pad.r);
  const ih = Math.max(1, height - pad.t - pad.b);

  const { lumaPath, bandPath, rPath, gPath, bPath, yMax, yMin, xMax } = useMemo(() => {
    const n = series.length;
    const xM = Math.max(1, n);
    // 表示中の系列すべてを含むよう自動軸を決める（0..255 固定だと変動が潰れやすい）。
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of series) {
      lo = Math.min(lo, p.meanY);
      hi = Math.max(hi, p.meanY);
      if (showBand) {
        lo = Math.min(lo, p.minY);
        hi = Math.max(hi, p.maxY);
      }
      if (showChannels) {
        lo = Math.min(lo, p.meanR, p.meanG, p.meanB);
        hi = Math.max(hi, p.meanR, p.meanG, p.meanB);
      }
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
    const line = (key: (p: TimeSeriesPoint) => number) =>
      series.map((p, idx) => `${idx === 0 ? "M" : "L"}${sx(p.frame).toFixed(1)},${sy(key(p)).toFixed(1)}`).join(" ");

    // min–max 帯: 上端(max)を左→右、下端(min)を右→左でなぞって閉じる。
    let band = "";
    if (showBand && n > 0) {
      const top = series.map((p, idx) => `${idx === 0 ? "M" : "L"}${sx(p.frame).toFixed(1)},${sy(p.maxY).toFixed(1)}`).join(" ");
      const bottom = series
        .slice()
        .reverse()
        .map((p) => `L${sx(p.frame).toFixed(1)},${sy(p.minY).toFixed(1)}`)
        .join(" ");
      band = `${top} ${bottom} Z`;
    }

    return {
      lumaPath: line((p) => p.meanY),
      bandPath: band,
      rPath: showChannels ? line((p) => p.meanR) : "",
      gPath: showChannels ? line((p) => p.meanG) : "",
      bPath: showChannels ? line((p) => p.meanB) : "",
      yMax: yHi,
      yMin: yLo,
      xMax: xM,
    };
  }, [series, iw, ih, pad.l, pad.t, showBand, showChannels]);

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
      {/* min–max 帯（luma の下に敷く） */}
      {bandPath && <path d={bandPath} fill="#0b5cad" fillOpacity={0.1} stroke="none" />}
      {/* per-channel R/G/B ライン */}
      {rPath && <path d={rPath} fill="none" stroke="#d64545" strokeWidth={1} strokeOpacity={0.8} />}
      {gPath && <path d={gPath} fill="none" stroke="#2f9e44" strokeWidth={1} strokeOpacity={0.8} />}
      {bPath && <path d={bPath} fill="none" stroke="#3b6fd6" strokeWidth={1} strokeOpacity={0.8} />}
      {/* luma 系列ライン */}
      <path d={lumaPath} fill="none" stroke="#0b5cad" strokeWidth={1.6} />
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
