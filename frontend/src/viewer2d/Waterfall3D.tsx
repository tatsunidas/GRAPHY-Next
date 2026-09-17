/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 1D ラインの波形分解を 3D のウォーターフォールで描く（フーリエ解析ダイアログ「3D 波形分解」、
 * fw/fourier-design.md §7）。
 *
 * <p>x＝ライン上の位置、奥行き＝周波数の順（DC → 成分を低周波から等間隔 → 最奥にナイキストの目印）、高さ＝振幅。
 * 最手前に元のプロファイルと「DC＋表示中の成分の和」を重ねる。振幅の大きい成分は低周波に偏るので、
 * 周波数に線形な奥行きだと手前に潰れて読めない（実機で確認）→ 等間隔に並べ、各行に周波数を書く。高さは全行で共通の尺度
 * （元プロファイルの平均からの最大偏差）なので、成分の大きさを見比べられる。
 * 正射影を canvas 2D で描き（新しい依存を足さない）、奥の行から手前へ描いて重なりを正しくする。
 * ドラッグで回転、ホイールで拡大。
 *
 * <p>配色（dataviz スキル・暗色面）: 成分は周波数の順序を表すので青の単色相ランプ（低周波＝明るい）、
 * 元プロファイルは本文色、和は系列 2 の橙。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { project3d, waveOf, type WaveComponent } from "../viewer/fourier";

const W = 760;
const H = 380;
const DEFAULT_VIEW = { yaw: -0.38, pitch: 0.5, zoom: 1 };
const Z_FRONT = -1.2;
const Z_NEAR = -0.85;
const Z_FAR = 1.0;
const HEIGHT = 0.42;

/** 青ランプ（参照パレット step 100 → 550）。 */
const RAMP = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab"];
const C = {
  surface: "#10161d",
  grid: "#26313d",
  axis: "#4a5662",
  text: "#c3ccd5",
  muted: "#8a98a6",
  original: "#e8edf2",
  sum: "#d95926",
};

export interface WaterfallProps {
  line: Float32Array;
  /** DC 成分（k=0）。 */
  dc: WaveComponent;
  /** 表示する成分（周波数の昇順）。 */
  components: WaveComponent[];
  /** k → 周波数（表示単位）。 */
  freqOf: (k: number) => number;
  unit: string;
}

