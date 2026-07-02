/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * カラーレジェンド（カラーバー）overlay（`fw/3d-viewer-design.md` §15 #8）。旧 GRAPHY
 * `LegendConfig`/`LegendPosition` の移植。VR の現在のカラーマップ（LUT）と VOI（W/L）を
 * 値→色の縦バー＋目盛りで表示する。
 *
 * - 色: `lutName` があれば backend LUT（`fetchLutData`）の r/g/b、無ければグレースケール。
 * - 値域: `view.getState()` の center/width（VOI）から算出。`onStateChanged` で W/L 変更に追従。
 * - 単位: CT=HU、その他はモダリティ名（近似）。位置は四隅から選択（既定=右下）。
 *
 * 表示専用（操作はビューポート側）。単一入口の輝度校正（HU）に従い値域はモダリティ値空間。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchLutData } from "../api";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";

export type LegendCorner = "tl" | "tr" | "bl" | "br";

interface Stop {
  /** 0..1 バー下端→上端。 */
  t: number;
  rgb: [number, number, number];
}

const N_STOPS = 24;

/** グレースケール（黒→白）ストップ。 */
function grayscaleStops(): Stop[] {
  const out: Stop[] = [];
  for (let i = 0; i < N_STOPS; i++) {
    const t = i / (N_STOPS - 1);
    const g = Math.round(t * 255);
    out.push({ t, rgb: [g, g, g] });
  }
  return out;
}

/** LUT（256 r/g/b 0..255）を N_STOPS に間引く。 */
function lutStops(lut: { r: number[]; g: number[]; b: number[] }): Stop[] {
  const n = Math.min(lut.r.length, lut.g.length, lut.b.length);
  if (n < 2) return grayscaleStops();
  const out: Stop[] = [];
  for (let i = 0; i < N_STOPS; i++) {
    const t = i / (N_STOPS - 1);
    const src = Math.round(t * (n - 1));
    out.push({ t, rgb: [lut.r[src] | 0, lut.g[src] | 0, lut.b[src] | 0] });
  }
  return out;
}

function unitFor(modality: string | null): string {
  const m = (modality ?? "").toUpperCase();
  if (m === "CT") return "HU";
  if (m === "PT") return "SUV";
  return "";
}

export function ColorLegend({
  view,
  lutName,
  modality,
  corner = "br",
  onClose,
}: {
  view: VtkVolumeView;
  lutName: string | null;
  modality: string | null;
  corner?: LegendCorner;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const [stops, setStops] = useState<Stop[]>(() => grayscaleStops());
  const [range, setRange] = useState<{ lo: number; hi: number }>(() => {
    const s = safeState(view);
    return { lo: s.center - s.width / 2, hi: s.center + s.width / 2 };
  });

  // LUT 取得（名前変更時）。null はグレースケール。
  useEffect(() => {
    let cancelled = false;
    if (!lutName) {
      setStops(grayscaleStops());
      return;
    }
    fetchLutData(lutName)
      .then((d) => {
        if (!cancelled && d?.r?.length) setStops(lutStops(d));
      })
      .catch(() => {
        if (!cancelled) setStops(grayscaleStops());
      });
    return () => {
      cancelled = true;
    };
  }, [lutName]);

  // W/L 変更に追従（onStateChanged）。
  const rafRef = useRef(0);
  useEffect(() => {
    const update = () => {
      const s = safeState(view);
      setRange({ lo: s.center - s.width / 2, hi: s.center + s.width / 2 });
    };
    update();
    const off = view.onStateChanged(() => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(update);
    });
    return () => {
      cancelAnimationFrame(rafRef.current);
      off?.();
    };
  }, [view]);

  const gradient = useMemo(
    () =>
      `linear-gradient(to top, ${stops
        .map((s) => `rgb(${s.rgb[0]},${s.rgb[1]},${s.rgb[2]}) ${(s.t * 100).toFixed(1)}%`)
        .join(", ")})`,
    [stops],
  );

  const unit = unitFor(modality);
  const mid = (range.lo + range.hi) / 2;
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 10 ? 1 : 0));

  return (
    <div style={{ ...box, ...cornerStyle(corner) }}>
      <div style={headerRow}>
        <span style={titleStyle}>{t("legend.title")}{unit ? ` (${unit})` : ""}</span>
        {onClose && (
          <button style={closeBtn} onClick={onClose} title={t("legend.hide")}>
            ✕
          </button>
        )}
      </div>
      <div style={barRow}>
        <div style={{ ...bar, background: gradient }} />
        <div style={ticks}>
          <span style={tick}>{fmt(range.hi)}</span>
          <span style={tick}>{fmt(mid)}</span>
          <span style={tick}>{fmt(range.lo)}</span>
        </div>
      </div>
    </div>
  );
}

function safeState(view: VtkVolumeView): { center: number; width: number } {
  try {
    const s = view.getState() as { center?: number; width?: number };
    const center = Number.isFinite(s.center) ? (s.center as number) : 0;
    const width = Number.isFinite(s.width) && (s.width as number) > 0 ? (s.width as number) : 1;
    return { center, width };
  } catch {
    return { center: 0, width: 1 };
  }
}

function cornerStyle(c: LegendCorner): React.CSSProperties {
  switch (c) {
    case "tl":
      return { top: 12, left: 12 };
    case "tr":
      return { top: 12, right: 12 };
    case "bl":
      return { bottom: 12, left: 12 };
    case "br":
    default:
      return { bottom: 12, right: 12 };
  }
}

// ── styles ────────────────────────────────────────────────────
const box: React.CSSProperties = { position: "absolute", zIndex: 20, background: "rgba(10,13,16,0.72)", border: "1px solid #2c343b", borderRadius: 8, padding: "6px 8px", pointerEvents: "auto", fontFamily: "system-ui, sans-serif", userSelect: "none" };
const headerRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, marginBottom: 4 };
const titleStyle: React.CSSProperties = { color: "#cdd6df", fontSize: 11, fontWeight: 600 };
const closeBtn: React.CSSProperties = { background: "transparent", color: "#7f8b96", border: "none", fontSize: 12, cursor: "pointer", lineHeight: 1, padding: 0 };
const barRow: React.CSSProperties = { display: "flex", gap: 6, alignItems: "stretch" };
const bar: React.CSSProperties = { width: 16, height: 140, borderRadius: 3, border: "1px solid #33404b" };
const ticks: React.CSSProperties = { display: "flex", flexDirection: "column", justifyContent: "space-between", fontVariantNumeric: "tabular-nums" };
const tick: React.CSSProperties = { color: "#cdd6df", fontSize: 10, textShadow: "0 0 3px #000" };
