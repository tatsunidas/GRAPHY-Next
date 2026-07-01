/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * コントラスト調整（W/L）ダイアログ。GRAPHY 2D Viewer の Image > Adjust contrast
 * （{@code WwWlAdjusterDialog} + {@code WwWlContrastPlot}）の Next 移植。
 *
 * <p>対象タイルの現在スライスから 256 ビンのヒストグラム＋コントラスト直線を描画し、
 * WL（ウィンドウ中心）/ WW（ウィンドウ幅）をスライダー・数値入力・Auto・Reset で調整して
 * ビューポートへライブ適用する。Cornerstone の VOI は Modality LUT 適用後（CT は HU 空間）
 * のため、GRAPHY のような raw↔物理値の変換は不要で、全て校正値（例 HU）で扱う。モーダルレス。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { loadSlice, type Slice } from "../viewer/histogram";

const SLIDER_MAX = 1000;
const PLOT_W = 260;
const PLOT_H = 120;
const HBINS = 256;

export interface WlTarget {
  tileIds: string[];
  imageId: string;
  center: number;
  width: number;
}

export function WwWlAdjustDialog({
  target,
  onApply,
  onReset,
  onClose,
}: {
  target: WlTarget;
  /** WL/WW（校正値）を対象タイルへ適用。 */
  onApply: (center: number, width: number) => void;
  /** DICOM 既定ウィンドウへ戻し、適用後の {center,width} を返す（取得不能なら null）。 */
  onReset: () => { center: number; width: number } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();

  const [slice, setSlice] = useState<Slice | null>(null);
  const [center, setCenter] = useState(target.center);
  const [width, setWidth] = useState(Math.max(1, target.width));

  // 対象スライスの校正値を読み込む（ヒストグラム・データレンジ算出用）。
  useEffect(() => {
    let cancelled = false;
    loadSlice(target.imageId).then((s) => {
      if (!cancelled) setSlice(s);
    });
    return () => {
      cancelled = true;
    };
  }, [target.imageId]);

  // データ範囲＋256 ビンヒストグラム（ピーククリップ）を一度だけ計算してキャッシュ。
  const hist = useMemo(() => computeHistogram(slice), [slice]);
  const dataMin = hist ? hist.min : 0;
  const dataMax = hist ? hist.max : 255;
  const unit = slice && slice.unit !== "raw" ? slice.unit : "";

  // スライダーの固定可動域（GRAPHY calculateBaseRange と同式）。校正値空間で算出。
  const base = useMemo(() => {
    const range = Math.max(dataMax - dataMin, 1);
    const curMin = center - width / 2;
    const curMax = center + width / 2;
    const baseMin = Math.min(dataMin, curMin) - range * 0.5;
    const baseMax = Math.max(dataMax, curMax) + range * 0.5;
    const baseMaxWW = Math.max(range * 3, width * 1.5);
    return { baseMin, baseMax, baseMaxWW };
    // width/center は初期スナップショットからしか動かさない（可動域を固定するため）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataMin, dataMax, target.center, target.width]);

  const applyBoth = (c: number, w: number) => {
    const ww = Math.max(1, w);
    setCenter(c);
    setWidth(ww);
    onApply(c, ww);
  };

  // スライダー値（0..SLIDER_MAX）↔ 校正値。
  const wlSlider = clampInt(((center - base.baseMin) / (base.baseMax - base.baseMin)) * SLIDER_MAX);
  const wwSlider = clampInt((width / base.baseMaxWW) * SLIDER_MAX);

  const onWlSlider = (v: number) => {
    const pct = v / SLIDER_MAX;
    applyBoth(base.baseMin + pct * (base.baseMax - base.baseMin), width);
  };
  const onWwSlider = (v: number) => {
    const pct = v / SLIDER_MAX;
    applyBoth(center, Math.max(1, pct * base.baseMaxWW));
  };

  // 直接入力（WL/WW）。下書きを保持し Set/Enter で確定。
  const [wlText, setWlText] = useState(String(round1(center)));
  const [wwText, setWwText] = useState(String(round1(width)));
  useEffect(() => {
    setWlText(String(round1(center)));
    setWwText(String(round1(width)));
  }, [center, width]);
  const applyDirect = () => {
    const wl = Number(wlText);
    const ww = Number(wwText);
    if (!Number.isFinite(wl) || !Number.isFinite(ww)) {
      setWlText(String(round1(center)));
      setWwText(String(round1(width)));
      return;
    }
    applyBoth(wl, Math.max(1, ww));
  };

  const onAuto = () => {
    if (!hist) return;
    // データ実効範囲へ最大ストレッチ（グレースケール: 中心=中点, 幅=範囲）。
    applyBoth((dataMin + dataMax) / 2, Math.max(1, dataMax - dataMin));
  };
  const onResetClick = () => {
    const s = onReset();
    if (s) applyBoth(s.center, Math.max(1, s.width));
  };

  return (
    <div style={panel}>
      <div style={header}>{t("viewer2d.wl.adjust.title")}</div>

      <ContrastPlot hist={hist} dataMin={dataMin} dataMax={dataMax} curMin={center - width / 2} curMax={center + width / 2} />

      <div style={rowLabel}>
        <span>{t("viewer2d.wl.adjust.center")}</span>
        <span style={mono}>{round1(center)}{unit ? ` ${unit}` : ""}</span>
      </div>
      <input type="range" min={0} max={SLIDER_MAX} value={wlSlider} onChange={(e) => onWlSlider(Number(e.target.value))} style={{ width: "100%" }} />

      <div style={rowLabel}>
        <span>{t("viewer2d.wl.adjust.width")}</span>
        <span style={mono}>{round1(width)}{unit ? ` ${unit}` : ""}</span>
      </div>
      <input type="range" min={0} max={SLIDER_MAX} value={wwSlider} onChange={(e) => onWwSlider(Number(e.target.value))} style={{ width: "100%" }} />

      <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 8 }}>
        <label style={dim}>WL</label>
        <input
          type="number"
          value={wlText}
          onChange={(e) => setWlText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") applyDirect(); }}
          style={numInput}
        />
        <label style={dim}>WW</label>
        <input
          type="number"
          value={wwText}
          onChange={(e) => setWwText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") applyDirect(); }}
          style={numInput}
        />
        <button onClick={applyDirect} style={btn}>{t("viewer2d.wl.adjust.set")}</button>
      </div>

      <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
        <button onClick={onAuto} style={{ ...btn, flex: 1 }}>{t("viewer2d.wl.adjust.auto")}</button>
        <button onClick={onResetClick} style={{ ...btn, flex: 1 }}>{t("viewer2d.wl.adjust.reset")}</button>
        <button onClick={onClose} style={{ ...btnPrimary, flex: 1 }}>{t("common.close")}</button>
      </div>
    </div>
  );
}

// ── コントラストプロット（ヒストグラム＋転送直線）─────────────────

interface Hist {
  counts: number[]; // length HBINS
  hmax: number; // ピーククリップ済み表示最大
  min: number;
  max: number;
}

function computeHistogram(slice: Slice | null): Hist | null {
  if (!slice) return null;
  const v = slice.values;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (x < min) min = x;
    if (x > max) max = x;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  const range = Math.max(max - min, 1e-9);
  const counts = new Array<number>(HBINS).fill(0);
  for (let i = 0; i < v.length; i++) {
    let b = Math.floor(((v[i] - min) / range) * HBINS);
    if (b < 0) b = 0;
    if (b >= HBINS) b = HBINS - 1;
    counts[b]++;
  }
  // ImageJ 流のピーク補正: 突出した最頻ビンを 2 番目の 1.5 倍にクリップ。
  let maxCount = 0;
  let mode = 0;
  for (let i = 0; i < HBINS; i++) {
    if (counts[i] > maxCount) {
      maxCount = counts[i];
      mode = i;
    }
  }
  let maxCount2 = 0;
  for (let i = 0; i < HBINS; i++) {
    if (i !== mode && counts[i] > maxCount2) maxCount2 = counts[i];
  }
  let hmax = maxCount;
  if (maxCount2 !== 0 && maxCount > maxCount2 * 2) {
    hmax = Math.round(maxCount2 * 1.5);
    counts[mode] = hmax;
  }
  return { counts, hmax: Math.max(1, hmax), min, max };
}

function ContrastPlot({
  hist,
  dataMin,
  dataMax,
  curMin,
  curMax,
}: {
  hist: Hist | null;
  dataMin: number;
  dataMax: number;
  curMin: number;
  curMax: number;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = PLOT_W - 1;
    const h = PLOT_H - 1;
    ctx.clearRect(0, 0, PLOT_W, PLOT_H);
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, PLOT_W, PLOT_H);

    // 1. ヒストグラム（スレート色の縦線）。
    if (hist && hist.hmax > 0) {
      const scaleX = w / HBINS;
      ctx.strokeStyle = "rgb(110,110,150)";
      ctx.lineWidth = 1;
      for (let i = 0; i < HBINS; i++) {
        const x = Math.round(i * scaleX);
        const barH = Math.round((h * hist.counts[i]) / hist.hmax);
        if (barH > 0) {
          ctx.beginPath();
          ctx.moveTo(x + 0.5, h);
          ctx.lineTo(x + 0.5, h - barH);
          ctx.stroke();
        }
      }
    }

    // 2. コントラスト直線（枠内クリップ＋床/天井）。
    ctx.strokeStyle = "#000";
    ctx.lineWidth = 1.5;
    let total = dataMax - dataMin;
    if (total <= 0) total = 1;
    const rawX1 = ((curMin - dataMin) / total) * w;
    const rawX2 = ((curMax - dataMin) / total) * w;

    if (curMin === curMax) {
      const x = Math.round(rawX1);
      if (x >= 0 && x <= w) line(ctx, x, h, x, 0);
    } else {
      const slope = -h / (rawX2 - rawX1);
      const drawX1 = Math.max(0, rawX1);
      const drawX2 = Math.min(w, rawX2);
      const drawY1 = h + slope * (drawX1 - rawX1);
      const drawY2 = h + slope * (drawX2 - rawX1);
      if (drawX1 <= drawX2) line(ctx, drawX1, drawY1, drawX2, drawY2);
      if (rawX1 > 0) line(ctx, 0, h, Math.min(w, rawX1), h); // 左の床
      if (rawX2 < w) line(ctx, Math.max(0, rawX2), 0, w, 0); // 右の天井
    }

    ctx.strokeStyle = "#888";
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w, h);
  }, [hist, dataMin, dataMax, curMin, curMax]);

  return <canvas ref={ref} width={PLOT_W} height={PLOT_H} style={{ display: "block", margin: "0 auto 4px", border: "1px solid #dfe3e8" }} />;
}

