/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useMemo } from "react";
import type { RoiHistogram } from "./videoRoiAnalysis";

/**
 * フレーム指定 ROI の輝度ヒストグラムを描く軽量インライン SVG（依存ライブラリなし）。
 * X 軸は輝度 0–255 固定（8bit 動画）、Y 軸は度数（最頻ビンで正規化）。`TimeIntensityChart` と描画様式を揃える。
 * 平均位置に破線を引いて統計値と対応付ける。
 */
export function RoiHistogramChart({
  histogram,
  mean,
  width = 860,
  height = 160,
  intensityLabel,
  countLabel,
}: {
  histogram: RoiHistogram;
  mean?: number;
  width?: number;
  height?: number;
  intensityLabel: string;
  countLabel: string;
}) {
  const pad = { l: 44, r: 12, t: 10, b: 26 };
  const iw = Math.max(1, width - pad.l - pad.r);
  const ih = Math.max(1, height - pad.t - pad.b);

  const bars = useMemo(() => {
    const peak = Math.max(1, histogram.peakCount);
    const bw = iw / Math.max(1, histogram.binCount);
    return histogram.counts.map((c, i) => {
      const h = (c / peak) * ih;
      return {
        key: i,
        x: pad.l + i * bw,
        y: pad.t + ih - h,
        // 0 件のビンも境界が見えるよう最小幅を確保する（bw が 1px を切るとビンが消えるため）。
        w: Math.max(0.5, bw - (bw > 3 ? 1 : 0)),
        h,
      };
    });
  }, [histogram, iw, ih, pad.l, pad.t]);

  const meanX =
    mean !== undefined && Number.isFinite(mean)
      ? pad.l + (Math.min(255, Math.max(0, mean)) / 256) * iw
      : null;

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${countLabel} / ${intensityLabel}`}
      style={{ display: "block", maxWidth: width }}
      data-testid="video-frame-histogram"
    >
      {/* プロット枠 */}
      <rect x={pad.l} y={pad.t} width={iw} height={ih} fill="#fafbfc" stroke="#e2e7ee" />
      {/* Y 目盛（0 と最頻値） */}
      {[0, histogram.peakCount].map((v, i) => {
        const y = pad.t + ih - (v / Math.max(1, histogram.peakCount)) * ih;
        return (
          <g key={`y${i}`}>
            <line x1={pad.l} y1={y} x2={pad.l + iw} y2={y} stroke="#eef1f5" />
            <text x={pad.l - 6} y={y + 3} textAnchor="end" fontSize={10} fill="#889">
              {v}
            </text>
          </g>
        );
      })}
      {/* X 目盛（0 / 128 / 255） */}
      {[0, 128, 255].map((v) => (
        <text
          key={`x${v}`}
          x={pad.l + (v / 256) * iw}
          y={pad.t + ih + 15}
          textAnchor="middle"
          fontSize={10}
          fill="#889"
        >
          {v}
        </text>
      ))}
      {/* 度数バー */}
      {bars.map((b) => (
        <rect key={b.key} x={b.x} y={b.y} width={b.w} height={b.h} fill="#0b5cad" fillOpacity={0.75} />
      ))}
      {/* 平均位置 */}
      {meanX !== null && (
        <line
          x1={meanX}
          y1={pad.t}
          x2={meanX}
          y2={pad.t + ih}
          stroke="#d64545"
          strokeWidth={1}
          strokeDasharray="3 3"
        />
      )}
      {/* 軸ラベル */}
      <text x={pad.l + iw / 2} y={height - 2} textAnchor="middle" fontSize={11} fill="#667">
        {intensityLabel}
      </text>
      <text
        x={12}
        y={pad.t + ih / 2}
        textAnchor="middle"
        fontSize={11}
        fill="#667"
        transform={`rotate(-90 12 ${pad.t + ih / 2})`}
      >
        {countLabel}
      </text>
    </svg>
  );
}
