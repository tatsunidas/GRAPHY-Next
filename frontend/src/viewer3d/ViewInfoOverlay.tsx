/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * canvas 上に現在の表示状態（モード・回転・ズーム・焦点座標・W/L・LUT）を Info として表示する。
 * `VtkVolumeView.onStateChanged` を購読し、カメラ操作/W-L 変更のたびに更新する。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";

export function ViewInfoOverlay({ view, lutName }: { view: VtkVolumeView; lutName: string | null }) {
  const { t } = useI18n();
  const [, tick] = useState(0);

  useEffect(() => {
    return view.onStateChanged(() => tick((n) => n + 1));
  }, [view]);

  const s = view.getState();
  const f = s.focalPoint;
  const line = (label: string, value: string) => (
    <div style={rowStyle}>
      <span style={key}>{label}</span>
      <span style={val}>{value}</span>
    </div>
  );

  return (
    <div style={box}>
      {line(t("viewer3d.info.mode"), t(`viewer3d.mode.${s.mode.toLowerCase()}`))}
      {line(t("viewer3d.info.rotation"), `Az ${s.azimuth.toFixed(0)}° / El ${s.elevation.toFixed(0)}°`)}
      {line(t("viewer3d.info.zoom"), s.parallelScale.toFixed(1))}
      {line(t("viewer3d.info.origin"), `${f[0].toFixed(1)}, ${f[1].toFixed(1)}, ${f[2].toFixed(1)}`)}
      {line(t("viewer3d.info.wl"), `${Math.round(s.center)} / ${Math.round(s.width)}`)}
      {line(t("viewer3d.info.lut"), lutName ? lutName.replace(/_/g, " ") : t("viewer3d.repr.lutGray"))}
    </div>
  );
}

const box: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  padding: "6px 10px",
  background: "rgba(10,14,18,0.6)",
  border: "1px solid #2c343b",
  borderRadius: 6,
  color: "#c7d0d8",
  font: "11px/1.5 ui-monospace, monospace",
  pointerEvents: "none",
  zIndex: 5,
  minWidth: 150,
};
const rowStyle: React.CSSProperties = { display: "flex", gap: 8, justifyContent: "space-between" };
const key: React.CSSProperties = { color: "#7f8b96" };
const val: React.CSSProperties = { fontVariantNumeric: "tabular-nums" };
