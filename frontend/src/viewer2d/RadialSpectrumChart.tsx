/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 動径平均スペクトルのグラフ（フーリエ解析ダイアログの「グラフ」タブ、fw/fourier-design.md §6）。
 *
 * <p>横軸＝空間周波数（lp/mm、PixelSpacing が無ければ cycles/px）、縦軸＝|F| の動径平均（log）。
 * ナイキスト周波数に縦線とラベル、ナイキストより外（四隅の斜め成分だけが届く域）は網掛け。
 * フィルタ適用中はフィルタ後の曲線を重ねる。ホバーで十字線と値。
 *
 * <p>配色は dataviz スキルの参照パレット（暗色面）: 系列 1＝青 #3987e5、系列 2＝橙 #d95926（検証済み）。
 * 文字は系列色を使わず本文色、罫線は面から 1 段だけ離れた灰の細線。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { isolatedIndices, type RadialProfile } from "../viewer/fourier";

const W = 760;
const H = 260;
const M = { left: 62, right: 16, top: 14, bottom: 40 };

const C = {
  surface: "#10161d",
  grid: "#26313d",
  axis: "#3a4650",
  text: "#c3ccd5",
  muted: "#8a98a6",
  series1: "#3987e5",
  series2: "#d95926",
  nyquist: "#dbe3ea",
  shade: "rgba(138,152,166,0.10)",
};

