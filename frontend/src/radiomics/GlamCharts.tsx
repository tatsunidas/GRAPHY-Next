/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * GLAM 解析の図。手書き SVG（このリポジトリはグラフ用ライブラリを入れていない。
 * `viewer/RoiHistogramChart.tsx` と同じ流儀）。
 *
 * 描くのは 3 つ。原著論文および RadiomicsJ 同梱の `docs/make_glam_figures.py` が見せている図に対応する。
 *  1. 自己親和性曲線 g(α,α,r) … 距離ごとの構造。**破線 1.0 が「偶然と区別がつかない」水準**
 *  2. 親和性行列のヒートマップ … α×β の関係。GLCM の共起行列にあたる記述子そのもの
 *  3. ビン占有数 … 稀なビンほど g(r) は跳ねるので、曲線を読む前の前提確認
 */
import { useMemo } from "react";

/** 濃度値ビンの色。低い値ほど暗い（make_glam_figures.py の viridis 相当の並び）。 */
export function binColor(index: number, total: number): string {
  const t = total <= 1 ? 0 : index / (total - 1);
  // 暗い青紫 → 緑 → 黄。順序が読み取れることだけを狙った簡易版。
  const stops: Array<[number, number, number]> = [
    [68, 1, 84],
    [59, 82, 139],
    [33, 145, 140],
    [94, 201, 98],
    [253, 231, 37],
  ];
  const pos = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const PAD = { l: 52, r: 12, t: 14, b: 34 };

/**
 * 自己親和性曲線。y は対数目盛（g は 1 の周りで数倍〜数十倍に振れるため、
 * 線形だと近距離のピークに潰されて遠距離が読めない）。
 */
export function SelfAffinityChart({
  radii,
  curves,
  occupancy,
  width = 560,
  height = 260,
  emptyLabel,
}: {
  radii: number[];
  curves: number[][];
  occupancy: number[];
  width?: number;
  height?: number;
  emptyLabel: string;
}) {
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;

  const shown = useMemo(
    // ボクセルが 1 つも無いビンは曲線が定義されない。描いても意味が無いので落とす。
    () => curves.map((c, i) => ({ c, i })).filter(({ i }) => (occupancy[i] ?? 0) > 0),
    [curves, occupancy],
  );

  const { lo, hi } = useMemo(() => {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const { c } of shown) {
      for (const v of c) {
        if (!Number.isFinite(v) || v <= 0) continue;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return { lo: 0.5, hi: 2 };
    // 1.0（偶然の水準）は必ず入れる。ここが読めないと曲線の意味が決まらない。
    return { lo: Math.min(min, 1) * 0.9, hi: Math.max(max, 1) * 1.1 };
  }, [shown]);

  if (!shown.length || !radii.length) {
    return <div style={{ color: "#6b7785", fontSize: 12, padding: 12 }}>{emptyLabel}</div>;
  }

  const x = (r: number) => PAD.l + (iw * (r - radii[0])) / Math.max(1, radii[radii.length - 1] - radii[0]);
  const logLo = Math.log(lo);
  const logHi = Math.log(hi);
  const y = (v: number) => {
    const clamped = Math.min(hi, Math.max(lo, v));
    return PAD.t + ih - (ih * (Math.log(clamped) - logLo)) / Math.max(1e-9, logHi - logLo);
  };

  const ticks = [0.5, 1, 2, 5, 10, 20, 50].filter((v) => v >= lo && v <= hi);

  return (
    <svg width={width} height={height} role="img">
      <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="#fafbfc" stroke="#e2e7ee" />
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.l} x2={PAD.l + iw} y1={y(v)} y2={y(v)} stroke="#eef2f6" />
          <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize={9} fill="#6b7785">{v}</text>
        </g>
      ))}
      {/* 偶然の水準。GLAM の曲線はこの線からの隔たりで読む。 */}
      <line x1={PAD.l} x2={PAD.l + iw} y1={y(1)} y2={y(1)} stroke="#9aa5b1" strokeDasharray="4 3" />
      {shown.map(({ c, i }) => {
        const d = c
          .map((v, k) => `${k === 0 ? "M" : "L"}${x(radii[k]).toFixed(1)},${y(v).toFixed(1)}`)
          .join(" ");
        return <path key={i} d={d} fill="none" stroke={binColor(i, curves.length)} strokeWidth={1.4} />;
      })}
      {radii
        .filter((_, k) => k % Math.max(1, Math.floor(radii.length / 6)) === 0)
        .map((r) => (
          <text key={r} x={x(r)} y={height - 12} textAnchor="middle" fontSize={9} fill="#6b7785">{r}</text>
        ))}
      <text x={PAD.l + iw / 2} y={height - 1} textAnchor="middle" fontSize={9} fill="#8a93a0">r [voxel]</text>
    </svg>
  );
}

