/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Cinematic rendering 設定ダイアログ（View メニュー > Cinematic rendering settings）。
 * lit-VR（`vtkVolumeProperty.setShade` ＋アンビエント/ディフューズ/スペキュラ＋勾配不透明度）を
 * リアルタイム調整する。値は `VtkVolumeView.setCinematic` 経由で即反映。
 */
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView, VtkCinematicParams } from "../viewer/vtkVolumeView";

export function CinematicSettingsDialog({
  view,
  onClose,
}: {
  view: VtkVolumeView;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [p, setP] = useState<VtkCinematicParams>(() => view.getCinematic());
  const range = view.getScalarRange();

  const update = (patch: Partial<VtkCinematicParams>) => {
    const next = { ...p, ...patch };
    setP(next);
    view.setCinematic(next);
  };

  const slider = (
    label: string,
    key: "ambient" | "diffuse" | "specular",
  ) => (
    <label style={row}>
      <span style={lbl}>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={Math.round(p[key] * 100)}
        onChange={(e) => update({ [key]: Number(e.target.value) / 100 } as Partial<VtkCinematicParams>)}
        style={rng}
      />
      <span style={val}>{p[key].toFixed(2)}</span>
    </label>
  );

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={head}>{t("viewer3d.cine.title")}</div>

        <label style={rowChk}>
          <input type="checkbox" checked={p.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span>{t("viewer3d.cine.enable")}</span>
        </label>

        <div style={{ opacity: p.enabled ? 1 : 0.5, pointerEvents: p.enabled ? "auto" : "none" }}>
          {slider(t("viewer3d.cine.ambient"), "ambient")}
          {slider(t("viewer3d.cine.diffuse"), "diffuse")}
          {slider(t("viewer3d.cine.specular"), "specular")}
          <label style={row}>
            <span style={lbl}>{t("viewer3d.cine.specularPower")}</span>
            <input
              type="range"
              min={1}
              max={50}
              value={Math.round(p.specularPower)}
              onChange={(e) => update({ specularPower: Number(e.target.value) })}
              style={rng}
            />
            <span style={val}>{Math.round(p.specularPower)}</span>
          </label>

          {/* ── シネマティック散乱（WebGL2）: ソフトシャドウ/大域照明/AO ── */}
          <div style={sectionHead}>{t("viewer3d.cine.scatterSection")}</div>
          <label style={rowChk}>
            <input
              type="checkbox"
              checked={p.computeNormalFromOpacity}
              onChange={(e) => update({ computeNormalFromOpacity: e.target.checked })}
            />
            <span>{t("viewer3d.cine.normalOpacity")}</span>
          </label>
          <label style={rowChk}>
            <input
              type="checkbox"
              checked={p.ambientOcclusion}
              onChange={(e) => update({ ambientOcclusion: e.target.checked })}
            />
            <span>{t("viewer3d.cine.ao")}</span>
          </label>
          <label style={row}>
            <span style={lbl}>{t("viewer3d.cine.scattering")}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(p.scattering * 100)}
              onChange={(e) => update({ scattering: Number(e.target.value) / 100 })}
              style={rng}
            />
            <span style={val}>{p.scattering.toFixed(2)}</span>
          </label>
          <label style={row}>
            <span style={lbl}>{t("viewer3d.cine.gi")}</span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(p.giReach * 100)}
              onChange={(e) => update({ giReach: Number(e.target.value) / 100 })}
              style={rng}
            />
            <span style={val}>{p.giReach.toFixed(2)}</span>
          </label>
          <label style={row}>
            <span style={lbl}>{t("viewer3d.cine.anisotropy")}</span>
            <input
              type="range"
              min={-90}
              max={90}
              value={Math.round(p.anisotropy * 100)}
              onChange={(e) => update({ anisotropy: Number(e.target.value) / 100 })}
              style={rng}
            />
            <span style={val}>{p.anisotropy.toFixed(2)}</span>
          </label>
        </div>

        <label style={rowChk}>
          <input
            type="checkbox"
            checked={p.gradientOpacity}
            onChange={(e) => update({ gradientOpacity: e.target.checked })}
          />
          <span>{t("viewer3d.cine.gradientOpacity")}</span>
        </label>
        <div style={{ opacity: p.gradientOpacity ? 1 : 0.5, pointerEvents: p.gradientOpacity ? "auto" : "none" }}>
          <label style={row}>
            <span style={lbl}>{t("viewer3d.cine.gradientMin")}</span>
            <input
              type="number"
              value={Math.round(p.gradientOpacityMin)}
              onChange={(e) => update({ gradientOpacityMin: Number(e.target.value) })}
              style={num}
            />
          </label>
          <label style={row}>
            <span style={lbl}>{t("viewer3d.cine.gradientMax")}</span>
            <input
              type="number"
              value={Math.round(p.gradientOpacityMax)}
              onChange={(e) => update({ gradientOpacityMax: Number(e.target.value) })}
              style={num}
            />
          </label>
          <div style={hint}>
            {t("viewer3d.cine.range", { min: Math.round(range[0]), max: Math.round(range[1]) })}
          </div>
        </div>

        <div style={foot}>
          <button style={btn} onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.4)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};
const panel: React.CSSProperties = {
  width: 340,
  background: "#14181c",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 8,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 10,
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
};
const head: React.CSSProperties = { fontWeight: 600, fontSize: 14, marginBottom: 4 };
const sectionHead: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#7f8b96",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  marginTop: 6,
  borderTop: "1px solid #23292f",
  paddingTop: 6,
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const rowChk: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, cursor: "pointer" };
const lbl: React.CSSProperties = { width: 110, flexShrink: 0, color: "#9aa6b2" };
const rng: React.CSSProperties = { flex: 1, minWidth: 0 };
const val: React.CSSProperties = { width: 34, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const num: React.CSSProperties = {
  flex: 1,
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  padding: "4px 6px",
};
const hint: React.CSSProperties = { fontSize: 11, color: "#5a6672", marginTop: 2 };
const foot: React.CSSProperties = { display: "flex", justifyContent: "flex-end", marginTop: 6 };
const btn: React.CSSProperties = {
  padding: "6px 14px",
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
};
