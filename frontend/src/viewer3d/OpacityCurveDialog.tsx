/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D LUT カーブ（不透明度転送関数）ダイアログ（P2）。旧 GRAPHY `OpacityCurvePanel` /
 * `VolumeOpacityCurveEditorDialog` の移植。ボリュームの HU ヒストグラムを背景に、ドラッグ可能な
 * 制御点で不透明度カーブ（value=HU/SUV, opacity=0..1）を編集する。
 *
 * - ダブルクリック: 点を追加 / 右クリック(点上): 点を削除（端点は残す） / ドラッグ: 移動（x は隣接点で拘束）。
 * - 変更のたびに `onChange(points)` を呼び、VR の不透明度をライブ反映する（`applyOpacityPoints`）。
 * - ライブ編集のためバックドロップ無しのフローティングパネル（3D の変化を見ながら調整できる）。
 * 設計: `fw/3d-viewer-design.md` §7。値は HU/SUV（`pixelCalibration` 単一入口）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { volumeHistogram, type OpacityPoint } from "../viewer/volumeRender";
import { useI18n } from "../i18n/i18n";

const W = 400;
const H = 190;
const PAD_L = 8;
const PAD_R = 8;
const PAD_T = 10;
const PAD_B = 20;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;
const HANDLE_R = 5;

