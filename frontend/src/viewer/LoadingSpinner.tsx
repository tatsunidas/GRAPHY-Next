import type { CSSProperties } from "react";

/**
 * 円形プログレスインジケータ（SVG + animateTransform で回転、CSS keyframes 不要）。
 * シリーズ/スライスのロード中であることをタイル画像上に視覚的に示すために使う。
 */
export function LoadingSpinner({
  size = 28,
  color = "#4fc3f7",
  trackColor = "rgba(255,255,255,0.18)",
}: {
  size?: number;
  color?: string;
  trackColor?: string;
}) {
  const stroke = Math.max(2, Math.round(size / 8));
  const r = (size - stroke) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={spinnerSvg}>
      <circle cx={c} cy={c} r={r} fill="none" stroke={trackColor} strokeWidth={stroke} />
      <circle
        cx={c}
        cy={c}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.28} ${circumference}`}
      >
        <animateTransform
          attributeName="transform"
          type="rotate"
          from={`0 ${c} ${c}`}
          to={`360 ${c} ${c}`}
          dur="0.8s"
          repeatCount="indefinite"
        />
      </circle>
    </svg>
  );
}

const spinnerSvg: CSSProperties = { display: "block", pointerEvents: "none" };
