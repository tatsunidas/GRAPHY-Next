/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Wand（対話型リージョングロー）ダイアログ。
 * `wandStore` のセッションが有効な間だけ表示。シード（制御点）の座標・信号値を表示し、
 * 方式（許容差／以上／以下／範囲）・Connectivity・しきい値を変更すると、同じシードから再フラッドして結果を置換（Update）する。
 * どの方式も同じ判定値（Rescale 適用値／保存値／カラーの輝度）で判定する（`fw/segmentation-tools-design.md` §6.1）。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { getWandSession, subscribeWand, updateWandSession, type WandMethod, type WandSession } from "../viewer/wandStore";
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
const METHODS: WandMethod[] = ["tolerance", "ge", "le", "range"];

/** 表示用の数値（整数はそのまま、小数は有効数字 5 桁）。 */
const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(5))));

/** 判定値のスライダー（値域の外の値は端に寄せて表示。数値入力は値域の外も受け付ける）。 */
export function ValueSlider({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step="any"
      value={Math.min(Math.max(value, min), max)}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ flex: 1 }}
    />
  );
}

/** 数値入力（下書きを持ち、Enter/フォーカスアウトで確定。不正入力は元へ戻す）。 */
export function NumField({ value, onCommit, testid, title }: { value: number; onCommit: (v: number) => void; testid: string; title?: string }) {
  const [text, setText] = useState(fmt(value));
  useEffect(() => setText(fmt(value)), [value]);
  const apply = () => {
    if (text === fmt(value)) return; // 触っていない（表示は丸めてあるので、そのまま確定すると値が変わる）
    const v = Number(text);
    if (text.trim() !== "" && Number.isFinite(v)) onCommit(v);
    else setText(fmt(value));
  };
  return (
    <input
      type="number"
      data-testid={testid}
      value={text}
      title={title}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => { if (e.key === "Enter") { apply(); (e.target as HTMLInputElement).blur(); } }}
      onBlur={apply}
      style={numInput}
    />
  );
}

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
    if (sessThreshold !== undefined) setThText(fmt(sessThreshold));
  }, [sessThreshold, seedKey]);
  if (!s) return null;

  const conns = s.mode === "2d" ? CONN_2D : CONN_3D;
  const method: WandMethod = s.method ?? "tolerance";
  const unit = s.unit ?? "";
  const kind = s.valueKind ?? "calibrated";
  const lower = s.lower ?? s.seedValue;
  const upper = s.upper ?? s.seedValue;
  const vMin = s.rangeMin;
  const vMax = s.rangeMax;

  const rerun = () => {
    const cur = getWandSession();
    if (cur) runWand(cur);
  };
  const setThreshold = (v: number) => {
    if (!Number.isFinite(v) || v < 0) return;
    updateWandSession({ threshold: v });
    rerun();
  };
  const applyThText = () => {
    if (thText === fmt(s.threshold)) return;
    const v = Number(thText);
    if (Number.isFinite(v) && v >= 0) setThreshold(v);
    else setThText(fmt(s.threshold)); // 不正入力は元に戻す
  };
  const setMethod = (m: WandMethod) => {
    const seedCal = s.seedValue;
    // 切替直後の初期値はシードの判定値（シードが必ず条件を満たす）。範囲は上端を値域の最大へ。
    const patch: Partial<WandSession> = { method: m };
    if (m === "ge") patch.lower = seedCal;
    if (m === "le") patch.upper = seedCal;
    if (m === "range") {
      patch.lower = seedCal;
      patch.upper = Math.max(vMax, seedCal);
    }
    updateWandSession(patch);
    rerun();
  };
  const setBound = (which: "lower" | "upper", v: number) => {
    updateWandSession(which === "lower" ? { lower: v } : { upper: v });
    rerun();
  };
  const setConnectivity = (v: number) => {
    updateWandSession({ connectivity: v });
    rerun();
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
      {s.seedWorld && (
        <div style={rowInfo}>
          <span style={label}>LPS (mm)</span>
          <span style={mono}>{s.seedWorld.map((v) => v.toFixed(1)).join(", ")}</span>
        </div>
      )}
      <div style={rowInfo}>
        <span style={label}>{t("wand.seedValue")}</span>
        <span style={mono}>{fmt(s.seedValue)}{unit ? ` ${unit}` : ""}</span>
      </div>
      <div data-testid="wand-value-kind" style={note}>{t(`wand.valueKind.${kind === "calibrated" && !unit ? "calibratedNoUnit" : kind}`, { unit })}</div>

      <div style={block}>
        <div style={label}>{t("wand.method")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
          {METHODS.map((m) => {
            return (
              <button
                key={m}
                data-testid={`wand-method-${m}`}
                onClick={() => setMethod(m)}
                style={m === method ? chipOn : chip}
              >
                {t(`wand.method.${m}`)}
              </button>
            );
          })}
        </div>
      </div>

      <div style={block}>
        <div style={label}>{t("wand.connectivity")}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 3 }}>
          {conns.map((c) => (
            <button
              key={c.v}
              data-testid={`wand-conn-${c.v}`}
              onClick={() => setConnectivity(c.v)}
              style={c.v === s.connectivity ? chipOn : chip}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {method === "tolerance" && (
        <div style={block}>
          <div style={label}>{t("wand.threshold")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
            <ValueSlider value={s.threshold} min={0} max={Math.max(vMax - vMin, 0)} onChange={setThreshold} />
            <input
              type="number"
              min={0}
              data-testid="wand-threshold"
              value={thText}
              onChange={(e) => setThText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { applyThText(); (e.target as HTMLInputElement).blur(); } }}
              onBlur={applyThText}
              title={t("wand.thresholdInput")}
              style={numInput}
            />
            <span style={label}>{unit}</span>
          </div>
        </div>
      )}

      {(method === "ge" || method === "le") && (
        <div style={block}>
          <div style={label}>{t("wand.value")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
            <ValueSlider
              value={method === "ge" ? lower : upper}
              min={vMin}
              max={vMax}
              onChange={(v) => setBound(method === "ge" ? "lower" : "upper", v)}
            />
            <NumField
              testid="wand-threshold"
              value={method === "ge" ? lower : upper}
              onCommit={(v) => setBound(method === "ge" ? "lower" : "upper", v)}
              title={t("wand.thresholdInput")}
            />
            <span style={label}>{unit}</span>
          </div>
        </div>
      )}

      {method === "range" && (
        <div style={block}>
          <div style={rangeRow}>
            <span style={label}>{t("wand.lower")}</span>
            <ValueSlider value={lower} min={vMin} max={vMax} onChange={(v) => setBound("lower", v)} />
            <NumField testid="wand-threshold-lower" value={lower} onCommit={(v) => setBound("lower", v)} title={t("wand.thresholdInput")} />
            <span style={label}>{unit}</span>
          </div>
          <div style={rangeRow}>
            <span style={label}>{t("wand.upper")}</span>
            <ValueSlider value={upper} min={vMin} max={vMax} onChange={(v) => setBound("upper", v)} />
            <NumField testid="wand-threshold-upper" value={upper} onCommit={(v) => setBound("upper", v)} title={t("wand.thresholdInput")} />
            <span style={label}>{unit}</span>
          </div>
        </div>
      )}

      <div style={{ ...rowInfo, marginTop: 8 }}>
        <span style={label}>{t("wand.count")}</span>
        <span style={mono} data-testid="wand-count">{s.count ?? 0}</span>
      </div>
      {s.truncated && <div data-testid="wand-truncated" style={warn}>{t("wand.truncated")}</div>}
      {s.seedRejected && <div data-testid="wand-seed-rejected" style={warn}>{t("wand.seedRejected")}</div>}

      <div style={footer}>
        <button data-testid="wand-cancel" onClick={() => cancelWand()} style={btn}>{t("wand.cancel")}</button>
        <button data-testid="wand-commit" onClick={() => commitWand()} style={btnPrimary}>{t("wand.commit")}</button>
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
const rowInfo: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "1px 0" };
const rangeRow: React.CSSProperties = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, marginTop: 3 };
const label: React.CSSProperties = { color: "#5a6672" };
const mono: React.CSSProperties = { fontFamily: "monospace" };
const block: React.CSSProperties = { marginTop: 8 };
const chip: React.CSSProperties = {
  border: "1px solid #cdd5de", borderRadius: 5, background: "#fff", cursor: "pointer",
  fontSize: 11, padding: "2px 7px",
};
const chipOn: React.CSSProperties = { ...chip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
const warn: React.CSSProperties = { marginTop: 6, color: "#b45309", background: "#fff7e6", border: "1px solid #f3d19e", borderRadius: 4, padding: "3px 6px" };
const note: React.CSSProperties = { marginTop: 5, color: "#7a8591", fontSize: 11 };
const numInput: React.CSSProperties = { width: 72, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "1px 4px" };
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10 };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "4px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
