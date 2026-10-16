/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * つなぎ合わせダイアログ（第 1 段: 同じ座標系・同じ向きの部分シリーズを、重なりは平均で 1 本の派生シリーズにする）。
 * 設計: `fw/volume-regrid-design.md`「結合」。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { metaData } from "@cornerstonejs/core";
import { useI18n } from "../i18n/i18n";
import type { Study, Series, Instance } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import { loadRegVolume, type LoadedRegVolume } from "../viewer/regVolumeLoader";
import { estimateGridBytes } from "../viewer/gridResample";
import { saveDerivedVolume } from "../viewer/derivedVolumeSave";
import { suvForImageId } from "../viewer/suvStore";
import { extractSuvParams } from "../viewer/suv";
import { getAppliedVolumeMaxMb } from "../viewer/volumeMemory";
import {
  checkStitchInputs,
  stitchSlices,
  unionGrid,
  type StitchGrid,
  type StitchInput,
  type StitchViolation,
} from "../viewer/volumeStitch";
import {
  concatSlices,
  divideInput,
  petInfoFromSuvParams,
  stitchBackground,
  stitchDerivation,
  toStitchInput,
} from "../viewer/stitchInputs";

export interface StitchCandidate {
  id: string;
  study: Study;
  series: Series;
  instances: Instance[];
  c: number;
  t: number;
}

type Entry =
  | { state: "loading"; done: number; total: number }
  | { state: "ready"; loaded: LoadedRegVolume; input: StitchInput; suvScale: number | null }
  | { state: "unsupported" }
  | { state: "failed"; error: string };

const VIOLATIONS: StitchViolation[] = ["tooFew", "patient", "frameOfReference", "orientation", "modality", "petReference"];
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const MB = 1024 * 1024;

function parsePositive(s: string): number | null {
  const v = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(v) && v > 0 ? v : null;
}

