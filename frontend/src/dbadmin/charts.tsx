/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 依存ライブラリ無しの軽量 SVG チャート（棒・横棒・円）。
import { useI18n } from "../i18n/i18n";

export interface Datum {
  label: string;
  value: number;
}

const PALETTE = ["#0b5cad", "#3fb950", "#e3a008", "#cf4f4f", "#7c5cbf", "#1f9e9e", "#b8693d", "#5a7088"];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/** 縦棒グラフ（時系列向け）。 */
export function VBarChart({ data, height = 160 }: { data: Datum[]; height?: number }) {
  if (data.length === 0) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const barW = 28;
  const gap = 10;
  const width = data.length * (barW + gap) + gap;
  const top = 16;
  const plotH = height - 34;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: width }}>
      {data.map((d, i) => {
        const h = (d.value / max) * plotH;
        const x = gap + i * (barW + gap);
        const y = top + (plotH - h);
        return (
          <g key={d.label}>
            <rect x={x} y={y} width={barW} height={h} rx={3} fill="#0b5cad" />
            <text x={x + barW / 2} y={y - 3} fontSize="10" textAnchor="middle" fill="#444">
              {d.value}
            </text>
            <text x={x + barW / 2} y={height - 6} fontSize="9" textAnchor="middle" fill="#666">
              {d.label.length > 7 ? d.label.slice(2) : d.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 横棒グラフ（モダリティ別の枚数・容量向け）。formatValue で値を整形。 */
export function HBarChart({
  data,
  formatValue = (v) => String(v),
}: {
  data: Datum[];
  formatValue?: (v: number) => string;
}) {
  if (data.length === 0) return <Empty />;
  const max = Math.max(...data.map((d) => d.value), 1);
  const rowH = 26;
  const labelW = 70;
  const width = 360;
  const barMax = width - labelW - 90;
  return (
    <svg width="100%" viewBox={`0 0 ${width} ${data.length * rowH}`} style={{ maxWidth: width }}>
      {data.map((d, i) => {
        const w = (d.value / max) * barMax;
        const y = i * rowH;
        return (
          <g key={d.label}>
            <text x={labelW - 6} y={y + rowH / 2 + 4} fontSize="11" textAnchor="end" fill="#444">
              {d.label}
            </text>
            <rect x={labelW} y={y + 5} width={Math.max(w, 1)} height={rowH - 12} rx={3}
                  fill={PALETTE[i % PALETTE.length]} />
            <text x={labelW + w + 6} y={y + rowH / 2 + 4} fontSize="10" fill="#555">
              {formatValue(d.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/** 円グラフ（割合向け）。 */
export function PieChart({ data, size = 160 }: { data: Datum[]; size?: number }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  if (total === 0) return <Empty />;
  const r = size / 2;
  let angle = -Math.PI / 2;
  return (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {data.map((d, i) => {
          const slice = (d.value / total) * Math.PI * 2;
          const x1 = r + r * Math.cos(angle);
          const y1 = r + r * Math.sin(angle);
          angle += slice;
          const x2 = r + r * Math.cos(angle);
          const y2 = r + r * Math.sin(angle);
          const large = slice > Math.PI ? 1 : 0;
          const path = `M ${r} ${r} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
          return <path key={d.label} d={path} fill={PALETTE[i % PALETTE.length]} />;
        })}
      </svg>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, fontSize: 12 }}>
        {data.map((d, i) => (
          <li key={d.label} style={{ display: "flex", alignItems: "center", gap: 6, padding: "2px 0" }}>
            <span style={{ width: 10, height: 10, background: PALETTE[i % PALETTE.length], borderRadius: 2 }} />
            {d.label} {Math.round((d.value / total) * 100)}%
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty() {
  const { t } = useI18n();
  return <div style={{ color: "#999", fontSize: 12, padding: "8px 0" }}>{t("common.noData")}</div>;
}
