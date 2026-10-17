/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Scissors ダイアログ。Scissors が有効な間だけ表示し、形（矩形・円・球）と操作（塗る／消す）を選ぶ。
 * 対象はアクティブな segment（右パネルで選んだもの）。範囲の外は変えない。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { getScissors, subscribeScissors, updateScissors, type ScissorsOp, type ScissorsShape } from "../viewer/scissorsStore";
import { getSegEditTarget } from "../viewer/roiMaskStore";

const SHAPES: ScissorsShape[] = ["rect", "circle", "sphere"];
const OPS: ScissorsOp[] = ["fill", "erase"];

export function ScissorsDialog() {
  const { t } = useI18n();
  const [, force] = useState(0);
  useEffect(() => subscribeScissors(() => force((n) => n + 1)), []);
  const s = getScissors();
  if (!s.active) return null;
  const seg = getSegEditTarget().segmentIndex;
  return (
    <div data-testid="scissors-dialog" style={panel}>
      <div style={header}>{t("scissors.title")}</div>
      <div style={row}>
        <span style={label}>{t("scissors.shape")}</span>
        <span style={{ display: "flex", gap: 4 }}>
          {SHAPES.map((v) => (
            <button key={v} data-testid={`scissors-shape-${v}`} onClick={() => updateScissors({ shape: v })} style={s.shape === v ? chipOn : chip}>
              {t(`scissors.shape.${v}`)}
            </button>
          ))}
        </span>
      </div>
      <div style={row}>
        <span style={label}>{t("scissors.op")}</span>
        <span style={{ display: "flex", gap: 4 }}>
          {OPS.map((v) => (
            <button key={v} data-testid={`scissors-op-${v}`} onClick={() => updateScissors({ op: v })} style={s.op === v ? chipOn : chip}>
              {t(`scissors.op.${v}`)}
            </button>
          ))}
        </span>
      </div>
      <div style={row}>
        <span style={label}>{t("scissors.target")}</span>
        <span style={mono} data-testid="scissors-target">{seg}</span>
      </div>
      {s.shape === "sphere" && <div style={note}>{t("scissors.sphereNote")}</div>}
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "fixed", top: 90, right: 16, width: 280, zIndex: 60,
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 8px 28px rgba(0,0,0,0.18)", padding: 10, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontWeight: 600, color: "#0b5cad", marginBottom: 6 };
const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "3px 0" };
const label: React.CSSProperties = { color: "#5a6672" };
const mono: React.CSSProperties = { fontFamily: "monospace" };
const note: React.CSSProperties = { marginTop: 5, color: "#7a8591", fontSize: 11 };
const chip: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 11, padding: "2px 7px" };
const chipOn: React.CSSProperties = { ...chip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
