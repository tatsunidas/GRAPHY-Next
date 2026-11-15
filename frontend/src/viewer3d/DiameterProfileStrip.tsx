/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 幾何ウィンドウの下帯: 血管の 1 区間の「弧長 対 径」。
 *
 * <p>CT 由来のモデル（`ct-vessel`）だけに出す。XA の径は未校正（px 由来）のことが多く、既存の XA 画面は変えない。
 * 区間はセレクタで選ぶ。値の解釈（狭窄率・正常範囲）は出さない——測った径の並びと、その最小だけを見せる。
 *
 * <p>🔴 測れなかった点（null）は線を切る（補間しない・0 で埋めない）。Y 軸は 0 から始める（細さを誇張しない）。
 */
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VesselModel } from "../viewer/xaVesselModelStore";
import { diameterProfile, nearestIndex } from "./diameterProfile";

const PLOT_H = 96;

export function DiameterProfileStrip({ model }: { model: VesselModel }) {
  const { t } = useI18n();
  const [segId, setSegId] = useState<string | null>(null);
  const [hover, setHover] = useState<number | null>(null);

  if (model.kind !== "ct-vessel" || model.segments.length === 0) return null;
  const seg = model.segments.find((s) => s.id === segId) ?? model.segments[0];
  const profile = model.calibration.diameterCalibrated ? diameterProfile(seg.points, seg.diameterMm) : null;

  const select = (
    <label style={lbl}>
      {t("geometry3d.profile.segment")}
      <select
        style={sel}
        data-testid="geometry3d-profile-segment"
        value={seg.id}
        onChange={(e) => {
          setSegId(e.target.value);
          setHover(null);
        }}
      >
        {model.segments.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name ?? s.id}
          </option>
        ))}
      </select>
    </label>
  );

  let body: React.ReactNode;
  let minText: React.ReactNode = null;
  if (!model.calibration.diameterCalibrated) {
    body = (
      <div style={note} data-testid="geometry3d-diameter-uncalibrated">
        {t("geometry3d.profile.uncalibrated")}
      </div>
    );
  } else if (!profile || profile.min === null || profile.max === null) {
    body = (
      <div style={note} data-testid="geometry3d-diameter-none">
        {t("geometry3d.profile.none")}
      </div>
    );
  } else {
    const ymax = profile.max * 1.1 || 1;
    const xs = (arc: number) => (profile.lengthMm > 0 ? (arc / profile.lengthMm) * 1000 : 0);
    const ys = (d: number) => PLOT_H - (d / ymax) * PLOT_H;
    const pathOf = (run: { arcMm: number; d: number }[]) =>
      run.map((p, i) => `${i === 0 ? "M" : "L"}${xs(p.arcMm).toFixed(2)} ${ys(p.d).toFixed(2)}`).join(" ");
    const hi = hover === null ? null : hover;
    const hd = hi === null ? null : seg.diameterMm[hi];
    minText = (
      <span style={minStyle} data-testid="geometry3d-min-diameter">
        {t("geometry3d.profile.min", { d: profile.min.d.toFixed(1), s: profile.min.arcMm.toFixed(1) })}
      </span>
    );
    body = (
      <div style={plotWrap}>
        <div style={yLabels}>
          <span>{ymax.toFixed(1)}</span>
          <span>0</span>
        </div>
        <div
          style={plotBox}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            if (r.width <= 0) return;
            setHover(nearestIndex(profile.arcMm, ((e.clientX - r.left) / r.width) * profile.lengthMm));
          }}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            viewBox={`0 0 1000 ${PLOT_H}`}
            preserveAspectRatio="none"
            style={svgStyle}
            data-testid="geometry3d-diameter-profile"
            data-segment={seg.id}
            data-valid={String(profile.nValid)}
            data-runs={String(profile.runs.length)}
            data-min={profile.min.d.toFixed(3)}
            data-min-arc={profile.min.arcMm.toFixed(3)}
            data-length={profile.lengthMm.toFixed(3)}
          >
            <line x1="0" y1={PLOT_H} x2="1000" y2={PLOT_H} stroke="#33424e" strokeWidth="1" vectorEffect="non-scaling-stroke" />
            {profile.runs.map((run, i) =>
              run.length === 1 ? (
                // 1 点だけ測れた所は線にならない。点として出す（黙って消さない）。
                <circle key={i} cx={xs(run[0].arcMm)} cy={ys(run[0].d)} r="2" fill="#5ac8e0" />
              ) : (
                <path key={i} d={pathOf(run)} fill="none" stroke="#5ac8e0" strokeWidth="2" vectorEffect="non-scaling-stroke" />
              ),
            )}
          </svg>
          <span
            style={{ ...marker, left: `${(xs(profile.min.arcMm) / 1000) * 100}%`, top: `${ys(profile.min.d)}px` }}
            data-testid="geometry3d-min-marker"
          />
          {hi !== null ? (
            <span style={hoverStyle} data-testid="geometry3d-profile-hover">
              {t("geometry3d.profile.at", {
                s: profile.arcMm[hi].toFixed(1),
                d: hd === null || !Number.isFinite(hd) ? t("geometry3d.profile.unmeasured") : `${hd.toFixed(1)} mm`,
              })}
            </span>
          ) : null}
          <div style={xLabels}>
            <span>0</span>
            <span>{t("geometry3d.profile.axisArc")}</span>
            <span>{profile.lengthMm.toFixed(1)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={strip} data-testid="geometry3d-profile-strip">
      <div style={head}>
        <span style={titleStyle}>{t("geometry3d.profile.title")}</span>
        {select}
        {minText}
        <span style={{ flex: 1 }} />
        <span style={faint}>{t("geometry3d.profile.axisDiameter")}</span>
      </div>
      {body}
    </div>
  );
}

const strip: React.CSSProperties = { borderTop: "1px solid #1e2a33", padding: "4px 10px 2px", fontSize: 11, flex: "0 0 auto" };
const head: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, marginBottom: 2 };
const titleStyle: React.CSSProperties = { fontWeight: 600 };
const lbl: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, color: "#8fa1b0" };
const sel: React.CSSProperties = { background: "#18222a", color: "#dfe7ee", border: "1px solid #33424e", borderRadius: 3, fontSize: 11 };
const minStyle: React.CSSProperties = { color: "#dfe7ee" };
const faint: React.CSSProperties = { color: "#8fa1b0" };
const note: React.CSSProperties = { color: "#e0a35a", padding: "6px 0" };
const plotWrap: React.CSSProperties = { display: "flex", gap: 4 };
const yLabels: React.CSSProperties = { width: 30, height: PLOT_H, display: "flex", flexDirection: "column", justifyContent: "space-between", color: "#8fa1b0", textAlign: "right" };
const plotBox: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0, height: PLOT_H + 14 };
const svgStyle: React.CSSProperties = { width: "100%", height: PLOT_H, display: "block", background: "#0f171d" };
const marker: React.CSSProperties = { position: "absolute", width: 8, height: 8, marginLeft: -4, marginTop: -4, borderRadius: "50%", border: "2px solid #e0a35a", pointerEvents: "none" };
const hoverStyle: React.CSSProperties = { position: "absolute", right: 4, top: 2, background: "#18222a", border: "1px solid #33424e", borderRadius: 3, padding: "1px 6px", pointerEvents: "none" };
const xLabels: React.CSSProperties = { display: "flex", justifyContent: "space-between", color: "#8fa1b0" };