function line(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

function clampInt(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(SLIDER_MAX, Math.round(v)));
}
function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

// ── スタイル（WandDialog 準拠のモーダルレス浮動パネル）─────────────

const panel: React.CSSProperties = {
  position: "fixed", top: 90, right: 16, width: 288, zIndex: 60,
  background: "#fff", border: "1px solid #cfd8e2", borderRadius: 8,
  boxShadow: "0 8px 28px rgba(0,0,0,0.18)", padding: 12, fontSize: 12, color: "#222",
};
const header: React.CSSProperties = { fontWeight: 600, color: "#0b5cad", marginBottom: 8 };
const rowLabel: React.CSSProperties = { display: "flex", justifyContent: "space-between", marginTop: 6, marginBottom: 2 };
const dim: React.CSSProperties = { color: "#5a6672" };
const mono: React.CSSProperties = { fontFamily: "monospace" };
const numInput: React.CSSProperties = { width: 66, border: "1px solid #cdd5de", borderRadius: 4, fontSize: 12, padding: "2px 5px" };
const btn: React.CSSProperties = { border: "1px solid #cdd5de", borderRadius: 6, background: "#fff", cursor: "pointer", fontSize: 12, padding: "4px 10px" };
const btnPrimary: React.CSSProperties = { ...btn, background: "#0b5cad", border: "1px solid #0b5cad", color: "#fff" };
