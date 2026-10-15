/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * リサンプル・切り抜きダイアログ（第 1 段: 等方／軸ごとの間隔へ線形補間で引き直し、派生シリーズとして保存）。
 * 設計: `fw/volume-regrid-design.md`。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { metaData } from "@cornerstonejs/core";
import { useI18n } from "../i18n/i18n";
import type { Study, Series, Instance } from "../api";
import type { ViewerMode } from "../viewer/imageId";
import { loadRegVolume, type LoadedRegVolume } from "../viewer/regVolumeLoader";
import {
  GRID_EDGE_TOLERANCE,
  axisGrid,
  estimateGridBytes,
  resampleToGrid,
  type Grid,
} from "../viewer/gridResample";
import { saveDerivedVolume } from "../viewer/derivedVolumeSave";
import { suvForImageId } from "../viewer/suvStore";
import { getAppliedVolumeMaxMb } from "../viewer/volumeMemory";

type Kind = "iso" | "axis";

function parsePositive(s: string): number | null {
  const v = Number(s.trim());
  return s.trim() !== "" && Number.isFinite(v) && v > 0 ? v : null;
}

function finiteMin(data: Float32Array): number {
  let m = Infinity;
  for (let n = 0; n < data.length; n++) {
    const v = data[n];
    if (v < m) m = v; // NaN は比較が偽になり無視される
  }
  return Number.isFinite(m) ? m : 0;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export function ResampleDialog({
  study,
  series,
  instances,
  mode,
  c,
  t: tIdx,
  onClose,
}: {
  study: Study;
  series: Series;
  instances: Instance[];
  mode: ViewerMode;
  c: number;
  t: number;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [loaded, setLoaded] = useState<LoadedRegVolume | null>(null);
  const [loadMsg, setLoadMsg] = useState<string>(t("resample.loading"));
  const [kind, setKind] = useState<Kind>("iso");
  const [iso, setIso] = useState("1.0");
  const [sc, setSc] = useState("1.0");
  const [sr, setSr] = useState("1.0");
  const [sk, setSk] = useState("1.0");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    (async () => {
      try {
        const v = await loadRegVolume(mode, study.studyInstanceUid, series.seriesInstanceUid, instances, c, tIdx,
          (n, all) => alive.current && setLoadMsg(`${t("resample.loading")} ${n}/${all}`));
        if (!alive.current) return;
        if (!v) { setLoadMsg(t("resample.noGeometry")); return; }
        const s = v.volume.spacing;
        setIso(String(Math.round(Math.min(s[0], s[1], s[2]) * 100) / 100));
        setSc(String(Math.round(s[0] * 100) / 100));
        setSr(String(Math.round(s[1] * 100) / 100));
        setSk(String(Math.round(s[2] * 100) / 100));
        setLoaded(v);
      } catch (e) {
        if (alive.current) setLoadMsg(`${t("resample.loadFailed")}: ${String(e)}`);
      }
    })();
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 入力 → 格子。不正なら理由を返す（[保存] を押せなくする）。
  const plan = useMemo((): { grid: Grid; reason: null } | { grid: null; reason: string } => {
    if (!loaded) return { grid: null, reason: loadMsg };
    const spacing: Array<number | null> = kind === "iso"
      ? [parsePositive(iso), parsePositive(iso), parsePositive(iso)]
      : [parsePositive(sc), parsePositive(sr), parsePositive(sk)];
    if (spacing.some((v) => v === null)) return { grid: null, reason: t("resample.invalidSpacing") };
    try {
      return { grid: axisGrid(loaded.volume, spacing as [number, number, number]), reason: null };
    } catch (e) {
      return { grid: null, reason: String(e) };
    }
  }, [loaded, kind, iso, sc, sr, sk, t, loadMsg]);

  const bytes = plan.grid ? estimateGridBytes(plan.grid) : 0;
  const mb = Math.round(bytes / 1024 / 1024);

  const onSave = async () => {
    if (!loaded || !plan.grid || busy) return;
    const grid = plan.grid;
    const limitMb = getAppliedVolumeMaxMb();
    if (mb > limitMb && !window.confirm(t("resample.confirmMemory", { mb, limit: limitMb }))) return;
    setBusy(true);
    setMsg(t("resample.saving"));
    try {
      await tick(); // 「保存中」を描画してから重い計算に入る
      const src = loaded.volume;
      const data = resampleToGrid(src, null, grid, GRID_EDGE_TOLERANCE);
      const first = loaded.firstImageId ?? undefined;
      const suv = suvForImageId(first);
      // 元の SliceThickness（無ければ出力間隔）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const plane = first ? (metaData.get("imagePlaneModule", first) as any) : null;
      const th = Number(plane?.sliceThickness);
      const [a, b, k] = grid.spacing;
      const label = kind === "iso" ? `${a.toFixed(2)}mm` : `${a.toFixed(2)}x${b.toFixed(2)}x${k.toFixed(2)}mm`;
      const res = await saveDerivedVolume({
        grid,
        data,
        studyUid: study.studyInstanceUid,
        seriesUid: series.seriesInstanceUid,
        seriesDescription: `${series.seriesDescription || "Series"} Resampled ${label}`,
        derivationDescription: `Resampled (linear) to ${grid.dims[0]}x${grid.dims[1]}x${grid.dims[2]}, spacing ${a.toFixed(3)}x${b.toFixed(3)}x${k.toFixed(3)} mm (col x row x slice)`,
        sourceSliceThickness: Number.isFinite(th) && th > 0 ? th : null,
        suvScale: suv ? suv.scale : null,
        background: finiteMin(src.data) / (suv ? suv.scale : 1),
      });
      if (alive.current) setMsg(t("resample.saved", { n: res.count }));
    } catch (e) {
      if (alive.current) setMsg(`${t("resample.saveFailed")}: ${String(e)}`);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const src = loaded?.volume;
  const sp = src?.spacing;
  const f2 = (v: number) => v.toFixed(2);
  return (
    <div style={backdrop} data-testid="resample-dialog">
      <div style={panel}>
        <div style={header}>{t("resample.title")}</div>
        <div style={{ fontSize: 12, color: "#c8d2dc" }} data-testid="resample-source">
          {src && sp
            ? `${t("resample.source")}: ${series.seriesDescription || ""}  ${src.dims[0]}×${src.dims[1]}×${src.dims[2]}  ${f2(sp[0])}×${f2(sp[1])}×${f2(sp[2])} mm`
            : loadMsg}
        </div>
        {src && (
          <div style={{ fontSize: 11, color: "#8a98a6" }} data-testid="resample-count">
            {t("resample.countInfo", { loaded: src.dims[2], total: instances.length })}
          </div>
        )}
        <label style={row}>
          <input type="radio" checked={kind === "iso"} onChange={() => setKind("iso")} data-testid="resample-kind-iso" />
          {t("resample.isotropic")}
          <input style={num} value={iso} disabled={kind !== "iso"} onChange={(e) => setIso(e.target.value)} data-testid="resample-iso" /> mm
        </label>
        <label style={row}>
          <input type="radio" checked={kind === "axis"} onChange={() => setKind("axis")} data-testid="resample-kind-axis" />
          {t("resample.perAxis")}
          {t("resample.col")}<input style={num} value={sc} disabled={kind !== "axis"} onChange={(e) => setSc(e.target.value)} data-testid="resample-col" />
          {t("resample.row")}<input style={num} value={sr} disabled={kind !== "axis"} onChange={(e) => setSr(e.target.value)} data-testid="resample-row" />
          {t("resample.slice")}<input style={num} value={sk} disabled={kind !== "axis"} onChange={(e) => setSk(e.target.value)} data-testid="resample-slice" /> mm
        </label>
        <div style={{ fontSize: 12, color: "#c8d2dc" }}>{t("resample.interp")}: {t("resample.linear")}</div>
        <div style={{ fontSize: 12, color: plan.grid ? "#c8d2dc" : "#e8a0a0" }} data-testid="resample-output">
          {plan.grid
            ? t("resample.output", { cols: plan.grid.dims[0], rows: plan.grid.dims[1], n: plan.grid.dims[2], mb })
            : plan.reason}
        </div>
        {msg && <div style={{ fontSize: 12, color: "#9fd0ff" }} data-testid="resample-message">{msg}</div>}
        <div style={footer}>
          <button type="button" onClick={onClose} style={btn} data-testid="resample-close">{t("resample.close")}</button>
          <button type="button" onClick={onSave} disabled={!plan.grid || busy} style={btnPrimary} data-testid="resample-save">
            {t("resample.save")}
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
  minWidth: 460, display: "flex", flexDirection: "column", gap: 10, color: "#e8edf2",
};
const header: React.CSSProperties = { fontWeight: 600, fontSize: 14 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, fontSize: 12 };
const num: React.CSSProperties = {
  width: 60, background: "#0f151b", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "2px 4px",
};
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 2 };
const btn: React.CSSProperties = {
  background: "#26303a", color: "#e8edf2", border: "1px solid #2c3742", borderRadius: 4, padding: "4px 12px", cursor: "pointer",
};
const btnPrimary: React.CSSProperties = { ...btn, background: "#2b8aef", border: "1px solid #2b8aef", color: "#fff" };
