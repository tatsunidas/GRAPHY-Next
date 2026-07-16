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
import { addMeasurement3D, applyMeasurement, commitMeasurement, pickSurfacePoint } from "./scene3d";
import { getMeasurements, setMeasureSelected, useMeasurements, useMeasureSelected } from "./measureStore";
import { makeCameraProjector } from "./volumeCut";
import { makeUnprojector, pickVolumeSurface, rayPlaneIntersect, type Ray } from "./measure3d";
import { geomFromImageData } from "../viewer/labelVolume";

type V3 = [number, number, number];
type Pt2 = [number, number];

const HIT_PX = 8;
const LINE_HIT_PX = 6;

/** 点 p から線分 a-b への距離（画面 px）。 */
function distToSegment(p: Pt2, a: Pt2, b: Pt2): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  const t = lenSq > 1e-9 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

type DragState = {
  id: string;
  mode: "a" | "b" | "line";
  before: { a: V3; b: V3 };
  moved: boolean;
  // "line" モード（全体移動）: カメラ正面と平行な平面上で並進させるためのアンカー。
  anchor?: V3;
  planeNormal?: V3;
  startA?: V3;
  startB?: V3;
};

export function Viewer3DMeasureOverlay({
  view,
  active,
}: {
  view: VtkVolumeView;
  active: boolean;
}) {
  const { t } = useI18n();
  const measures = useMeasurements();
  const selected = useMeasureSelected();
  const svgRef = useRef<SVGSVGElement>(null);
  const [pending, setPending] = useState<V3 | null>(null);
  const [status, setStatus] = useState("");
  // カメラ変化・リサイズで再投影させるためのバージョン。
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  // ドラッグ状態（再レンダーを跨ぐので ref）。
  const drag = useRef<DragState | null>(null);
  const [dragging, setDragging] = useState(false);

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

  // 計測モードを抜けたら仮点・選択・ドラッグを破棄。
  useEffect(() => {
    if (!active) {
      setPending(null);
      setStatus("");
      setMeasureSelected(null);
      drag.current = null;
      setDragging(false);
    }
  }, [active]);

  const rect = svgRef.current?.getBoundingClientRect();
  const parts = view.getSceneParts();
  const project = rect ? makeCameraProjector(parts.renderer, rect.width, rect.height) : null;

  // 表示ボリューム表面のピック（メッシュ/ROI が無いモード用フォールバック）。
  const pickVolumeSurfaceAt = (ray: Ray): V3 | null => {
    try {
      const img = parts.imageData;
      const geom = geomFromImageData(img);
      const scalars = img.getPointData().getScalars();
      const data = scalars?.getData() as ArrayLike<number> | undefined;
      const range = scalars?.getRange?.() as [number, number] | undefined;
      if (!geom || !data || !range) return null;
      return pickVolumeSurface(ray, data, geom, range, view.getLut256());
    } catch {
      return null;
    }
  };

  // まずシーン表面（メッシュ/ROI/中心線）を拾い、無ければ表示ボリューム表面を拾う
  // （どの表示モードでも計測できるよう＝現在の LUT/不透明度に従って最初の不透明ボクセルへ）。
  const pickPoint = (ray: Ray): V3 | null => pickSurfacePoint(ray)?.point ?? pickVolumeSurfaceAt(ray);

  const projected = measures.map((m) => ({ id: m.id, pa: project?.(m.a) ?? null, pb: project?.(m.b) ?? null }));

  const hitTest = (cx: number, cy: number): { id: string; mode: "a" | "b" | "line" } | null => {
    for (const p of projected) {
      if (p.pa && Math.hypot(p.pa[0] - cx, p.pa[1] - cy) <= HIT_PX) return { id: p.id, mode: "a" };
      if (p.pb && Math.hypot(p.pb[0] - cx, p.pb[1] - cy) <= HIT_PX) return { id: p.id, mode: "b" };
    }
    for (const p of projected) {
      if (p.pa && p.pb && distToSegment([cx, cy], p.pa, p.pb) <= LINE_HIT_PX) return { id: p.id, mode: "line" };
    }
    return null;
  };

  const onDown = (e: React.PointerEvent) => {
    if (!active || e.button !== 0 || !rect) return;
    e.preventDefault();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const unproj = makeUnprojector(parts.renderer, rect.width, rect.height);
    const ray = unproj?.(cx, cy) ?? null;

    if (!pending) {
      const hit = hitTest(cx, cy);
      if (hit) {
        const m = measures.find((x) => x.id === hit.id);
        if (m) {
          svgRef.current?.setPointerCapture(e.pointerId);
          setMeasureSelected(hit.id);
          setStatus("");
          const before = { a: m.a, b: m.b };
          if (hit.mode === "line" && ray) {
            const cam = parts.renderer?.getActiveCamera?.();
            const normal = (cam?.getDirectionOfProjection?.() as V3 | undefined) ?? null;
            const anchor = normal ? rayPlaneIntersect(ray, m.a, normal) : null;
            if (normal && anchor) {
              drag.current = { id: hit.id, mode: "line", before, moved: false, anchor, planeNormal: normal, startA: m.a, startB: m.b };
              setDragging(true);
            }
          } else {
            drag.current = { id: hit.id, mode: hit.mode, before, moved: false };
            setDragging(true);
          }
          return;
        }
      }
      setMeasureSelected(null);
    }

    if (!ray) return;
    const point = pickPoint(ray);
    if (!point) {
      setStatus(t("measure.miss"));
      return;
    }
    setStatus("");
    if (!pending) {
      setPending(point);
    } else {
      addMeasurement3D(pending, point);
      setPending(null);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (!active || !drag.current || !rect) return;
    const d = drag.current;
    const unproj = makeUnprojector(parts.renderer, rect.width, rect.height);
    const ray = unproj?.(e.clientX - rect.left, e.clientY - rect.top);
    if (!ray) return;
    if (d.mode === "line" && d.anchor && d.planeNormal && d.startA && d.startB) {
      const cur = rayPlaneIntersect(ray, d.anchor, d.planeNormal);
      if (!cur) return;
      d.moved = true;
      const dx = cur[0] - d.anchor[0], dy = cur[1] - d.anchor[1], dz = cur[2] - d.anchor[2];
      applyMeasurement(
        d.id,
        [d.startA[0] + dx, d.startA[1] + dy, d.startA[2] + dz],
        [d.startB[0] + dx, d.startB[1] + dy, d.startB[2] + dz],
      );
    } else {
      const point = pickPoint(ray);
      if (!point) return;
      d.moved = true;
      const m = getMeasurements().find((x) => x.id === d.id);
      if (!m) return;
      applyMeasurement(d.id, d.mode === "a" ? point : m.a, d.mode === "b" ? point : m.b);
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (!active) return;
    try {
      svgRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (d && d.moved) {
      const m = getMeasurements().find((x) => x.id === d.id);
      if (m) commitMeasurement(d.id, d.before, { a: m.a, b: m.b }, t("measure.move"));
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
        style={{ ...svgEl, cursor: dragging ? (drag.current?.mode === "line" ? "grabbing" : "crosshair") : active ? "crosshair" : "default" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onContextMenu={onCancel}
      >
        {measures.map((m) => {
          const pa = project?.(m.a);
          const pb = project?.(m.b);
          if (!pa || !pb) return null;
          const mid: [number, number] = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
          const isSel = m.id === selected;
          return (
            <g key={m.id}>
              <line
                x1={pa[0]}
                y1={pa[1]}
                x2={pb[0]}
                y2={pb[1]}
                stroke={isSel ? "#ffffff" : "#ffd24a"}
                strokeWidth={isSel ? 2.5 : 1.5}
              />
              <circle cx={pa[0]} cy={pa[1]} r={isSel ? 5 : 3} fill="#ffd24a" stroke={isSel ? "#0b2230" : "none"} strokeWidth={1} />
              <circle cx={pb[0]} cy={pb[1]} r={isSel ? 5 : 3} fill="#ffd24a" stroke={isSel ? "#0b2230" : "none"} strokeWidth={1} />
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
          {status || (pending ? t("measure.hint2") : measures.length ? t("measure.hint3") : t("measure.hint1"))}
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
