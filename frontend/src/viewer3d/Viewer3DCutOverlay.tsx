/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Cut（lasso スカルプト）オーバーレイ（`fw/3d-viewer-design.md` §15-#2）。旧 GRAPHY `CutLineRenderer` に対応。
 *
 * 3D ビューポートの上に重ねた SVG レイヤ。左ドラッグで投げ縄（多角形）を描き、離すと選択 ROI に対して
 * **視線方向のパンチカット**を適用する（`scene3d.cutRoiLasso`）。カットは実空間 LPS mm で計算され、Undo に載る。
 *
 * オーバーレイがポインタイベントを捕まえるため、カット中は vtk の回転/Pan/Zoom は無効（モーダルなカットツール）。
 * ビューを回すには一旦カットを終了する。inside=投げ縄内を除去 / outside=投げ縄内だけ残す。
 */
import { useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
import { cutRoiLasso } from "./scene3d";
import { useSceneObjects } from "./scene3dStore";
import { makeCameraProjector, type CutMode } from "./volumeCut";

const MIN_STEP_PX = 2.5; // 点を間引く最小移動量

export function Viewer3DCutOverlay({
  view,
  targetId,
  onDone,
}: {
  view: VtkVolumeView;
  targetId: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const objects = useSceneObjects();
  const svgRef = useRef<SVGSVGElement>(null);
  const [points, setPoints] = useState<[number, number][]>([]);
  const [drawing, setDrawing] = useState(false);
  const [mode, setMode] = useState<CutMode>("inside");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  // 対象が消えた/ROI でなくなったら閉じる。
  const target = objects.find((o) => o.id === targetId);
  const valid = target && target.kind === "roi";

  const posOf = (e: React.PointerEvent): [number, number] => {
    const rect = svgRef.current?.getBoundingClientRect();
    return [e.clientX - (rect?.left ?? 0), e.clientY - (rect?.top ?? 0)];
  };

  const onDown = (e: React.PointerEvent) => {
    if (busy || e.button !== 0) return;
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    setStatus("");
    setDrawing(true);
    setPoints([posOf(e)]);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drawing) return;
    const p = posOf(e);
    setPoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < MIN_STEP_PX) return prev;
      return [...prev, p];
    });
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drawing) return;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    setDrawing(false);
    const poly = points;
    if (poly.length < 3) {
      setPoints([]);
      return;
    }
    setBusy(true);
    // 「処理中」を描画させてから重い同期カットを実行。
    setTimeout(() => {
      try {
        const rect = svgRef.current?.getBoundingClientRect();
        const parts = view.getSceneParts();
        const project = makeCameraProjector(parts.renderer, rect?.width ?? 0, rect?.height ?? 0);
        if (!project) {
          setStatus(t("cut.failed"));
          return;
        }
        const res = cutRoiLasso(targetId, poly, project, mode);
        if (!res) setStatus(t("cut.failed"));
        else if (res.removed === 0) setStatus(t("cut.none"));
        else setStatus(t("cut.removed", { n: res.removed.toLocaleString() }));
      } catch {
        setStatus(t("cut.failed"));
      } finally {
        setBusy(false);
        setPoints([]);
      }
    }, 16);
  };

  const pathD = useMemo(() => {
    if (points.length === 0) return "";
    const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(" ");
    return drawing ? d : `${d} Z`;
  }, [points, drawing]);

  if (!valid) {
    // 次のレンダーで閉じる（レンダー中の setState を避ける）。
    queueMicrotask(onDone);
    return null;
  }

  return (
    <div style={root}>
      <svg
        ref={svgRef}
        style={svgEl}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {points.length > 0 && (
          <>
            <path d={pathD} fill="rgba(11,92,173,0.15)" stroke="#39a0ff" strokeWidth={1.5} />
            {points.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={1.5} fill="#39a0ff" />
            ))}
          </>
        )}
      </svg>

      <div style={bar}>
        <span style={barTitle}>{t("cut.title")}</span>
        <div style={modeWrap}>
          {(["inside", "outside"] as CutMode[]).map((m) => (
            <button
              key={m}
              style={mode === m ? modeBtnActive : modeBtn}
              title={t(`cut.mode.${m}.hint`)}
              onClick={() => setMode(m)}
            >
              {t(`cut.mode.${m}`)}
            </button>
          ))}
        </div>
        <button style={doneBtn} onClick={onDone}>
          {t("cut.done")}
        </button>
      </div>

      <div style={hint}>
        {busy ? t("cut.busy") : status || t("cut.hint")}
      </div>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 20 };
const svgEl: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  cursor: "crosshair",
  touchAction: "none",
};
const bar: React.CSSProperties = {
  position: "absolute",
  top: 10,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 10px",
  background: "rgba(20,24,28,0.92)",
  border: "1px solid #2c343b",
  borderRadius: 8,
  fontSize: 12,
  color: "#e6eaee",
};
const barTitle: React.CSSProperties = { fontWeight: 600 };
const modeWrap: React.CSSProperties = { display: "flex", gap: 4 };
const modeBtn: React.CSSProperties = {
  padding: "4px 8px",
  background: "#1b2126",
  color: "#c7d0d8",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 11,
};
const modeBtnActive: React.CSSProperties = {
  ...modeBtn,
  background: "#0b5cad",
  color: "#fff",
  border: "1px solid #0b5cad",
};
const doneBtn: React.CSSProperties = {
  padding: "4px 10px",
  background: "#243", // 目立たせず
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 11,
};
const hint: React.CSSProperties = {
  position: "absolute",
  bottom: 10,
  left: "50%",
  transform: "translateX(-50%)",
  padding: "5px 10px",
  background: "rgba(20,24,28,0.88)",
  border: "1px solid #2c343b",
  borderRadius: 6,
  fontSize: 11,
  color: "#c7d0d8",
  maxWidth: "80%",
  textAlign: "center",
};