export function StitchDialog({
  patientId,
  candidates,
  mode,
  onClose,
}: {
  patientId: string;
  candidates: StitchCandidate[];
  mode: ViewerMode;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [spOver, setSpOver] = useState<[string, string, string] | null>(null);
  const [bgOver, setBgOver] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      for (const cand of candidates) {
        const set = (e: Entry) => alive.current && setEntries((p) => ({ ...p, [cand.id]: e }));
        set({ state: "loading", done: 0, total: cand.instances.length });
        try {
          const v = await loadRegVolume(
            mode, cand.study.studyInstanceUid, cand.series.seriesInstanceUid, cand.instances, cand.c, cand.t,
            (n, all) => set({ state: "loading", done: n, total: all }),
          );
          if (!alive.current) return;
          if (!v) { set({ state: "unsupported" }); continue; }
          let pet;
          if ((v.modality === "PT" || v.modality === "NM") && v.firstImageId) {
            pet = petInfoFromSuvParams(extractSuvParams(v.firstImageId));
          }
          const suv = suvForImageId(v.firstImageId ?? undefined);
          set({
            state: "ready", loaded: v, input: toStitchInput(v, patientId, pet), suvScale: suv ? suv.scale : null,
          });
          setChecked((p) => ({ ...p, [cand.id]: true }));
        } catch (e) {
          set({ state: "failed", error: String(e) });
        }
        await tick();
      }
    })();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = useMemo(
    () => candidates.filter((c) => checked[c.id] && entries[c.id]?.state === "ready"),
    [candidates, checked, entries],
  );
  const selectedKey = selected.map((c) => c.id).join("|");
  useEffect(() => { setSpOver(null); setBgOver(null); }, [selectedKey]);

  const inputs = useMemo(
    () => selected.map((c) => (entries[c.id] as Extract<Entry, { state: "ready" }>).input),
    [selected, entries],
  );

  const check = useMemo(() => checkStitchInputs(inputs), [inputs]);

  // 条件を満たすときだけ格子を作る（違反があれば何も計算しない）。
  const plan = useMemo((): { grid: StitchGrid | null; base: StitchGrid | null; reason: string } => {
    if (!check.ok) return { grid: null, base: null, reason: "" };
    try {
      const base = unionGrid(inputs);
      if (!spOver) return { grid: base, base, reason: "" };
      const sp = spOver.map(parsePositive);
      if (sp.some((v) => v === null)) return { grid: null, base, reason: t("stitch.invalidSpacing") };
      return { grid: unionGrid(inputs, sp as [number, number, number]), base, reason: "" };
    } catch (e) {
      return { grid: null, base: null, reason: String(e) };
    }
  }, [check, inputs, spOver, t]);

  const defaultBg = useMemo(() => (check.ok ? stitchBackground(inputs) : 0), [check.ok, inputs]);
  const bgText = bgOver ?? String(defaultBg);
  const bgValue = Number(bgText.trim());
  const bgValid = bgText.trim() !== "" && Number.isFinite(bgValue);

  const grid = plan.grid;
  const outMb = grid ? Math.round(estimateGridBytes(grid) / MB) : 0;
  const inMb = Math.round(inputs.reduce((s, x) => s + x.volume.data.byteLength, 0) / MB);

  const onSave = async () => {
    if (!grid || !check.ok || !bgValid || busy) return;
    const totalMb = outMb + inMb;
    const limitMb = getAppliedVolumeMaxMb();
    if (totalMb > limitMb && !window.confirm(t("stitch.confirmMemory", { mb: totalMb, limit: limitMb }))) return;
    setBusy(true);
    setMsg(t("stitch.saving"));
    try {
      await tick();
      // SUV の乗数がかかっている入力は、入力ごとの乗数でモダリティ値へ戻してから結合する。
      const prepared = selected.map((c) => {
        const e = entries[c.id] as Extract<Entry, { state: "ready" }>;
        return e.suvScale != null ? divideInput(e.input, e.suvScale) : e.input;
      });
      const data = concatSlices(stitchSlices(prepared, grid, "mean"), grid);
      // テンプレート（属性を引き継ぐ 1 本）は法線方向で最も手前の入力。
      let front = 0;
      grid.intervals.forEach((iv, n) => { if (iv[0] < grid.intervals[front][0]) front = n; });
      const tpl = selected[front];
      const first = (entries[tpl.id] as Extract<Entry, { state: "ready" }>).loaded.firstImageId ?? undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plane = first ? (metaData.get("imagePlaneModule", first) as any) : null;
      const th = Number(plane?.sliceThickness);
      const res = await saveDerivedVolume({
        grid,
        data,
        studyUid: tpl.study.studyInstanceUid,
        seriesUid: tpl.series.seriesInstanceUid,
        seriesDescription: `${tpl.series.seriesDescription || "Series"} Stitched`,
        derivationDescription: stitchDerivation(selected.map((c) => c.series.seriesInstanceUid), grid),
        sourceSliceThickness: Number.isFinite(th) && th > 0 ? th : null,
        suvScale: null,
        background: bgValue,
      });
      if (alive.current) setMsg(t("stitch.saved", { n: res.count }));
    } catch (e) {
      if (alive.current) setMsg(`${t("stitch.saveFailed")}: ${String(e)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const f1 = (v: number) => v.toFixed(1);
  const f2 = (v: number) => v.toFixed(2);
  const spText: [string, string, string] = spOver ?? (plan.base
    ? [String(Math.round(plan.base.spacing[0] * 100) / 100), String(Math.round(plan.base.spacing[1] * 100) / 100), String(Math.round(plan.base.spacing[2] * 100) / 100)]
    : ["", "", ""]);
  const setSp = (idx: number, v: string) => {
    const next: [string, string, string] = [...spText] as [string, string, string];
    next[idx] = v;
    setSpOver(next);
  };

  // 区間の並び（法線方向、mm）。plan.base があるときだけ。
  const rangeLines = plan.base
    ? selected.map((c, n) => `${c.series.seriesDescription || c.series.seriesInstanceUid}: ${f1(plan.base!.intervals[n][0])} 〜 ${f1(plan.base!.intervals[n][1])}`)
    : [];

  return (
    <div style={backdrop} data-testid="stitch-dialog">
      <div style={panel}>
        <div style={header}>{t("stitch.title")}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid="stitch-candidates">
          {candidates.map((c) => {
            const e = entries[c.id];
            const ready = e?.state === "ready";
            const v = ready ? e.loaded.volume : null;
            let info = "";
            if (!e || e.state === "loading") info = `${t("stitch.loading")} ${e?.state === "loading" ? `${e.done}/${e.total}` : ""}`;
            else if (e.state === "unsupported") info = t("stitch.unsupported");
            else if (e.state === "failed") info = `${t("stitch.loadFailed")}: ${e.error}`;
            else if (v) info = `${e.loaded.modality}  ${v.dims[0]}×${v.dims[1]}×${v.dims[2]}  ${f2(v.spacing[0])}×${f2(v.spacing[1])}×${f2(v.spacing[2])} mm`;
            return (
              <label key={c.id} style={row} data-testid={`stitch-candidate-${c.series.seriesInstanceUid}`}>
                <input
                  type="checkbox"
                  checked={!!checked[c.id]}
                  disabled={!ready || busy}
                  onChange={(ev) => setChecked((p) => ({ ...p, [c.id]: ev.target.checked }))}
                  data-testid={`stitch-check-${c.series.seriesInstanceUid}`}
                />
                <span>{c.series.seriesDescription || c.series.seriesInstanceUid}</span>
                <span style={{ color: "#8a98a6" }}>{info}</span>
              </label>
            );
          })}
        </div>

        <div style={{ fontSize: 12 }} data-testid="stitch-conditions">
          {VIOLATIONS.map((k) => {
            const bad = check.violations.includes(k);
            const noInput = selected.length === 0;
            const mark = noInput ? "–" : bad ? "✗" : "✓";
            return (
              <div key={k} style={{ color: bad ? "#e8a0a0" : "#c8d2dc" }} data-testid={`stitch-cond-${k}`} data-ok={!noInput && !bad}>
                {mark} {bad ? t(`stitch.reason.${k}`) : t(`stitch.ok.${k}`)}
              </div>
            );
          })}
        </div>

        {plan.base && (
          <div style={{ fontSize: 12, color: "#c8d2dc" }}>
            <div data-testid="stitch-ranges">
              {t("stitch.ranges")}
              {rangeLines.map((l, n) => <div key={n} style={{ paddingLeft: 8 }}>{l}</div>)}
            </div>
            <div data-testid="stitch-overlap">
              {t("stitch.overlapGap", { overlap: f1(plan.base.overlapMm), gap: f1(plan.base.gapMm) })}
            </div>
          </div>
        )}

        <label style={row}>
          {t("stitch.overlapMode")}:
          <input type="radio" checked readOnly data-testid="stitch-mode-mean" /> {t("stitch.mean")}
        </label>
        <label style={row}>
          {t("stitch.spacing")}
          {t("stitch.col")}<input style={num} value={spText[0]} disabled={!plan.base} onChange={(e) => setSp(0, e.target.value)} data-testid="stitch-sp-col" />
          {t("stitch.row")}<input style={num} value={spText[1]} disabled={!plan.base} onChange={(e) => setSp(1, e.target.value)} data-testid="stitch-sp-row" />
          {t("stitch.slice")}<input style={num} value={spText[2]} disabled={!plan.base} onChange={(e) => setSp(2, e.target.value)} data-testid="stitch-sp-slice" /> mm
        </label>
        <label style={row}>
          {t("stitch.background")}
          <input style={num} value={bgText} disabled={!plan.base} onChange={(e) => setBgOver(e.target.value)} data-testid="stitch-background" />
        </label>

        <div style={{ fontSize: 12, color: grid && bgValid ? "#c8d2dc" : "#e8a0a0" }} data-testid="stitch-output">
          {grid
            ? bgValid
              ? t("stitch.output", { cols: grid.dims[0], rows: grid.dims[1], n: grid.dims[2], mb: outMb })
              : t("stitch.invalidBackground")
            : plan.reason}
        </div>
        {msg && <div style={{ fontSize: 12, color: "#9fd0ff" }} data-testid="stitch-message">{msg}</div>}
        <div style={footer}>
          <button type="button" onClick={onClose} style={btn} data-testid="stitch-close">{t("stitch.close")}</button>
          <button type="button" onClick={onSave} disabled={!grid || !check.ok || !bgValid || busy} style={btnPrimary} data-testid="stitch-save">
            {t("stitch.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

const backdrop: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)",
  display: "flex", alignItems: "center", justifyContent: "center", zIndex: 200,
};
const panel: React.CSSProperties = {
  background: "#1a2129", border: "1px solid #2c3742", borderRadius: 8, padding: 14,
  minWidth: 520, maxWidth: 680, display: "flex", flexDirection: "column", gap: 10, color: "#e8edf2",
};
const header: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12 };
const num: React.CSSProperties = {
  width: 70, background: "#0f151b", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "2px 4px",
};
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 };
const btn: React.CSSProperties = {
  background: "#26303a", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "4px 12px", cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#2b8aef", border: "1px solid #2b8aef", color: "#fff" };
