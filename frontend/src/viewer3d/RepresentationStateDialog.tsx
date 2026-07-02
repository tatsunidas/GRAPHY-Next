/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Representation State ダイアログ（View メニュー > Representation State）。
 * 表示状態（向きの各軸角度・パン・ズーム・W/L・LUT・表示モード）を指定して表示に反映し、
 * 任意の見え方を再現できるようにする。向きは初期ビューからの azimuth/elevation/roll で指定。
 *
 * 幾何（向き/パン/ズーム/W-L）は `view` へ直接適用。モードと LUT は画面側の状態と LUT ロード機構を
 * 使うため `onApplied` 経由で画面へ委譲する。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchLutNames } from "../api";
import type { VtkVolumeView, VtkRenderMode } from "../viewer/vtkVolumeView";

const MODES: VtkRenderMode[] = ["VR", "MIP", "MINIP", "ORTHO"];

export function RepresentationStateDialog({
  view,
  lutName,
  onApplied,
  onClose,
}: {
  view: VtkVolumeView;
  lutName: string | null;
  onApplied: (patch: { mode: VtkRenderMode; lutName: string | null }) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [names, setNames] = useState<string[]>([]);
  const s0 = view.getState();
  const [mode, setMode] = useState<VtkRenderMode>(s0.mode);
  const [az, setAz] = useState(0);
  const [el, setEl] = useState(0);
  const [roll, setRoll] = useState(0);
  const [zoom, setZoom] = useState(s0.parallelScale);
  const [pan, setPan] = useState<[number, number, number]>(s0.focalPoint);
  const [center, setCenter] = useState(s0.center);
  const [width, setWidth] = useState(s0.width);
  const [lut, setLut] = useState<string | null>(lutName);

  useEffect(() => {
    fetchLutNames()
      .then(setNames)
      .catch(() => setNames([]));
  }, []);

  // 現在の表示状態を各フィールドへ取り込む（向きの角度は初期ビュー基準のため据置）。
  const capture = () => {
    const s = view.getState();
    setMode(s.mode);
    setZoom(s.parallelScale);
    setPan(s.focalPoint);
    setCenter(s.center);
    setWidth(s.width);
    setLut(lutName);
  };

  const apply = () => {
    // 1) 向き（初期ビューから az/el/roll 回転）。
    view.applyOrientation(az, el, roll);
    // 2) パン（焦点を desired へ平行移動）＋ズーム＋W/L。
    const s = view.getState();
    const dx = pan[0] - s.focalPoint[0];
    const dy = pan[1] - s.focalPoint[1];
    const dz = pan[2] - s.focalPoint[2];
    view.applyState({
      position: [s.position[0] + dx, s.position[1] + dy, s.position[2] + dz],
      focalPoint: [pan[0], pan[1], pan[2]],
      parallelScale: zoom > 0 ? zoom : s.parallelScale,
      center,
      width,
    });
    // 3) モードと LUT は画面側へ委譲。
    onApplied({ mode, lutName: lut });
  };

  const numField = (label: string, value: number, set: (v: number) => void, step = 1) => (
    <label style={row}>
      <span style={lbl}>{label}</span>
      <input type="number" step={step} value={round(value)} onChange={(e) => set(Number(e.target.value))} style={num} />
    </label>
  );

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={head}>{t("viewer3d.repr.title")}</div>

        <label style={row}>
          <span style={lbl}>{t("viewer3d.repr.mode")}</span>
          <select style={sel} value={mode} onChange={(e) => setMode(e.target.value as VtkRenderMode)}>
            {MODES.map((m) => (
              <option key={m} value={m}>
                {t(`viewer3d.mode.${m.toLowerCase()}`)}
              </option>
            ))}
          </select>
        </label>

        <div style={secLabel}>{t("viewer3d.repr.orientation")}</div>
        {numField(t("viewer3d.repr.azimuth"), az, setAz)}
        {numField(t("viewer3d.repr.elevation"), el, setEl)}
        {numField(t("viewer3d.repr.roll"), roll, setRoll)}

        <div style={secLabel}>{t("viewer3d.repr.pan")}</div>
        <div style={row}>
          <input type="number" value={round(pan[0])} onChange={(e) => setPan([Number(e.target.value), pan[1], pan[2]])} style={num} />
          <input type="number" value={round(pan[1])} onChange={(e) => setPan([pan[0], Number(e.target.value), pan[2]])} style={num} />
          <input type="number" value={round(pan[2])} onChange={(e) => setPan([pan[0], pan[1], Number(e.target.value)])} style={num} />
        </div>

        {numField(t("viewer3d.repr.zoom"), zoom, setZoom, 0.5)}

        <div style={secLabel}>{t("viewer3d.repr.wl")}</div>
        {numField(t("viewer3d.repr.level"), center, setCenter)}
        {numField(t("viewer3d.repr.window"), width, setWidth)}

        <label style={row}>
          <span style={lbl}>{t("viewer3d.repr.lut")}</span>
          <select style={sel} value={lut ?? ""} onChange={(e) => setLut(e.target.value || null)}>
            <option value="">{t("viewer3d.repr.lutGray")}</option>
            {names.map((n) => (
              <option key={n} value={n}>
                {n.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>

        <div style={foot}>
          <button style={btn} onClick={capture}>
            {t("viewer3d.repr.capture")}
          </button>
          <span style={{ flex: 1 }} />
          <button style={btn} onClick={onClose}>
            {t("common.close")}
          </button>
          <button style={btnPrimary} onClick={apply}>
            {t("viewer3d.repr.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

const round = (v: number) => Math.round(v * 100) / 100;

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
  width: 360,
  maxHeight: "90vh",
  overflowY: "auto",
  background: "#14181c",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 8,
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontFamily: "system-ui, sans-serif",
  fontSize: 13,
};
const head: React.CSSProperties = { fontWeight: 600, fontSize: 14, marginBottom: 2 };
const secLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#7f8b96",
  textTransform: "uppercase",
  letterSpacing: 0.4,
  marginTop: 6,
};
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6 };
const lbl: React.CSSProperties = { width: 96, flexShrink: 0, color: "#9aa6b2" };
const num: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  padding: "4px 6px",
};
const sel: React.CSSProperties = { ...num };
const foot: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, marginTop: 10 };
const btn: React.CSSProperties = {
  padding: "6px 12px",
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
