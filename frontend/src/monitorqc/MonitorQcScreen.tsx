/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// モニター診断: 目視テストパターンをフルスクリーン表示する画面（#monitorqc）。
// main.js が指定モニターにフルスクリーンの独立ウィンドウで開く。
// 絶対輝度/GSDF の定量測定は行わない（フォトメータ必須）。目視評価の補助。
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { PATTERNS, UNIFORMITY_LEVELS, drawPattern } from "./patterns";

export function MonitorQcScreen() {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [index, setIndex] = useState(0);
  const [levelIdx, setLevelIdx] = useState(3); // 一様性の初期＝128
  const [showUi, setShowUi] = useState(true);

  const pattern = PATTERNS[index];
  const level = UNIFORMITY_LEVELS[levelIdx];

  const render = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = window.innerWidth;
    const cssH = window.innerHeight;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    drawPattern(ctx, pattern.id, w, h, dpr, level);
  }, [pattern.id, level]);

  useEffect(() => {
    render();
    window.addEventListener("resize", render);
    return () => window.removeEventListener("resize", render);
  }, [render]);

  // 操作: ←→で切替、↑↓で明るさ（一様性）、H でUI、Esc で閉じる。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.close();
      } else if (e.key === "ArrowRight" || e.key === " ") {
        setIndex((i) => (i + 1) % PATTERNS.length);
      } else if (e.key === "ArrowLeft") {
        setIndex((i) => (i - 1 + PATTERNS.length) % PATTERNS.length);
      } else if (e.key === "ArrowUp") {
        if (pattern.adjustable) setLevelIdx((l) => Math.min(UNIFORMITY_LEVELS.length - 1, l + 1));
      } else if (e.key === "ArrowDown") {
        if (pattern.adjustable) setLevelIdx((l) => Math.max(0, l - 1));
      } else if (e.key === "h" || e.key === "H") {
        setShowUi((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pattern.adjustable]);

  // マウス移動で一時的に UI を表示（評価中は自動的に隠す）。
  useEffect(() => {
    let timer: number | undefined;
    const onMove = () => {
      setShowUi(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setShowUi(false), 3000);
    };
    window.addEventListener("mousemove", onMove);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.clearTimeout(timer);
    };
  }, []);

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={{ display: "block" }} />

      {showUi && (
        <div style={toolbar} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            {PATTERNS.map((p, i) => (
              <button
                key={p.id}
                onClick={() => setIndex(i)}
                style={{ ...tabBtn, ...(i === index ? tabBtnActive : {}) }}
              >
                {t(p.labelKey)}
              </button>
            ))}
          </div>
          <div style={hint}>
            {pattern.adjustable && (
              <span style={{ marginRight: 14 }}>
                {t("mqc.level")}: {Math.round((level / 255) * 100)}% (DDL {level}) — ↑/↓
              </span>
            )}
            <span style={{ marginRight: 14 }}>{t("mqc.hint.keys")}</span>
            <button onClick={() => window.close()} style={closeBtn}>
              {t("mqc.close")} (Esc)
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const root: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "#000",
  overflow: "hidden",
  cursor: "default",
};

const toolbar: React.CSSProperties = {
  position: "fixed",
  left: "50%",
  bottom: 18,
  transform: "translateX(-50%)",
  background: "rgba(20,24,30,0.92)",
  color: "#e6edf3",
  border: "1px solid #2a3340",
  borderRadius: 10,
  padding: "10px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: "92vw",
  boxShadow: "0 6px 24px rgba(0,0,0,0.5)",
  fontSize: 13,
};

const tabBtn: React.CSSProperties = {
  background: "transparent",
  color: "#c9d4df",
  border: "1px solid #39424f",
  borderRadius: 6,
  padding: "4px 9px",
  cursor: "pointer",
  fontSize: 12,
};

const tabBtnActive: React.CSSProperties = {
  background: "#0b5cad",
  color: "#fff",
  borderColor: "#0b5cad",
};

const hint: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  color: "#9fb0c0",
  fontSize: 12,
};

const closeBtn: React.CSSProperties = {
  background: "#3a2530",
  color: "#ffd9df",
  border: "1px solid #5a2a38",
  borderRadius: 6,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12,
};
