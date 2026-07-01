/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Histogram 解析ダイアログ（GRAPHY 2D Viewer > Process > Histogram の Next 移植）。
 *
 * <p>対象シリーズの ZCT（スライス×チャンネル×時間）から、単一スライスまたは同一 C/T の
 * Z スタック全体のヒストグラムと一次統計量を計算して表示する。プロットのビンをクリックすると、
 * プレビュー中スライスで当該ビンに属するボクセルを赤で強調表示する。
 * オリジナルの {@code com.vis.core.view.D2.ui.HistogramDialog} に対応。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchSeriesLayout, type Study, type Series, type Instance } from "../api";
import { imageIdForInstance, type ViewerMode } from "../viewer/imageId";
import { buildSeriesLayout, buildLayoutFromDto, type SeriesLayout } from "../viewer/seriesLayout";
import {
  analyze,
  loadSlice,
  computeBinMask,
  binLow,
  binHigh,
  type Slice,
  type HistogramData,
  type BinMode,
} from "../viewer/histogram";

const PLOT_W = 560;
const PLOT_H = 260;
const PREVIEW = 360;
const MARGIN = { left: 60, right: 14, top: 12, bottom: 28 };

export function HistogramDialog({
  study,
  series,
  instances,
  mode,
  initialZ,
  initialC,
  initialT,
  onClose,
}: {
  study: Study;
  series: Series;
  instances: Instance[];
  mode: ViewerMode;
  initialZ: number;
  initialC: number;
  initialT: number;
  onClose: () => void;
}) {
  const { t } = useI18n();

  // シリーズ ZCT レイアウト（単一次元フォールバック → backend DTO で差し替え）。
  const fallback = useMemo(
    () => buildSeriesLayout(instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid))),
    [instances, mode],
  );
  const [layout, setLayout] = useState<SeriesLayout>(fallback);
  useEffect(() => {
    let cancelled = false;
    setLayout(fallback);
    fetchSeriesLayout(study.studyInstanceUid, series.seriesInstanceUid)
      .then((dto) => {
        if (cancelled) return;
        const built = buildLayoutFromDto(dto, mode, study.studyInstanceUid, series.seriesInstanceUid);
        if (built) setLayout(built);
      })
      .catch(() => {
        /* フォールバックのまま */
      });
    return () => {
      cancelled = true;
    };
  }, [fallback, study.studyInstanceUid, series.seriesInstanceUid, mode]);

  const nZ = Math.max(1, layout.nZ);
  const nC = Math.max(1, layout.nC);
  const nT = Math.max(1, layout.nT);

  const [z, setZ] = useState(() => clamp(initialZ, 0, nZ - 1));
  const [c, setC] = useState(() => clamp(initialC, 0, nC - 1));
  const [tt, setTt] = useState(() => clamp(initialT, 0, nT - 1));
  const [scope, setScope] = useState<"slice" | "stack">("slice");
  const [binMode, setBinMode] = useState<BinMode>("width");
  const [binValue, setBinValue] = useState(10);

  // インデックスがレイアウト範囲外に出ないよう丸める（DTO 到着で nZ 等が変わり得る）。
  useEffect(() => setZ((v) => clamp(v, 0, nZ - 1)), [nZ]);
  useEffect(() => setC((v) => clamp(v, 0, nC - 1)), [nC]);
  useEffect(() => setTt((v) => clamp(v, 0, nT - 1)), [nT]);

  // 読み込んだ校正済みスライス群（解析対象）＋プレビュー中スライス。
  const [previewSlice, setPreviewSlice] = useState<Slice | null>(null);
  const [analyzeSlices, setAnalyzeSlices] = useState<Slice[]>([]);
  const [data, setData] = useState<HistogramData | null>(null);
  const [selectedBin, setSelectedBin] = useState(-1);
  const [mask, setMask] = useState<Uint8Array | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const loadToken = useRef(0);

  // Effect A: ピクセル読み込み（z/c/t/scope/layout が変わった時のみ）。
  useEffect(() => {
    const token = ++loadToken.current;
    const zStack = layout.zStack(c, tt);
    const previewId = zStack[clamp(z, 0, zStack.length - 1)];
    setStatus(null);
    (async () => {
      const preview = previewId ? await loadSlice(previewId) : null;
      if (token !== loadToken.current) return;
      if (!preview) {
        setPreviewSlice(null);
        setAnalyzeSlices([]);
        setStatus(t("histogram.noImage", { z, c, t: tt }));
        return;
      }
      setPreviewSlice(preview);
      if (scope === "slice") {
        setAnalyzeSlices([preview]);
      } else {
        const loaded: Slice[] = [];
        for (let i = 0; i < zStack.length; i++) {
          const s = i === clamp(z, 0, zStack.length - 1) ? preview : await loadSlice(zStack[i]);
          if (token !== loadToken.current) return;
          if (s) loaded.push(s);
        }
        if (token !== loadToken.current) return;
        setAnalyzeSlices(loaded.length ? loaded : [preview]);
      }
    })();
  }, [layout, z, c, tt, scope, t]);

  // Effect B: 解析（読み込んだスライスまたはビン設定が変わった時）。
  useEffect(() => {
    setSelectedBin(-1);
    setMask(null);
    if (!analyzeSlices.length) {
      setData(null);
      return;
    }
    try {
      const value = binMode === "width" ? Math.max(binValue, 1e-6) : Math.max(1, Math.round(binValue));
      setData(analyze(analyzeSlices, { mode: binMode, value }));
    } catch (e) {
      setData(null);
      setStatus(String(e));
    }
  }, [analyzeSlices, binMode, binValue]);

  // Effect C: 選択ビン → プレビュースライスの強調マスク。
  useEffect(() => {
    if (selectedBin < 0 || !previewSlice || !data) {
      setMask(null);
      return;
    }
    setMask(computeBinMask(previewSlice, binLow(data, selectedBin), binHigh(data, selectedBin)));
  }, [selectedBin, previewSlice, data]);

  return (
    <div style={backdrop} onMouseDown={onClose}>
      <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
        <div style={header}>
          <span>{t("histogram.title")}</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#8a98a6", fontWeight: 400 }}>
            {series.seriesDescription || series.seriesInstanceUid}
          </span>
        </div>

        <Controls
          nZ={nZ}
          nC={nC}
          nT={nT}
          z={z}
          c={c}
          tt={tt}
          scope={scope}
          binMode={binMode}
          binValue={binValue}
          cDim={layout.cDimension}
          tDim={layout.tDimension}
          onZ={setZ}
          onC={setC}
          onT={setTt}
          onScope={setScope}
          onBinMode={setBinMode}
          onBinValue={setBinValue}
        />

        <div style={{ display: "flex", gap: 10, alignItems: "stretch" }}>
          <PlotCanvas data={data} selectedBin={selectedBin} onSelectBin={setSelectedBin} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <PreviewCanvas slice={previewSlice} mask={mask} />
            <StatsPanel data={data} status={status} selectedBin={selectedBin} />
          </div>
        </div>

        <div style={footer}>
          <button onClick={onClose} style={btnPrimary}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(Math.max(lo, hi), v));
}