/** 親和性行列のヒートマップ。0 を白、正を赤、負を青にした発散配色。 */
export function MatrixHeatmap({
  matrix,
  diagonalOnly,
  size = 260,
  emptyLabel,
}: {
  matrix: number[][];
  diagonalOnly: boolean;
  size?: number;
  emptyLabel: string;
}) {
  const n = matrix.length;
  const scale = useMemo(() => {
    let m = 0;
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const v = matrix[a]?.[b];
        // 対角のみの行列は非対角が未定義なので、色の範囲を決めるときにも見ない
        if (diagonalOnly && a !== b) continue;
        if (Number.isFinite(v)) m = Math.max(m, Math.abs(v));
      }
    }
    return m;
  }, [matrix, n, diagonalOnly]);

  if (!n || scale === 0) {
    return <div style={{ color: "#6b7785", fontSize: 12, padding: 12 }}>{emptyLabel}</div>;
  }

  const cell = size / n;
  const color = (v: number) => {
    if (!Number.isFinite(v)) return "#f2f4f7"; // 未定義（ROI にその濃度値が無い）
    const t = Math.max(-1, Math.min(1, v / scale));
    const a = Math.round(Math.abs(t) * 255);
    return t >= 0 ? `rgb(255,${255 - a},${255 - a})` : `rgb(${255 - a},${255 - a},255)`;
  };

  return (
    <svg width={size + 1} height={size + 1} role="img">
      {matrix.map((row, a) =>
        row.map((v, b) => (
          <rect
            key={`${a}-${b}`}
            x={b * cell}
            y={a * cell}
            width={cell}
            height={cell}
            fill={diagonalOnly && a !== b ? "#f2f4f7" : color(v)}
          />
        )),
      )}
      <rect x={0} y={0} width={size} height={size} fill="none" stroke="#cfd8e2" />
    </svg>
  );
}

/** ビン占有数。 */
export function BinOccupancyChart({
  occupancy,
  width = 260,
  height = 140,
}: {
  occupancy: number[];
  width?: number;
  height?: number;
}) {
  const iw = width - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const max = Math.max(1, ...occupancy);
  const bw = iw / Math.max(1, occupancy.length);
  return (
    <svg width={width} height={height} role="img">
      <rect x={PAD.l} y={PAD.t} width={iw} height={ih} fill="#fafbfc" stroke="#e2e7ee" />
      {occupancy.map((v, i) => {
        const h = (ih * v) / max;
        return (
          <rect
            key={i}
            x={PAD.l + i * bw + 0.5}
            y={PAD.t + ih - h}
            width={Math.max(1, bw - 1)}
            height={h}
            fill={binColor(i, occupancy.length)}
          />
        );
      })}
      <text x={PAD.l - 6} y={PAD.t + 8} textAnchor="end" fontSize={9} fill="#6b7785">
        {max.toLocaleString()}
      </text>
      <text x={PAD.l + iw / 2} y={height - 1} textAnchor="middle" fontSize={9} fill="#8a93a0">bin</text>
    </svg>
  );
}
