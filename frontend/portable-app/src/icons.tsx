import type { ReactNode } from "react";

// 自前 SVG（外部依存なし）。currentColor で色を受ける。
const S = ({ size = 22, children }: { size?: number; children: ReactNode }) => (
  <svg width={size} height={size} viewBox="0 0 22 22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const IcWL = () => (<S><circle cx="11" cy="11" r="7.5" /><path d="M11 3.5v15" /><path d="M11 3.5a7.5 7.5 0 010 15z" fill="currentColor" stroke="none" /></S>);
export const IcPan = () => (<S><path d="M11 3v16M3 11h16M11 3l-2.5 2.5M11 3l2.5 2.5M11 19l-2.5-2.5M11 19l2.5-2.5M3 11l2.5-2.5M3 11l2.5 2.5M19 11l-2.5-2.5M19 11l-2.5 2.5" /></S>);
export const IcZoom = () => (<S><circle cx="9.5" cy="9.5" r="6" /><path d="M14 14l5 5M9.5 7v5M7 9.5h5" /></S>);
export const IcLength = () => (<S><path d="M4 17L17 4" /><path d="M2.5 14.5l3 3M14.5 2.5l3 3" /></S>);
export const IcAngle = () => (<S><path d="M4 18h13M4 18L13 5" /><path d="M10 18a6 6 0 00-1.6-4" /></S>);
export const IcProbe = () => (<S><circle cx="11" cy="11" r="2.2" fill="currentColor" /><path d="M11 3v4M11 15v4M3 11h4M15 11h4" /></S>);
export const IcReset = () => (<S><path d="M4.5 11a6.5 6.5 0 106.5-6.5H8" /><path d="M9.5 2.5L7.5 4.5l2 2" /></S>);
export const IcMore = () => (<S><circle cx="5" cy="11" r="1.6" fill="currentColor" /><circle cx="11" cy="11" r="1.6" fill="currentColor" /><circle cx="17" cy="11" r="1.6" fill="currentColor" /></S>);
export const IcPlay = () => (<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3l8 5-8 5z" fill="currentColor" /></svg>);
export const IcPause = () => (<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 3h3v10h-3zM9 3h3v10H9z" fill="currentColor" /></svg>);
export const IcLink = () => (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M6.5 9.5l3-3M5 11a2.5 2.5 0 010-3.5L6.5 6M11 5a2.5 2.5 0 010 3.5L9.5 10" /></svg>);
export const IcHelp = () => (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true"><circle cx="8" cy="8" r="6.2" /><path d="M6.2 6.3a1.9 1.9 0 113.2 1.3c-.7.5-1.4.8-1.4 1.6M8 11.4v.2" /></svg>);
export const IcLock = () => (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></svg>);
export const IcSave = () => (<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M8 2v8M4.8 7.2L8 10.4l3.2-3.2M3 13h10" /></svg>);

/** レイアウト切替の図。rows×cols の格子。 */
export const IcGrid = ({ rows, cols }: { rows: number; cols: number }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
    <rect x="2" y="2" width="12" height="12" rx="1.5" />
    {cols > 1 && <path d="M8 2v12" />}
    {rows > 1 && <path d="M2 8h12" />}
  </svg>
);

export const IcLogo = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <rect x="1" y="1" width="22" height="22" rx="6" fill="#1a2330" stroke="#33404f" />
    <path d="M7 12h10M12 7v10" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" fill="none" />
    <circle cx="12" cy="12" r="6.5" stroke="var(--accent)" strokeWidth="1.5" fill="none" />
  </svg>
);