// ── 上部コントロール ────────────────────────────────────────────

function Controls({
  nZ,
  nC,
  nT,
  z,
  c,
  tt,
  scope,
  binMode,
  binValue,
  cDim,
  tDim,
  onZ,
  onC,
  onT,
  onScope,
  onBinMode,
  onBinValue,
}: {
  nZ: number;
  nC: number;
  nT: number;
  z: number;
  c: number;
  tt: number;
  scope: "slice" | "stack";
  binMode: BinMode;
  binValue: number;
  cDim?: string | null;
  tDim?: string | null;
  onZ: (v: number) => void;
  onC: (v: number) => void;
  onT: (v: number) => void;
  onScope: (v: "slice" | "stack") => void;
  onBinMode: (v: BinMode) => void;
  onBinValue: (v: number) => void;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, marginBottom: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Spinner label="Z" value={z} min={0} max={nZ - 1} onChange={onZ} />
        {nC > 1 && <Spinner label={cDim || "C"} value={c} min={0} max={nC - 1} onChange={onC} />}
        {nT > 1 && <Spinner label={tDim || "T"} value={tt} min={0} max={nT - 1} onChange={onT} />}
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        <button onClick={() => onScope("slice")} style={scope === "slice" ? chipOn : chip}>
          {t("histogram.scope.slice")}
        </button>
        <button onClick={() => onScope("stack")} style={scope === "stack" ? chipOn : chip}>
          {t("histogram.scope.stack")}
        </button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <button onClick={() => onBinMode("width")} style={binMode === "width" ? chipOn : chip}>
          {t("histogram.bin.width")}
        </button>
        <button onClick={() => onBinMode("count")} style={binMode === "count" ? chipOn : chip}>
          {t("histogram.bin.count")}
        </button>
        <label style={{ color: "#5a6672", marginLeft: 4 }}>{t("histogram.bin.value")}</label>
        <input
          type="number"
          min={binMode === "width" ? 0.01 : 1}
          step={binMode === "width" ? 1 : 1}
          value={binValue}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v > 0) onBinValue(v);
          }}
          style={numInput}
        />
      </div>
    </div>
  );
}

function Spinner({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 3, color: "#5a6672" }}>
      {label}:
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = Math.round(Number(e.target.value));
          if (Number.isFinite(v)) onChange(clamp(v, min, max));
        }}
        style={{ ...numInput, width: 56 }}
      />
      <span style={{ fontSize: 10, color: "#9aa6b2" }}>/{max}</span>
    </label>
  );
}

