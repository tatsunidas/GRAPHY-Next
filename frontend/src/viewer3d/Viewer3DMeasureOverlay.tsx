/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D 計測（ルーラー）オーバーレイ（`fw/3d-viewer-design.md` §15-#3）。旧 GRAPHY `MeasurementOverlayRenderer` に対応。
 *
 * ビューポート上の SVG レイヤ。既存の計測ライン（`measureStore`）を**カメラ変化のたびに再投影**して線・端点・
 * 距離ラベルを描く。`active`（計測モード）中はクリックを捕まえ、`scene3d.pickSurfacePoint` で表面上の点を
 * 2 点拾って計測ラインを追加する（`RayMeshIntersector`）。距離は真の mm（患者 LPS mm）。
 *
 * 非アクティブ時は `pointerEvents:none` で表示のみ（回転などは下の vtk へ透過）。全て要件 11（実空間）に準拠。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
import { addMeasurement3D, pickSurfacePoint } from "./scene3d";
import { useMeasurements } from "./measureStore";
import { makeCameraProjector } from "./volumeCut";
import { makeUnprojector } from "./measure3d";

type V3 = [number, number, number];

export function Viewer3DMeasureOverlay({
  view,
  active,
}: {
  view: VtkVolumeView;
  active: boolean;
}) {
  const { t } = useI18n();
  const measures = useMeasurements();
  const svgRef = useRef<SVGSVGElement>(null);
  const [pending, setPending] = useState<V3 | null>(null);
  const [status, setStatus] = useState("");
  // カメラ変化・リサイズで再投影させるためのバージョン。
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    bump(); // マウント後に ref 付きで一度投影。
    const un = view.onStateChanged(bump);
    let ro: ResizeObserver | null = null;
    if (svgRef.current) {
      ro = new ResizeObserver(bump);
      ro.observe(svgRef.current);
    }
    return () => {
      un();
      ro?.disconnect();
    };
  }, [view]);

  // 計測モードを抜けたら仮点を破棄。
  useEffect(() => {
    if (!active) {
      setPending(null);
      setStatus("");
    }
  }, [active]);

  const rect = svgRef.current?.getBoundingClientRect();
  const parts = view.getSceneParts();
  const project = rect ? makeCameraProjector(parts.renderer, rect.width, rect.height) : null;

  const onDown = (e: React.PointerEvent) => {
    if (!active || e.button !== 0 || !rect) return;
    e.preventDefault();
    const unproj = makeUnprojector(parts.renderer, rect.width, rect.height);
    if (!unproj) return;
    const ray = unproj(e.clientX - rect.left, e.clientY - rect.top);
    if (!ray) return;
    const hit = pickSurfacePoint(ray);
    if (!hit) {
      setStatus(t("measure.miss"));
      return;
    }
    setStatus("");
    if (!pending) {
      setPending(hit.point);
    } else {
      addMeasurement3D(pending, hit.point);
      setPending(null);
    }
  };

  const onCancel = (e: React.SyntheticEvent) => {
    if (!active) return;
    e.preventDefault();
    setPending(null);
  };

  return (
    <div style={{ ...root, pointerEvents: active ? "auto" : "none" }}>
      <svg
        ref={svgRef}
        style={{ ...svgEl, cursor: active ? "crosshair" : "default" }}
        onPointerDown={onDown}
        onContextMenu={onCancel}
      >
        {measures.map((m) => {
          const pa = project?.(m.a);
          const pb = project?.(m.b);
          if (!pa || !pb) return null;
          const mid: [number, number] = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
          return (
            <g key={m.id}>
              <line x1={pa[0]} y1={pa[1]} x2={pb[0]} y2={pb[1]} stroke="#ffd24a" strokeWidth={1.5} />
              <circle cx={pa[0]} cy={pa[1]} r={3} fill="#ffd24a" />
              <circle cx={pb[0]} cy={pb[1]} r={3} fill="#ffd24a" />
              <text x={mid[0] + 6} y={mid[1] - 6} style={labelText}>
                {m.distMm.toFixed(1)} mm
              </text>
            </g>
          );
        })}
        {pending &&
          (() => {
            const p = project?.(pending);
            if (!p) return null;
            return <circle cx={p[0]} cy={p[1]} r={4} fill="none" stroke="#ffd24a" strokeWidth={1.5} />;
          })()}
      </svg>

      {active && (
        <div style={hint}>
          {status || (pending ? t("measure.hint2") : t("measure.hint1"))}
        </div>
      )}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 15 };
const svgEl: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  touchAction: "none",
};
const labelText: React.CSSProperties = {
  fill: "#ffe9a6",
  fontSize: 12,
  fontFamily: "system-ui, sans-serif",
  paintOrder: "stroke",
  stroke: "rgba(0,0,0,0.7)",
  strokeWidth: 3,
} as React.CSSProperties;
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
  pointerEvents: "none",
};
