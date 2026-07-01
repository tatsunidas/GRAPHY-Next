/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Wand（対話型リージョングロー）ダイアログ。
 * `wandStore` のセッションが有効な間だけ表示。シード（制御点）の座標・信号値を表示し、
 * Connectivity / Threshold を変更すると同じシードから再フラッドして結果を置換（Update）する。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { getWandSession, subscribeWand, updateWandSession } from "../viewer/wandStore";
import { runWand, commitWand, cancelWand } from "../viewer/wandTool";

const CONN_2D = [
  { v: 4, label: "4 (edge)" },
  { v: 8, label: "8 (full)" },
];
const CONN_3D = [
  { v: 6, label: "6 (face)" },
  { v: 8, label: "8 (corner)" },
  { v: 12, label: "12 (edge)" },
  { v: 26, label: "26 (full)" },
];

export function WandDialog() {
  const { t } = useI18n();
  const [, force] = useState(0);
  useEffect(() => subscribeWand(() => force((n) => n + 1)), []);
  const s = getWandSession();
  // 数値入力の下書き（多桁を自由に打てるよう、確定＝Enter/フォーカスアウトまで session に反映しない）。
  const [thText, setThText] = useState("");
  const sessThreshold = s?.threshold;
  const seedKey = s ? `${s.seedX},${s.seedY},${s.seedZ}` : "";
  useEffect(() => {
    if (sessThreshold !== undefined) setThText(String(sessThreshold));
  }, [sessThreshold, seedKey]);
  if (!s) return null;

  const conns = s.mode === "2d" ? CONN_2D : CONN_3D;
  const sliderMax = Math.max(1, Math.ceil(s.rangeMax - s.rangeMin));

  const setThreshold = (v: number) => {
    if (!Number.isFinite(v) || v < 0) return;
    updateWandSession({ threshold: v });
    const cur = getWandSession();
    if (cur) runWand(cur);
  };
  const applyThText = () => {
    const v = Number(thText);
    if (Number.isFinite(v) && v >= 0) setThreshold(v);
    else setThText(String(s.threshold)); // 不正入力は元に戻す
  };
  const setConnectivity = (v: number) => {
    updateWandSession({ connectivity: v });
    const cur = getWandSession();
    if (cur) runWand(cur);
  };

  return (
    <div style={panel}>
      <div style={header}>
        <span>{t("wand.title")}（{s.mode === "2d" ? t("wand.mode2d") : t("wand.mode3d")}）</span>
      </div>

      <div style={rowInfo}>
        <span style={label}>{t("wand.seed")}</span>
        <span style={mono}>x{s.seedX} y{s.seedY} z{s.seedZ}</span>
      </div>
      <div style={rowInfo}>
        <span style={label}>{t("wand.seedValue")}</span>
        <span style={mono}>{s.seedValue}</span>
      </div>

      <div style={block}>
        <div style={label}>{t("wand.connectivity")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
          {conns.map((c) => (
            <button
              key={c.v}
              onClick={() => setConnectivity(c.v)}
              style={c.v === s.connectivity ? chipOn : chip}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div style={block}>
        <div style={label}>{t("wand.threshold")}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
          <input
            type="range"
            min={0}
            max={sliderMax}
            step={1}
            value={Math.min(s.threshold, sliderMax)}
            onChange={(e) => setThreshold(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <input
            type="number"
            min={0}
            value={thText}
            onChange={(e) => setThText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { applyThText(); (e.target as HTMLInputElement).blur(); } }}
            onBlur={applyThText}
            title={t("wand.thresholdInput")}
            style={numInput}
          />
        </div>
      </div>

      <div style={footer}>
        <button onClick={() => cancelWand()} style={btn}>{t("wand.cancel")}</button>
        <button onClick={() => commitWand()} style={btnPrimary}>{t("wand.commit")}</button>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "fixed", top: 90, right: 16, width: 260, zIndex: 60,
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 8px 28px rgba(0,0,0,0.18)", padding: 10, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontWeight: 600, color: "#0b5cad", marginBottom: 6 };
const rowInfo: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "1px 0" };
const label: React.CSSProperties = { color: "#5a6672" };
const mono: React.CSSProperties = { fontFamily: "monospace" };
const block: React.CSSProperties = { marginTop: 8 };
const chip: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer",
  fontSize: 11, padding: "2px 7px",
};
const chipOn: React.CSSProperties = { ...chip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
const numInput: React.CSSProperties = { width: 64, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "1px 4px" };
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10 };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "4px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
