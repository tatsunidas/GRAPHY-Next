/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * solid（箱・楕円体・球）の管理 UI の窓非依存な部品。2D の ROI マネージャと MPR の計測ダイアログが共有する。
 * 窓固有の処理（塗りにする等）は持たない。配色は継承（`currentColor`）で、置かれた窓の見た目に従う。
 */
import { useI18n } from "../i18n/i18n";
import { formatMl, formulaText, outOfBounds, volumeMl, type Bounds6, type Roi3dBox } from "./roi3dBox";

export interface SolidInfo {
  volumeText: string;
  formula: string;
  /** `bounds` が渡され、かつ形がそこからはみ出すとき true。bounds が無ければ判定しない（false）。 */
  outside: boolean;
}

export function solidInfo(s: Roi3dBox, bounds: Bounds6 | null): SolidInfo {
  return { volumeText: `${formatMl(volumeMl(s))} mL`, formula: formulaText(s), outside: bounds ? outOfBounds(s, bounds) : false };
}

interface HeaderProps {
  solid: Roi3dBox;
  onChange: (s: Roi3dBox) => void;
  defaultName: string;
  /** 形アイコンのツールチップ。 */
  iconTitle: string;
  /** 名前欄の見た目（窓の配色・幅に合わせる）。 */
  nameStyle?: React.CSSProperties;
}

/** 表示切替・形アイコン・名前・色。2D の行と MPR の行で同じ。 */
export function SolidRoiHeader({ solid: s, onChange, defaultName, iconTitle, nameStyle }: HeaderProps) {
  const { t } = useI18n();
  const color = s.color ?? "#00e5ff";
  const upd = (patch: Partial<Roi3dBox>) => onChange({ ...s, ...patch });
  return (
    <>
      <button
        onClick={() => upd({ visible: s.visible === false })}
        style={eyeBtn}
        title={t("roiMgr.visible")}
        data-testid="roi-row-visible"
      >{s.visible !== false ? "👁" : "🚫"}</button>
      <span title={iconTitle} style={{ color }}>{s.shape === "box" ? "▣" : "◍"}</span>
      <input
        type="text"
        style={nameStyle ?? nameInput}
        defaultValue={s.label ?? defaultName}
        onChange={(e) => upd({ label: e.target.value })}
        data-testid="solid-name"
      />
      <input type="color" defaultValue={color} onChange={(e) => upd({ color: e.target.value })} title={t("roiMgr.color")} style={colorInput} />
    </>
  );
}

/** 容積・式・範囲外警告。`compact` は容積と注記を出さない（一覧が容積列と注記を既に持つ窓向け）。 */
export function SolidRoiInfo({ solid, bounds, compact = false }: { solid: Roi3dBox; bounds: Bounds6 | null; compact?: boolean }) {
  const { t } = useI18n();
  const info = solidInfo(solid, bounds);
  return (
    <div data-testid="solid-info">
      {!compact && (
        <div>
          <span style={dim}>{t("mpr.roi3d.volume")}: </span>
          <span data-testid="solid-info-volume">{info.volumeText}</span>
        </div>
      )}
      <div>
        <span style={dim}>{t("mpr.roi3d.formula")}: </span>
        <span data-testid="mpr-roi3d-formula">{info.formula}</span>
      </div>
      {info.outside && <div style={warn} data-testid="mpr-roi3d-warn">{t("mpr.roi3d.outOfVolume")}</div>}
      {!compact && <div style={dim}>{t("mpr.roi3d.note")}</div>}
    </div>
  );
}

const dim: React.CSSProperties = { opacity: 0.65 };
const warn: React.CSSProperties = { color: "#d9822b" };
const eyeBtn: React.CSSProperties = { border: "none", background: "transparent", cursor: "pointer", fontSize: 13, padding: 0, lineHeight: 1 };
const nameInput: React.CSSProperties = { width: 90, fontSize: 11, border: "1px solid #8a94a0", borderRadius: 4, background: "transparent", color: "inherit" };
const colorInput: React.CSSProperties = { width: 22, height: 20, padding: 0, border: "1px solid #8a94a0", borderRadius: 3, background: "transparent", cursor: "pointer" };