export function RadialSpectrumChart({ profile, filtered }: { profile: RadialProfile | null; filtered: boolean }) {
  const { t } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const plotW = W - M.left - M.right;
  const plotH = H - M.top - M.bottom;

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = C.surface;
    ctx.fillRect(0, 0, W, H);
    if (!profile || profile.freq.length < 2) return;

    const { freq, mean, meanMasked, nyquistX, nyquistY, unit } = profile;
    const fMax = freq[freq.length - 1];
    const series = [mean, ...(filtered && meanMasked ? [meanMasked] : [])];
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series)
      for (const v of s) {
        if (v > 0) {
          const l = Math.log10(v);
          if (l < lo) lo = l;
          if (l > hi) hi = l;
        }
      }
    if (!Number.isFinite(lo)) return;
    lo = Math.floor(lo);
    hi = Math.ceil(hi);
    if (hi === lo) hi = lo + 1;
    const xOf = (f: number) => M.left + (f / fMax) * plotW;
    const yOf = (v: number) => M.top + (1 - (Math.log10(v) - lo) / (hi - lo)) * plotH;

    // ナイキストより外の網掛け（どちらかの軸でも届く最大のナイキストより外）
    const nyqMax = Math.max(nyquistX, nyquistY);
    ctx.fillStyle = C.shade;
    ctx.fillRect(xOf(nyqMax), M.top, M.left + plotW - xOf(nyqMax), plotH);

    // 罫線（log の 10 のべき）と軸
    ctx.strokeStyle = C.grid;
    ctx.lineWidth = 1;
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = C.muted;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let e = lo; e <= hi; e++) {
      const y = Math.round(yOf(10 ** e)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(M.left, y);
      ctx.lineTo(M.left + plotW, y);
      ctx.stroke();
      ctx.fillText(`1e${e}`, M.left - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const ticks = niceTicks(fMax, 6);
    for (const f of ticks) {
      const x = Math.round(xOf(f)) + 0.5;
      ctx.strokeStyle = C.grid;
      ctx.beginPath();
      ctx.moveTo(x, M.top + plotH);
      ctx.lineTo(x, M.top + plotH + 4);
      ctx.stroke();
      ctx.fillText(fmtFreq(f), x, M.top + plotH + 6);
    }
    ctx.strokeStyle = C.axis;
    ctx.beginPath();
    ctx.moveTo(M.left + 0.5, M.top);
    ctx.lineTo(M.left + 0.5, M.top + plotH + 0.5);
    ctx.lineTo(M.left + plotW, M.top + plotH + 0.5);
    ctx.stroke();
    ctx.fillStyle = C.muted;
    ctx.fillText(`${t("fourier.graph.xAxis")} (${unit})`, M.left + plotW / 2, H - 16);
    ctx.save();
    ctx.translate(14, M.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textBaseline = "middle";
    ctx.fillText(t("fourier.graph.yAxis"), 0, 0);
    ctx.restore();

    // 曲線（2px・丸め）。
    // 🔴 両隣が 0 の点は線分にならず、moveTo だけでは何も描かれない。合成した縞のような
    //   きれいな画像では正の値が飛び飛びのビンにしか入らず、**グラフが空になる**
    //   （罫線とナイキスト線だけが残る）。孤立した点は点として描く。
    const drawLine = (s: Float64Array, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < freq.length; i++) {
        if (!(s[i] > 0)) {
          started = false;
          continue;
        }
        const x = xOf(freq[i]);
        const y = yOf(s[i]);
        if (started) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        started = true;
      }
      ctx.stroke();
      ctx.fillStyle = color;
      for (const i of isolatedIndices(s)) {
        ctx.beginPath();
        ctx.arc(xOf(freq[i]), yOf(s[i]), 2, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    drawLine(mean, C.series1);
    if (filtered && meanMasked) drawLine(meanMasked, C.series2);

    // ナイキスト（縦線＋ラベル。dx≠dy なら 2 本）
    const nyqs = Math.abs(nyquistX - nyquistY) < 1e-9 ? [[nyquistX, ""]] : [[nyquistX, " x"], [nyquistY, " y"]];
    ctx.textBaseline = "top";
    nyqs.forEach(([f, axis], i) => {
      const x = Math.round(xOf(f as number)) + 0.5;
      ctx.strokeStyle = C.nyquist;
      ctx.lineWidth = 1;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(x, M.top);
      ctx.lineTo(x, M.top + plotH);
      ctx.stroke();
      const label =
        unit === "lp/mm"
          ? `Nyquist${axis} ${fmtFreq(f as number)} lp/mm (0.5 cycles/px)`
          : `Nyquist${axis} 0.5 cycles/px`;
      ctx.fillStyle = C.text;
      const alignRight = xOf(f as number) > M.left + plotW * 0.6;
      ctx.textAlign = alignRight ? "right" : "left";
      ctx.fillText(label, x + (alignRight ? -6 : 6), M.top + 4 + i * 15);
    });

    // ホバー（十字線＋マーカー）
    if (hover !== null && hover >= 0 && hover < freq.length) {
      const x = Math.round(xOf(freq[hover])) + 0.5;
      ctx.strokeStyle = C.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, M.top);
      ctx.lineTo(x, M.top + plotH);
      ctx.stroke();
      for (const [s, color] of [
        [mean, C.series1],
        ...(filtered && meanMasked ? [[meanMasked, C.series2]] : []),
      ] as [Float64Array, string][]) {
        if (!(s[hover] > 0)) continue;
        ctx.fillStyle = color;
        ctx.strokeStyle = C.surface;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, yOf(s[hover]), 4.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
  }, [profile, filtered, hover, plotW, plotH, t]);

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!profile || profile.freq.length < 2) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const fMax = profile.freq[profile.freq.length - 1];
    const f = ((px - M.left) / plotW) * fMax;
    if (f < 0 || f > fMax) {
      setHover(null);
      return;
    }
    let best = 0;
    for (let i = 1; i < profile.freq.length; i++)
      if (Math.abs(profile.freq[i] - f) < Math.abs(profile.freq[best] - f)) best = i;
    setHover(best);
  };

  const cyclesPerPx = (f: number) => (profile ? (f / profile.nyquistX) * 0.5 : 0);
  const tip =
    profile && hover !== null && hover < profile.freq.length
      ? {
          f: profile.freq[hover],
          v: profile.mean[hover],
          vm: filtered && profile.meanMasked ? profile.meanMasked[hover] : null,
        }
      : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 11, color: C.text, flexWrap: "wrap" }}>
        <LegendKey color={C.series1} label={t("fourier.graph.original")} />
        {filtered && profile?.meanMasked && <LegendKey color={C.series2} label={t("fourier.graph.filtered")} />}
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 14, height: 10, background: C.shade, border: `1px solid ${C.grid}` }} />
          {t("fourier.graph.beyondNyquist")}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "monospace", color: C.muted, minHeight: 14 }} data-testid="fourier-graph-readout">
          {tip &&
            `${fmtFreq(tip.f)} ${profile!.unit}${profile!.unit === "lp/mm" ? ` (${cyclesPerPx(tip.f).toFixed(3)} cycles/px)` : ""} · |F| ${fmtVal(tip.v)}${tip.vm !== null ? ` → ${fmtVal(tip.vm)}` : ""}`}
        </span>
      </div>
      <canvas
        ref={ref}
        style={{ width: W, height: H, border: "1px solid #26313d", borderRadius: 4, display: "block", cursor: "crosshair" }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        data-testid="fourier-graph-canvas"
        data-nyquist={profile ? `${profile.nyquistX}|${profile.nyquistY}|${profile.unit}` : ""}
      />
    </div>
  );
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
      {label}
    </span>
  );
}

function niceTicks(max: number, count: number): number[] {
  if (!(max > 0)) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = 0; v <= max + 1e-12; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function fmtFreq(f: number): string {
  if (f === 0) return "0";
  return f >= 10 ? f.toFixed(1) : f >= 1 ? f.toFixed(2) : f.toFixed(3);
}

function fmtVal(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return Math.abs(v) >= 1e4 || (v !== 0 && Math.abs(v) < 1e-2) ? v.toExponential(2) : v.toFixed(2);
}
