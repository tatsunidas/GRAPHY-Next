/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * しきい値ダイアログ。セッションがあるあいだだけ表示。下限・上限（Wand と同じ判定値）と範囲（現在スライス／全スライス）を変えると、
 * アクティブ segment へ塗り直す（置換）。「適用」で確定、「取消」で元に戻す。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { getThresholdSession, subscribeThreshold, updateThresholdSession, type ThresholdScope } from "../viewer/thresholdStore";
import { runThreshold, commitThreshold, cancelThreshold } from "../viewer/thresholdTool";
import { getSegEditTarget } from "../viewer/roiMaskStore";
import { ValueSlider, NumField } from "./WandDialog";

const SCOPES: ThresholdScope[] = ["slice", "all"];

export function ThresholdDialog() {
  const { t } = useI18n();
  const [, force] = useState(0);
  useEffect(() => subscribeThreshold(() => force((n) => n + 1)), []);
  const s = getThresholdSession();
  if (!s) return null;

  const rerun = () => {
    const cur = getThresholdSession();
    if (cur) void runThreshold(cur);
  };
  const setBound = (which: "lower" | "upper", v: number) => {
    updateThresholdSession(which === "lower" ? { lower: v, touched: true } : { upper: v, touched: true });
    rerun();
  };
  const setScope = (scope: ThresholdScope) => {
    updateThresholdSession({ scope });
    rerun();
  };
  const kindKey = s.valueKind === "calibrated" ? (s.unit ? "wand.valueKind.calibrated" : "wand.valueKind.calibratedNoUnit") : s.valueKind === "luminance" ? "wand.valueKind.luminance" : "wand.valueKind.stored";

  return (
    <div data-testid="threshold-dialog" style={panel}>
      <div style={header}>{t("threshold.title")}</div>
      <div style={rowInfo} data-testid="threshold-value-kind">{t(kindKey, { unit: s.unit })}</div>
      <div style={rowInfo}>
        <span style={label}>{t("threshold.target")}</span>
        <span style={mono} data-testid="threshold-target">{getSegEditTarget().segmentIndex}</span>
      </div>
      <div style={rowInfo}>
        <span style={label}>{t("threshold.scope")}</span>
        <span style={{ display: "flex", gap: 4 }}>
          {SCOPES.map((v) => (
            <button key={v} data-testid={`threshold-scope-${v}`} onClick={() => setScope(v)} style={s.scope === v ? chipOn : chip}>
              {t(`threshold.scope.${v}`)}
            </button>
          ))}
        </span>
      </div>
      <div style={rangeRow}>
        <span style={label}>{t("wand.lower")}</span>
        <ValueSlider value={s.lower} min={s.rangeMin} max={s.rangeMax} onChange={(v) => setBound("lower", v)} />
        <NumField testid="threshold-lower" value={s.lower} onCommit={(v) => setBound("lower", v)} title={t("wand.thresholdInput")} />
        <span style={label}>{s.unit}</span>
      </div>
      <div style={rangeRow}>
        <span style={label}>{t("wand.upper")}</span>
        <ValueSlider value={s.upper} min={s.rangeMin} max={s.rangeMax} onChange={(v) => setBound("upper", v)} />
        <NumField testid="threshold-upper" value={s.upper} onCommit={(v) => setBound("upper", v)} title={t("wand.thresholdInput")} />
        <span style={label}>{s.unit}</span>
      </div>
      <div style={{ ...rowInfo, marginTop: 8 }}>
        <span style={label}>{t("wand.count")}</span>
        <span style={mono} data-testid="threshold-count">{s.count ?? 0}</span>
      </div>
      {!s.touched && <div style={note}>{t("threshold.hint")}</div>}
      {s.invalid && <div data-testid="threshold-invalid" style={warn}>{t("threshold.invalid")}</div>}
      <div style={footer}>
        <button data-testid="threshold-cancel" onClick={() => cancelThreshold()} style={btn}>{t("wand.cancel")}</button>
        <button data-testid="threshold-commit" onClick={() => commitThreshold()} style={btnPrimary}>{t("threshold.apply")}</button>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "fixed", top: 90, right: 16, width: 280, zIndex: 60,
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 8px 28px rgba(0,0,0,0.18)", padding: 10, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontWeight: 600, color: "#0b5cad", marginBottom: 6 };
const rowInfo: React.CSSProperties = { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "2px 0" };
const rangeRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 4 };
const label: React.CSSProperties = { color: "#5a6672" };
const mono: React.CSSProperties = { fontFamily: "monospace" };
const note: React.CSSProperties = { marginTop: 5, color: "#7a8591", fontSize: 11 };
const warn: React.CSSProperties = { marginTop: 6, color: "#b45309", background: "#fff7e6", border: "1px solid #f3d19e", borderRadius: 4, padding: "3px 6px" };
const chip: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer", fontSize: 11, padding: "2px 7px" };
const chipOn: React.CSSProperties = { ...chip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10 };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "4px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
