/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 内視鏡（fly-through）操作オーバーレイ。旧 GRAPHY のスライダ＋再生＋速度＋向きインジケータを
 * ビューポート上のフローティング UI として直感的に再構成する。
 *
 * 操作: スクラブスライダで位置移動 / 再生・一時停止 / 速度・視野角スライダ / 先頭・末尾ジャンプ /
 * 視線リセット / 終了。ビューポート内では **左ドラッグ=見回し・ホイール=前進後退**（`endoscopy.ts`）。
 * 左下に患者頭側（superior）を指す向きインジケータ（SVG 矢印）。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { EndoController, EndoState } from "../viewer/endoscopy";

export function EndoscopyControls({
  controller,
  onExit,
}: {
  controller: EndoController;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const [s, setS] = useState<EndoState>(controller.getState());

  useEffect(() => {
    setS(controller.getState());
    return controller.onChange(setS);
  }, [controller]);

  const posMm = (s.u * s.lengthMm).toFixed(1);

  return (
    <>
      {/* 向きインジケータ（左下）: 患者頭側 = 緑矢印 */}
      <OrientationIndicator arrow={s.arrow} label={t("endo.superior")} />

      {/* 操作バー（下部中央） */}
      <div style={bar}>
        <div style={rowTop}>
          <button style={iconBtn} title={t("endo.jumpStart")} onClick={() => controller.jumpStart()}>
            ⏮
          </button>
          <button
            style={playBtn}
            title={s.playing ? t("endo.pause") : t("endo.play")}
            onClick={() => controller.togglePlay()}
          >
            {s.playing ? "⏸" : "▶"}
          </button>
          <button style={iconBtn} title={t("endo.jumpEnd")} onClick={() => controller.jumpEnd()}>
            ⏭
          </button>
          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(s.u * 1000)}
            style={scrub}
            onChange={(e) => controller.setU(Number(e.target.value) / 1000)}
          />
          <span style={posText}>
            {posMm} / {s.lengthMm.toFixed(0)} mm
          </span>
          <button style={exitBtn} onClick={onExit}>
            {t("endo.exit")}
          </button>
        </div>
        <div style={rowBot}>
          <label style={lbl}>
            {t("endo.speed")}
            <input
              type="range"
              min={10}
              max={400}
              defaultValue={100}
              style={slider}
              onChange={(e) => controller.setSpeedPct(Number(e.target.value))}
            />
          </label>
          <label style={lbl}>
            {t("endo.fov")}
            <input
              type="range"
              min={20}
              max={150}
              value={Math.round(s.fovDeg)}
              style={slider}
              onChange={(e) => controller.setFovDeg(Number(e.target.value))}
            />
            <span style={val}>{Math.round(s.fovDeg)}°</span>
          </label>
          <button style={smBtn} onClick={() => controller.resetLook()}>
            {t("endo.resetLook")}
          </button>
        </div>
        <div style={hint}>{t("endo.navHint")}</div>
      </div>
    </>
  );
}

/** 患者頭側（superior）方向を指す SVG 矢印（左下固定）。arrow=[right成分, up成分]。 */
function OrientationIndicator({ arrow, label }: { arrow: [number, number]; label: string }) {
  const [rx, uy] = arrow;
  const len = Math.hypot(rx, uy) || 1;
  const dx = (rx / len) * 26;
  const dy = -(uy / len) * 26; // SVG は y 下向き
  const cx = 35, cy = 35;
  const tipX = cx + dx, tipY = cy + dy;
  // 矢じり。
  const ang = Math.atan2(dy, dx);
  const a1 = ang + Math.PI - 0.5;
  const a2 = ang + Math.PI + 0.5;
  return (
    <div style={indicator}>
      <svg width={70} height={70}>
        <circle cx={cx} cy={cy} r={30} fill="rgba(0,0,0,0.35)" stroke="#2c343b" />
        <line x1={cx} y1={cy} x2={tipX} y2={tipY} stroke="#39d353" strokeWidth={2.5} />
        <line x1={tipX} y1={tipY} x2={tipX + Math.cos(a1) * 8} y2={tipY + Math.sin(a1) * 8} stroke="#39d353" strokeWidth={2.5} />
        <line x1={tipX} y1={tipY} x2={tipX + Math.cos(a2) * 8} y2={tipY + Math.sin(a2) * 8} stroke="#39d353" strokeWidth={2.5} />
        <text x={cx} y={64} fill="#9aa6b2" fontSize={10} textAnchor="middle">
          {label}
        </text>
      </svg>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const bar: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 18,
  transform: "translateX(-50%)",
  zIndex: 50,
  background: "rgba(13,16,19,0.92)",
  border: "1px solid #2c343b",
  borderRadius: 10,
  padding: "10px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  minWidth: 520,
  color: "#e6eaee",
  fontFamily: "system-ui, sans-serif",
  boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
};
const rowTop: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const rowBot: React.CSSProperties = { display: "flex", alignItems: "center", gap: 16 };
const iconBtn: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 6,
  width: 32,
  height: 30,
  cursor: "pointer",
  fontSize: 13,
};
const playBtn: React.CSSProperties = { ...iconBtn, width: 40, background: "#0b5cad", border: "1px solid #0b5cad" };
const scrub: React.CSSProperties = { flex: 1, accentColor: "#0b5cad" };
const posText: React.CSSProperties = { fontSize: 11, color: "#9aa6b2", minWidth: 110, textAlign: "right", fontVariantNumeric: "tabular-nums" };
const exitBtn: React.CSSProperties = {
  background: "#3a2130",
  color: "#ffb4c4",
  border: "1px solid #5a3040",
  borderRadius: 6,
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 12,
};
const lbl: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9aa6b2" };
const slider: React.CSSProperties = { width: 130, accentColor: "#0b5cad" };
const val: React.CSSProperties = { fontSize: 11, color: "#c7d0d8", minWidth: 28 };
const smBtn: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 6,
  padding: "5px 10px",
  cursor: "pointer",
  fontSize: 11,
  marginLeft: "auto",
};
const hint: React.CSSProperties = { fontSize: 10.5, color: "#5a6672", textAlign: "center" };
const indicator: React.CSSProperties = { position: "fixed", left: 16, bottom: 18, zIndex: 50, pointerEvents: "none" };