export function Waterfall3D({ line, dc, components, freqOf, unit }: WaterfallProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState(DEFAULT_VIEW);
  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

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
    const L = line.length;
    if (L < 2) return;

    const mean = dc.amp * Math.cos(dc.phase);
    let dev = 0;
    for (let i = 0; i < L; i++) dev = Math.max(dev, Math.abs(line[i] - mean));
    for (const c of components) dev = Math.max(dev, c.amp);
    const hScale = dev > 0 ? HEIGHT / dev : 1;
    const nyq = freqOf(L / 2);
    // DC を Z_NEAR、成分 i を等間隔、最奥 Z_FAR をナイキストの目印にする。
    const zOfIndex = (i: number) => Z_NEAR + ((Z_FAR - Z_NEAR) * (i + 1)) / (components.length + 1);
    const xOf = (i: number) => (i / (L - 1)) * 2 - 1;
    const scale = Math.min(W, H) * 0.5 * view.zoom;
    const P = (x: number, y: number, z: number) =>
      project3d([x, y, z - (Z_FRONT + Z_FAR) / 2], view.yaw, view.pitch, scale, W / 2 - 30, H / 2);

    // 行: 手前の元プロファイル＋和、DC、各成分。
    const sum = new Float64Array(L).fill(mean);
    for (const c of components) waveOf(c, L).forEach((v, i) => (sum[i] += v));
    type Row = { z: number; draw: () => void };
    const rows: Row[] = [];
    const drawCurve = (values: ArrayLike<number>, offset: number, z: number, color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      const step = Math.max(1, Math.floor(L / 600));
      for (let i = 0; i < L; i += step) {
        const p = P(xOf(i), (values[i] - offset) * hScale, z);
        if (i === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      }
      ctx.stroke();
    };
    const drawBaseline = (z: number) => {
      const a = P(-1, 0, z);
      const b = P(1, 0, z);
      ctx.strokeStyle = C.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    };
    const label = (text: string, z: number) => {
      const p = P(1.04, 0, z);
      ctx.fillStyle = C.muted;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(text, p.x + 2, p.y);
    };
    const labelEvery = components.length <= 12;

    rows.push({
      z: Z_FRONT,
      draw: () => {
        drawBaseline(Z_FRONT);
        drawCurve(line, mean, Z_FRONT, C.original, 2);
        drawCurve(sum, mean, Z_FRONT, C.sum, 1.5);
        label(t("fourier.wave.frontLabel"), Z_FRONT);
      },
    });
    rows.push({
      z: Z_NEAR,
      draw: () => {
        drawBaseline(Z_NEAR);
        label(`DC ${fmt(mean)}`, Z_NEAR);
      },
    });
    rows.push({
      z: Z_FAR,
      draw: () => {
        const a = P(-1, 0, Z_FAR);
        const b = P(1, 0, Z_FAR);
        ctx.strokeStyle = C.muted;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        const p = P(1.04, 0, Z_FAR);
        ctx.fillStyle = C.text;
        ctx.font = "10px system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(`Nyquist ${fmtF(nyq)} ${unit} (k=${Math.floor(L / 2)})`, p.x + 2, p.y);
      },
    });
    components.forEach((c, idx) => {
      const f = freqOf(c.k);
      const z = zOfIndex(idx);
      const color = RAMP[components.length > 1 ? Math.round((idx / (components.length - 1)) * (RAMP.length - 1)) : 0];
      rows.push({
        z,
        draw: () => {
          drawBaseline(z);
          drawCurve(waveOf(c, L), 0, z, color, 2);
          if (labelEvery || idx % Math.ceil(components.length / 12) === 0) label(`k=${c.k} · ${fmtF(f)} ${unit}`, z);
        },
      });
    });

    // 奥行き軸（左端）: DC から最奥のナイキストまで「低 → 高」の順序軸。
    const drawDepthAxis = () => {
      const a = P(-1.08, 0, Z_NEAR);
      const b = P(-1.08, 0, Z_FAR);
      ctx.strokeStyle = C.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      const m = P(-1.08, 0, (Z_NEAR + Z_FAR) / 2);
      ctx.fillStyle = C.muted;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(t("fourier.wave.depthAxis"), m.x - 4, m.y);
    };
    // 位置軸（手前の行の下）
    const drawPosAxis = () => {
      const y = -HEIGHT * 1.15;
      const a = P(-1, y, Z_FRONT);
      const b = P(1, y, Z_FRONT);
      ctx.strokeStyle = C.axis;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.fillStyle = C.muted;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText("0", a.x, a.y + 3);
      ctx.fillText(`${L - 1} px`, b.x, b.y + 3);
      const m = P(0, y, Z_FRONT);
      ctx.fillText(t("fourier.wave.posAxis"), m.x, m.y + 3);
    };

    // 奥（depth 大）から手前へ。
    const depthOfRow = (z: number) => P(0, 0, z).depth;
    rows.sort((r1, r2) => depthOfRow(r2.z) - depthOfRow(r1.z));
    drawDepthAxis();
    for (const r of rows) r.draw();
    drawPosAxis();
  }, [line, dc, components, freqOf, unit, view, t]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 14, alignItems: "center", fontSize: 11, color: C.text, flexWrap: "wrap" }}>
        <Key color={C.original} label={t("fourier.wave.original")} />
        <Key color={C.sum} label={t("fourier.wave.sum", { k: components.length })} />
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 40, height: 6, borderRadius: 3, background: `linear-gradient(90deg, ${RAMP[0]}, ${RAMP[RAMP.length - 1]})` }} />
          {t("fourier.wave.componentsKey")}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ color: C.muted }}>{t("fourier.wave.dragHint")}</span>
        <button
          onClick={() => setView(DEFAULT_VIEW)}
          style={{ border: "1px solid #3a4650", borderRadius: 5, background: "#232c35", color: "#c3ccd5", cursor: "pointer", fontSize: 11, padding: "3px 9px" }}
          data-testid="fourier-wave-reset-view"
        >
          {t("fourier.wave.resetView")}
        </button>
      </div>
      <canvas
        ref={ref}
        style={{ width: W, height: H, border: "1px solid #26313d", borderRadius: 4, display: "block", cursor: "grab", touchAction: "none" }}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, yaw: view.yaw, pitch: view.pitch };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const yaw = d.yaw + (e.clientX - d.x) * 0.01;
          const pitch = Math.max(-1.4, Math.min(1.4, d.pitch + (e.clientY - d.y) * 0.01));
          setView((v) => ({ ...v, yaw, pitch }));
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => setView((v) => ({ ...v, zoom: Math.max(0.4, Math.min(4, v.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1))) }))}
        data-testid="fourier-wave-canvas"
        data-view={`${view.yaw.toFixed(3)},${view.pitch.toFixed(3)},${view.zoom.toFixed(3)}`}
      />
    </div>
  );
}

function Key({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 16, height: 2, background: color, borderRadius: 1 }} />
      {label}
    </span>
  );
}

function fmt(v: number): string {
  return Math.abs(v) >= 1e4 ? v.toExponential(2) : v.toFixed(1);
}
function fmtF(f: number): string {
  return f === 0 ? "0" : f >= 1 ? f.toFixed(2) : f.toFixed(3);
}
