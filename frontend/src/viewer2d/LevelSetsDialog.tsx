/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Level Sets ダイアログ（L2: Fast Marching ＋ Active Contours、fw/level-sets-design.md §5/§6）。
 * `levelSetsStore` のセッションが有効な間だけ表示。Fiji のフィールド並び・グルーピングを踏襲する。
 * パラメータを変更すると同じ起点（シード or 既存マスクのスナップショット）から再実行して
 * 結果を置換（Update）する。
 */
import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { getLevelSetSession, subscribeLevelSet, updateLevelSetSession } from "../viewer/levelSetsStore";
import { runLevelSet, commitLevelSet, cancelLevelSet } from "../viewer/levelSetsTool";
import type { RegionExpandsTo } from "../viewer/levelSetsCore";
import type { LevelSetMethod } from "../viewer/levelSetsStore";

type NumKey =
  | "fm.greyValueThreshold" | "fm.distanceThreshold"
  | "ac.advection" | "ac.curvature" | "ac.grayscaleTolerance" | "ac.convergence" | "ac.narrowBand"
  | "ac.propagation" | "ac.edgeSigma";

export function LevelSetsDialog() {
  const { t } = useI18n();
  const [, force] = useState(0);
  useEffect(() => subscribeLevelSet(() => force((n) => n + 1)), []);
  const s = getLevelSetSession();
  // 数値入力の下書き（Wand ダイアログと同じく、確定＝Enter/フォーカスアウトまで session に反映しない）。
  const [drafts, setDrafts] = useState<Record<NumKey, string>>({} as Record<NumKey, string>);
  const seedKey = s ? `${s.seedX},${s.seedY},${s.seedZ}` : "";
  useEffect(() => {
    if (!s) return;
    setDrafts({
      "fm.greyValueThreshold": String(s.fastMarching.greyValueThreshold),
      "fm.distanceThreshold": String(s.fastMarching.distanceThreshold),
      "ac.advection": String(s.activeContours.advection),
      "ac.curvature": String(s.activeContours.curvature),
      "ac.grayscaleTolerance": String(s.activeContours.grayscaleTolerance),
      "ac.convergence": String(s.activeContours.convergence),
      "ac.narrowBand": String(s.activeContours.narrowBand),
      "ac.propagation": String(s.activeContours.propagation),
      "ac.edgeSigma": String(s.activeContours.edgeSigma),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);
  if (!s) return null;

  const run = () => { const cur = getLevelSetSession(); if (cur) void runLevelSet(cur); };

  const setFastMarching = (patch: Partial<typeof s.fastMarching>) => {
    updateLevelSetSession({ fastMarching: { ...s.fastMarching, ...patch } });
    run();
  };
  const setActiveContours = (patch: Partial<typeof s.activeContours>) => {
    updateLevelSetSession({ activeContours: { ...s.activeContours, ...patch } });
    run();
  };
  const toggleFastMarching = (enabled: boolean) => {
    if (!enabled && !s.activeContours.enabled) return; // 両方 OFF は不可
    setFastMarching({ enabled });
  };
  const toggleActiveContours = (enabled: boolean) => {
    if (!enabled && !s.fastMarching.enabled) return; // 両方 OFF は不可
    setActiveContours({ enabled });
  };

  const applyNum = (key: NumKey, min: number, commit: (v: number) => void) => {
    const v = Number(drafts[key]);
    if (Number.isFinite(v) && v >= min) commit(v);
    else setDrafts((d) => ({ ...d, [key]: d[key] })); // 不正入力はそのまま（次の subscribe 更新で戻る）
  };
  const numField = (key: NumKey, min: number, step: number, commit: (v: number) => void, disabled?: boolean) => (
    <input
      type="number" min={min} step={step} value={drafts[key] ?? ""} disabled={disabled}
      onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
      onKeyDown={(e) => { if (e.key === "Enter") { applyNum(key, min, commit); (e.target as HTMLInputElement).blur(); } }}
      onBlur={() => applyNum(key, min, commit)}
      style={disabled ? { ...numInput, opacity: 0.5 } : numInput}
    />
  );

  return (
    <div style={panel}>
      <div style={header}>
        <span>{t("levelset.title")}</span>
      </div>

      <div style={rowInfo}>
        <span style={label}>{t("levelset.seed")}</span>
        <span style={mono}>x{s.seedX} y{s.seedY} z{s.seedZ}</span>
      </div>
      <div style={rowInfo}>
        <span style={label}>{t("levelset.seedValue")}</span>
        <span style={mono}>{s.seedValue}</span>
      </div>

      {/* Use Fast Marching */}
      <label style={checkboxRow}>
        <input type="checkbox" checked={s.fastMarching.enabled} onChange={(e) => toggleFastMarching(e.target.checked)} />
        <strong>{t("levelset.useFastMarching")}</strong>
      </label>
      <div style={block}>
        <div style={label}>{t("levelset.greyValueThreshold")}</div>
        {numField("fm.greyValueThreshold", 0, 1, (v) => setFastMarching({ greyValueThreshold: v }), !s.fastMarching.enabled)}
      </div>
      <div style={block}>
        <div style={label}>{t("levelset.distanceThreshold")}</div>
        {numField("fm.distanceThreshold", 1, 1, (v) => setFastMarching({ distanceThreshold: v }), !s.fastMarching.enabled)}
      </div>

      {/* Use Level Sets (Active Contours) */}
      <label style={checkboxRow}>
        <input type="checkbox" checked={s.activeContours.enabled} onChange={(e) => toggleActiveContours(e.target.checked)} />
        <strong>{t("levelset.useLevelSets")}</strong>
      </label>
      <div style={block}>
        <div style={label}>{t("levelset.method")}</div>
        <select
          value={s.activeContours.method}
          disabled={!s.activeContours.enabled}
          onChange={(e) => setActiveContours({ method: e.target.value as LevelSetMethod })}
          style={numInput}
        >
          <option value="activeContours">{t("levelset.methodActiveContours")}</option>
          <option value="geodesicActiveContours">{t("levelset.methodGAC")}</option>
        </select>
      </div>
      <div style={hint}>{t("levelset.notAllUsed")}</div>
      {(() => {
        const isGAC = s.activeContours.method === "geodesicActiveContours";
        const acOff = !s.activeContours.enabled;
        return (
          <>
            <div style={block}>
              <div style={label}>{t("levelset.advection")}</div>
              {numField("ac.advection", 0, 0.1, (v) => setActiveContours({ advection: v }), acOff)}
            </div>
            <div style={block}>
              <div style={label}>{t("levelset.propagation")} {!isGAC && <span style={hint}>{t("levelset.gacOnly")}</span>}</div>
              {numField("ac.propagation", 0, 0.1, (v) => setActiveContours({ propagation: v }), acOff || !isGAC)}
            </div>
            <div style={block}>
              <div style={label}>{t("levelset.curvature")}</div>
              {numField("ac.curvature", 0, 0.1, (v) => setActiveContours({ curvature: v }), acOff)}
            </div>
            <div style={block}>
              <div style={label}>{t("levelset.grayscaleTolerance")} {isGAC && <span style={hint}>{t("levelset.acOnly")}</span>}</div>
              {numField("ac.grayscaleTolerance", 0, 1, (v) => setActiveContours({ grayscaleTolerance: v }), acOff || isGAC)}
            </div>
            <div style={block}>
              <div style={label}>{t("levelset.edgeSigma")} {!isGAC && <span style={hint}>{t("levelset.gacOnly")}</span>}</div>
              {numField("ac.edgeSigma", 0, 0.1, (v) => setActiveContours({ edgeSigma: v }), acOff || !isGAC)}
            </div>
            <div style={block}>
              <div style={label}>{t("levelset.convergence")}</div>
              {numField("ac.convergence", 0.0001, 0.0001, (v) => setActiveContours({ convergence: v }), acOff)}
            </div>
            <div style={block}>
              <div style={label}>{t("levelset.narrowBand")}</div>
              {numField("ac.narrowBand", 1, 1, (v) => setActiveContours({ narrowBand: v }), acOff)}
            </div>
          </>
        );
      })()}
      <div style={block}>
        <div style={label}>{t("levelset.regionExpandsTo")}</div>
        <select
          value={s.activeContours.regionExpandsTo}
          disabled={!s.activeContours.enabled}
          onChange={(e) => setActiveContours({ regionExpandsTo: e.target.value as RegionExpandsTo })}
          style={numInput}
        >
          <option value="outside">{t("levelset.expandOutside")}</option>
          <option value="inside">{t("levelset.expandInside")}</option>
        </select>
      </div>

      <div style={rowInfo}>
        <span style={label}>{t("levelset.status")}</span>
        <span style={mono}>
          {s.status === "running" ? t("levelset.statusRunning")
            : s.status === "error" ? t("levelset.statusError")
            : s.status === "noInitContour" ? t("levelset.statusNoInit")
            : s.reachedCount}
        </span>
      </div>
      {s.status === "done" && s.activeContours.enabled && s.iterations !== undefined && (
        <div style={rowInfo}>
          <span style={label}>{t("levelset.iterations")}</span>
          <span style={mono}>{s.iterations}{s.lastChange !== undefined ? ` (Δ${s.lastChange.toFixed(4)})` : ""}</span>
        </div>
      )}

      <div style={footer}>
        <button onClick={() => cancelLevelSet()} style={btn}>{t("levelset.cancel")}</button>
        <button onClick={() => commitLevelSet()} style={btnPrimary}>{t("levelset.commit")}</button>
      </div>
    </div>
  );
}

const panel: React.CSSProperties = {
  position: "fixed", top: 90, right: 16, width: 280, zIndex: 60, maxHeight: "80vh", overflowY: "auto",
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 8px 28px rgba(0,0,0,0.18)", padding: 10, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontWeight: 600, color: "#0b5cad", marginBottom: 6 };
const rowInfo: React.CSSProperties = { display: "flex", justifyContent: "space-between", padding: "1px 0" };
const label: React.CSSProperties = { color: "#5a6672" };
const mono: React.CSSProperties = { fontFamily: "monospace" };
const block: React.CSSProperties = { marginTop: 6 };
const hint: React.CSSProperties = { fontSize: 10, color: "#9aa6b2", marginTop: 4, fontStyle: "italic" };
const checkboxRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginTop: 10, cursor: "pointer" };
const numInput: React.CSSProperties = { width: "100%", border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "3px 6px", marginTop: 3, boxSizing: "border-box" };
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10 };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "4px 12px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