export function OpacityCurveDialog({
  volumeId,
  points,
  onChange,
  onClose,
}: {
  volumeId: string;
  points: OpacityPoint[];
  onChange: (points: OpacityPoint[]) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pts, setPts] = useState<OpacityPoint[]>(() =>
    points.slice().sort((a, b) => a.value - b.value),
  );
  const dragRef = useRef<number | null>(null);

  const hist = useMemo(() => volumeHistogram(volumeId, 256), [volumeId]);
  const range = useMemo<[number, number]>(() => {
    if (hist) return [hist.min, hist.max];
    // ヒストグラム取得不可時は既存点の範囲、無ければ CT 想定。
    if (pts.length) return [pts[0].value, pts[pts.length - 1].value];
    return [-1000, 1000];
  }, [hist]); // eslint-disable-line react-hooks/exhaustive-deps

  const [lo, hi] = range;
  const span = hi - lo || 1;

  // 値/不透明度 ↔ キャンバス px。
  const toX = useCallback((v: number) => PAD_L + ((v - lo) / span) * PLOT_W, [lo, span]);
  const toY = useCallback((o: number) => PAD_T + (1 - o) * PLOT_H, []);
  const fromX = useCallback((px: number) => lo + ((px - PAD_L) / PLOT_W) * span, [lo, span]);
  const fromY = useCallback((py: number) => 1 - (py - PAD_T) / PLOT_H, []);

  const commit = useCallback(
    (next: OpacityPoint[]) => {
      const sorted = next.slice().sort((a, b) => a.value - b.value);
      setPts(sorted);
      onChange(sorted);
    },
    [onChange],
  );

  // 描画。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    // 枠
    ctx.fillStyle = "#0b0e11";
    ctx.fillRect(0, 0, W, H);
    // ヒストグラム（peak-clip + sqrt スケールで視認性確保）
    if (hist) {
      const counts = hist.counts;
      let cap = 0;
      for (let i = 1; i < counts.length; i++) if (counts[i] > cap) cap = counts[i]; // 空気ビン(0)は除外
      cap = cap || 1;
      ctx.fillStyle = "#2a3442";
      const bw = PLOT_W / counts.length;
      for (let i = 0; i < counts.length; i++) {
        const h = Math.min(1, Math.sqrt(counts[i]) / Math.sqrt(cap)) * PLOT_H;
        ctx.fillRect(PAD_L + i * bw, PAD_T + PLOT_H - h, Math.max(1, bw), h);
      }
    }
    // グリッド（0/0.5/1）
    ctx.strokeStyle = "#1c2430";
    ctx.lineWidth = 1;
    for (const o of [0, 0.5, 1]) {
      const y = toY(o);
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(PAD_L + PLOT_W, y);
      ctx.stroke();
    }
    // カーブ
    ctx.strokeStyle = "#4aa3ff";
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = toX(p.value);
      const y = toY(p.opacity);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 制御点
    for (const p of pts) {
      ctx.fillStyle = "#cfe4ff";
      ctx.strokeStyle = "#0b5cad";
      ctx.beginPath();
      ctx.arc(toX(p.value), toY(p.opacity), HANDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }, [pts, hist, toX, toY]);

  // ── ポインタ操作 ──
  const localPos = (e: React.PointerEvent | React.MouseEvent): [number, number] => {
    const r = canvasRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };
  const hitTest = (px: number, py: number): number => {
    for (let i = 0; i < pts.length; i++) {
      const dx = toX(pts[i].value) - px;
      const dy = toY(pts[i].opacity) - py;
      if (dx * dx + dy * dy <= (HANDLE_R + 4) * (HANDLE_R + 4)) return i;
    }
    return -1;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    const [px, py] = localPos(e);
    const idx = hitTest(px, py);
    if (idx >= 0) {
      dragRef.current = idx;
      canvasRef.current?.setPointerCapture(e.pointerId);
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const idx = dragRef.current;
    if (idx === null) return;
    const [px, py] = localPos(e);
    const next = pts.slice();
    let v = fromX(px);
    // x は隣接点で拘束（端点は範囲端に固定）。
    const leftV = idx > 0 ? next[idx - 1].value : lo;
    const rightV = idx < next.length - 1 ? next[idx + 1].value : hi;
    if (idx === 0) v = lo;
    else if (idx === next.length - 1) v = hi;
    else v = Math.min(rightV - 1e-3, Math.max(leftV + 1e-3, v));
    const o = Math.min(1, Math.max(0, fromY(py)));
    next[idx] = { value: v, opacity: o };
    setPts(next);
    onChange(next); // ソート不要（順序保持）
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current !== null) {
      dragRef.current = null;
      canvasRef.current?.releasePointerCapture(e.pointerId);
      commit(pts);
    }
  };
  const onDoubleClick = (e: React.MouseEvent) => {
    const [px, py] = localPos(e);
    if (hitTest(px, py) >= 0) return; // 既存点上は追加しない
    const v = Math.min(hi, Math.max(lo, fromX(px)));
    const o = Math.min(1, Math.max(0, fromY(py)));
    commit([...pts, { value: v, opacity: o }]);
  };
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    const [px, py] = localPos(e);
    const idx = hitTest(px, py);
    // 端点は残す（最低 2 点）。
    if (idx > 0 && idx < pts.length - 1 && pts.length > 2) {
      commit(pts.filter((_, i) => i !== idx));
    }
  };

  const onReset = () => {
    commit([
      { value: lo, opacity: 0 },
      { value: hi, opacity: 1 },
    ]);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={panel} onMouseDown={(e) => e.stopPropagation()}>
      <div style={head}>
        <span style={headTitle}>{t("viewer3d.opacityCurve")}</span>
        <button style={closeBtn} onClick={onClose} aria-label={t("common.close")}>
          ✕
        </button>
      </div>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        style={canvasStyle}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
      />
      <div style={footer}>
        <span style={rangeLabel}>
          {Math.round(lo)} … {Math.round(hi)} HU
        </span>
        <span style={hint}>{t("viewer3d.opacityHint")}</span>
        <button style={resetBtn} onClick={onReset}>
          {t("viewer3d.resetCurve")}
        </button>
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const panel: React.CSSProperties = {
  position: "fixed",
  left: 16,
  bottom: 16,
  zIndex: 2100,
  width: W + 20,
  background: "rgba(20,24,28,0.97)",
  border: "1px solid #2c343b",
  borderRadius: 8,
  boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
  color: "#e6eaee",
  fontFamily: "system-ui, sans-serif",
  padding: 10,
};
const head: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginBottom: 6,
};
const headTitle: React.CSSProperties = { fontSize: 12, fontWeight: 600 };
const closeBtn: React.CSSProperties = {
  marginLeft: "auto",
  border: "none",
  background: "transparent",
  color: "#9aa6b2",
  cursor: "pointer",
  fontSize: 13,
};
const canvasStyle: React.CSSProperties = {
  display: "block",
  width: W,
  height: H,
  borderRadius: 4,
  cursor: "crosshair",
  touchAction: "none",
};
const footer: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginTop: 6,
  fontSize: 11,
};
const rangeLabel: React.CSSProperties = {
  color: "#7f8b96",
  fontFamily: "ui-monospace, monospace",
};
const hint: React.CSSProperties = { color: "#5a6672", flex: 1 };
const resetBtn: React.CSSProperties = {
  padding: "4px 10px",
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 11,
};