// ── ヒストグラムプロット ────────────────────────────────────────

function PlotCanvas({
  data,
  selectedBin,
  onSelectBin,
}: {
  data: HistogramData | null;
  selectedBin: number;
  onSelectBin: (bin: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  // 単一の突出ビン（背景の空気/黒など）で他が潰れないよう、ピーククリップした表示最大度数。
  const displayMax = useMemo(() => {
    if (!data || !data.counts.length) return 1;
    let maxCount = 0;
    let modeIdx = -1;
    for (let i = 0; i < data.counts.length; i++) {
      if (data.counts[i] > maxCount) {
        maxCount = data.counts[i];
        modeIdx = i;
      }
    }
    let secondMax = 0;
    for (let i = 0; i < data.counts.length; i++) {
      if (i !== modeIdx && data.counts[i] > secondMax) secondMax = data.counts[i];
    }
    if (secondMax !== 0 && maxCount > secondMax * 2) return Math.max(1, secondMax * 1.5);
    return Math.max(1, maxCount);
  }, [data]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, PLOT_W, PLOT_H);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, PLOT_W, PLOT_H);
    if (!data) return;

    const left = MARGIN.left;
    const right = PLOT_W - MARGIN.right;
    const top = MARGIN.top;
    const bottom = PLOT_H - MARGIN.bottom;
    const plotW = Math.max(1, right - left);
    const plotH = Math.max(1, bottom - top);
    const n = data.counts.length;
    const scaleX = plotW / n;

    for (let i = 0; i < n; i++) {
      let barH = (plotH * data.counts[i]) / displayMax;
      barH = Math.min(barH, plotH);
      const x = left + i * scaleX;
      const barW = Math.max(1, Math.ceil(scaleX));
      ctx.fillStyle = i === selectedBin ? "#ff3b30" : "#5a8cc8";
      ctx.fillRect(x, bottom - barH, barW, barH);
    }

    ctx.strokeStyle = "#808080";
    ctx.strokeRect(left, top, plotW, plotH);
    ctx.fillStyle = "#c8c8c8";
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "alphabetic";
    for (let i = 0; i <= 4; i++) {
      const x = left + (plotW * i) / 4;
      const val = data.binStart + data.binCount * data.binWidth * (i / 4);
      ctx.beginPath();
      ctx.moveTo(x, bottom);
      ctx.lineTo(x, bottom + 4);
      ctx.stroke();
      const lbl = fmtAxis(val);
      const w = ctx.measureText(lbl).width;
      ctx.fillText(lbl, Math.max(0, x - w / 2), bottom + 18);
    }
    ctx.fillText(fmtCount(displayMax), 4, top + 10);
    ctx.fillText("0", 4, bottom);

    if (selectedBin >= 0 && selectedBin < n) {
      const sel = `${fmtAxis(binLow(data, selectedBin))} - ${fmtAxis(binHigh(data, selectedBin))} (${data.counts[selectedBin]} px)`;
      ctx.fillStyle = "#ff3b30";
      ctx.fillText(sel, left + 2, top + 10);
    }
  }, [data, selectedBin, displayMax]);

  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!data || !data.counts.length) return;
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const left = MARGIN.left;
    const plotW = Math.max(1, PLOT_W - MARGIN.right - left);
    let x = ((e.clientX - rect.left) * (PLOT_W / rect.width)) - left;
    if (x < 0) x = 0;
    if (x >= plotW) x = plotW - 1;
    const bin = clamp(Math.floor((x * data.counts.length) / plotW), 0, data.counts.length - 1);
    onSelectBin(bin);
  };

  return (
    <canvas
      ref={ref}
      width={PLOT_W}
      height={PLOT_H}
      onClick={handleClick}
      style={{ border: "1px solid #26313d", cursor: "crosshair", background: "#000" }}
    />
  );
}

// ── プレビュー（グレースケール＋強調オーバーレイ）────────────────

function PreviewCanvas({ slice, mask }: { slice: Slice | null; mask: Uint8Array | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, PREVIEW, PREVIEW);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, PREVIEW, PREVIEW);
    if (!slice) return;

    const { values, width, height } = slice;
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const range = Math.max(1e-6, max - min);

    const img = ctx.createImageData(width, height);
    const d = img.data;
    for (let i = 0; i < values.length; i++) {
      let g = Math.round(((values[i] - min) / range) * 255);
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      const o = i * 4;
      if (mask && mask[i]) {
        // 強調: 半透明の赤を灰値に合成。
        d[o] = Math.round(g * 0.35 + 255 * 0.65);
        d[o + 1] = Math.round(g * 0.35);
        d[o + 2] = Math.round(g * 0.35);
      } else {
        d[o] = g;
        d[o + 1] = g;
        d[o + 2] = g;
      }
      d[o + 3] = 255;
    }

    // オフスクリーンに描いてから最近傍でフィット拡縮する。
    const off = document.createElement("canvas");
    off.width = width;
    off.height = height;
    off.getContext("2d")!.putImageData(img, 0, 0);

    const scale = Math.min(PREVIEW / width, PREVIEW / height);
    const dw = Math.round(width * scale);
    const dh = Math.round(height * scale);
    const dx = Math.round((PREVIEW - dw) / 2);
    const dy = Math.round((PREVIEW - dh) / 2);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(off, dx, dy, dw, dh);
  }, [slice, mask]);

  return (
    <canvas
      ref={ref}
      width={PREVIEW}
      height={PREVIEW}
      style={{ border: "1px solid #26313d", background: "#000" }}
    />
  );
}

// ── 統計量 ──────────────────────────────────────────────────────

function StatsPanel({
  data,
  status,
  selectedBin,
}: {
  data: HistogramData | null;
  status: string | null;
  selectedBin: number;
}) {
  const { t } = useI18n();
  if (!data) {
    return <div style={statsBox}>{status || t("histogram.computing")}</div>;
  }
  const unit = data.valueUnit === "raw" ? "" : data.valueUnit;
  const rows: [string, string][] = [
    [t("histogram.stat.count"), String(data.totalCount)],
    [t("histogram.stat.min"), `${fmt(data.min)} ${unit}`],
    [t("histogram.stat.max"), `${fmt(data.max)} ${unit}`],
    [t("histogram.stat.mean"), fmt(data.mean)],
    [t("histogram.stat.stdDev"), fmt(data.stdDev)],
    [t("histogram.stat.variance"), fmt(data.variance)],
    [t("histogram.stat.mode"), fmt(data.mode)],
    [t("histogram.stat.median"), fmt(data.median)],
    [t("histogram.stat.skewness"), fmt(data.skewness)],
    [t("histogram.stat.kurtosis"), fmt(data.kurtosis)],
    [t("histogram.stat.entropy"), `${fmt(data.entropy)} bits`],
    [t("histogram.stat.bins"), `${data.binCount} × ${fmt(data.binWidth)}`],
  ];
  if (selectedBin >= 0 && selectedBin < data.binCount) {
    rows.push([
      t("histogram.stat.selected"),
      `${fmt(binLow(data, selectedBin))}–${fmt(binHigh(data, selectedBin))} (${data.counts[selectedBin]} px)`,
    ]);
  }
  return (
    <div style={statsBox}>
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <span style={{ color: "#8a98a6" }}>{k}</span>
          <span style={{ fontFamily: "monospace", color: "#e8edf2" }}>{v}</span>
        </div>
      ))}
    </div>
  );
}

// ── 書式 ────────────────────────────────────────────────────────

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return v.toFixed(3);
}
function fmtAxis(v: number): string {
  if (Math.abs(v) >= 1000 || (v !== 0 && Math.abs(v) < 1)) return v.toFixed(0);
  return String(Math.trunc(v));
}
function fmtCount(v: number): string {
  return String(Math.round(v));
}

// ── スタイル ────────────────────────────────────────────────────

const backdrop: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.45)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 200,
};
const panel: React.CSSProperties = {
  background: "#1a2129",
  border: "1px solid #2c3742",
  borderRadius: 10,
  boxShadow: "0 12px 40px rgba(0,0,0,0.5)",
  padding: 14,
  color: "#dbe3ea",
  fontSize: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  fontWeight: 600,
  fontSize: 14,
  color: "#7fb2ec",
};
const footer: React.CSSProperties = { display: "flex", justifyContent: "flex-end", marginTop: 2 };
const statsBox: React.CSSProperties = {
  width: PREVIEW,
  boxSizing: "border-box",
  background: "#10161d",
  border: "1px solid #26313d",
  borderRadius: 6,
  padding: "8px 10px",
  fontSize: 11,
  lineHeight: 1.55,
  display: "flex",
  flexDirection: "column",
  gap: 1,
};
const chip: React.CSSProperties = {
  border: "1px solid #3a4650",
  borderRadius: 5,
  background: "#232c35",
  color: "#c3ccd5",
  cursor: "pointer",
  fontSize: 11,
  padding: "3px 9px",
};
const chipOn: React.CSSProperties = { ...chip, background: "#2b8aef", color: "#fff", border: "1px solid #2b8aef" };
const btnPrimary: React.CSSProperties = {
  border: "1px solid #2b8aef",
  borderRadius: 6,
  background: "#2b8aef",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  padding: "5px 16px",
};
const numInput: React.CSSProperties = {
  width: 72,
  border: "1px solid #3a4650",
  borderRadius: 4,
  background: "#10161d",
  color: "#e8edf2",
  fontSize: 12,
  padding: "2px 5px",
};
