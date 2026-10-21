/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR 1 面ぶんの 3D ROI の重ね描き（SVG）と、ツール ON 中の作図・調整の操作。
 *
 * <p>形は世界座標（LPS・mm）で持ち、描画のたびに `worldToCanvas` で画面へ写す（zoom/pan/スライス位置に追従）。
 * 画面⇄世界の変換はこのファイルに閉じ、形の計算は `viewer/roi3dBox.ts`。
 *
 * <p>入力は SVG ではなく**ビューポート要素そのもの**に付ける（SVG が上に乗るとホイールのスライス送りが
 * 届かなくなる）。ツール OFF の間は何も受けない（十字線がそのまま使える）。
 */
import { useEffect, useRef, useState } from "react";
import type { RenderingEngine } from "@cornerstonejs/core";
import {
  PLANE_AXES,
  boxFromDiagonal,
  resizeEdge,
  sectionAt,
  translate,
  type Axis3,
  type PlaneId,
  type Roi3dBox,
  type Roi3dShape,
  type Vec3,
} from "../viewer/roi3dBox";
import { nextRoi3dId } from "../viewer/roi3dBoxStore";

const HANDLE_PX = 9;
const MIN_DRAG_PX = 3;
const ELLIPSE_STEPS = 64;

interface Props {
  engine: RenderingEngine | null;
  viewportId: string;
  plane: PlaneId;
  /** ビューポート要素（入力を受ける）。 */
  hostRef: React.RefObject<HTMLDivElement>;
  boxes: Roi3dBox[];
  selectedId: string | null;
  /** ツール ON のとき新規に作る形。null なら重ね描きだけ。 */
  drawShape: Roi3dShape | null;
  onCreate: (b: Roi3dBox) => void;
  onChange: (b: Roi3dBox) => void;
  onSelect: (id: string | null) => void;
}

type Pt = [number, number];

interface Draft {
  p0: Pt;
  p1: Pt;
  planePos: number;
}

type Drag =
  | { kind: "draw"; start: Pt; planePos: number; startPx: Pt }
  | { kind: "edge"; base: Roi3dBox; axis: Axis3; side: -1 | 1 }
  | { kind: "move"; base: Roi3dBox; start: Pt };

/** 画面（CSS px）と世界（u, v, 法線位置）の写像。ビューポートが取れなければ null。 */
function makeMapper(engine: RenderingEngine | null, viewportId: string, plane: PlaneId, host: HTMLElement | null) {
  if (!engine || !host) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vp = engine.getViewport(viewportId) as any;
  if (!vp?.worldToCanvas || !vp?.canvasToWorld) return null;
  const { normal, u, v } = PLANE_AXES[plane];
  const toCanvas = (cu: number, cv: number, planePos: number): Pt => {
    const w: Vec3 = [0, 0, 0];
    w[normal] = planePos;
    w[u] = cu;
    w[v] = cv;
    const c = vp.worldToCanvas(w) as number[];
    return [c[0], c[1]];
  };
  const fromCanvas = (x: number, y: number) => {
    const w = vp.canvasToWorld([x, y]) as number[];
    return { u: w[u], v: w[v], planePos: w[normal] };
  };
  const mid = fromCanvas(host.clientWidth / 2, host.clientHeight / 2);
  return { toCanvas, fromCanvas, planePos: mid.planePos };
}

interface BoxLayout {
  box: Roi3dBox;
  /** 断面の輪郭（画面座標）。 */
  outline: Pt[];
  /** 面内の外接矩形の辺の中点（画面座標）。 */
  handles: { axis: Axis3; side: -1 | 1; pt: Pt }[];
  /** 面内の外接矩形（世界の u, v 範囲）。 */
  bbox: { u0: number; u1: number; v0: number; v1: number };
}

function layoutFor(b: Roi3dBox, plane: PlaneId, m: NonNullable<ReturnType<typeof makeMapper>>): BoxLayout | null {
  const s = sectionAt(b, plane, m.planePos);
  if (!s) return null;
  const { u, v } = PLANE_AXES[plane];
  const outline: Pt[] = [];
  if (s.shape === "box") {
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) outline.push(m.toCanvas(s.cu + du * s.hu, s.cv + dv * s.hv, m.planePos));
  } else {
    for (let i = 0; i < ELLIPSE_STEPS; i++) {
      const a = (2 * Math.PI * i) / ELLIPSE_STEPS;
      outline.push(m.toCanvas(s.cu + s.hu * Math.cos(a), s.cv + s.hv * Math.sin(a), m.planePos));
    }
  }
  const hu = b.size[u] / 2;
  const hv = b.size[v] / 2;
  const bbox = { u0: b.center[u] - hu, u1: b.center[u] + hu, v0: b.center[v] - hv, v1: b.center[v] + hv };
  const handles: BoxLayout["handles"] = [
    { axis: u, side: -1, pt: m.toCanvas(bbox.u0, b.center[v], m.planePos) },
    { axis: u, side: 1, pt: m.toCanvas(bbox.u1, b.center[v], m.planePos) },
    { axis: v, side: -1, pt: m.toCanvas(b.center[u], bbox.v0, m.planePos) },
    { axis: v, side: 1, pt: m.toCanvas(b.center[u], bbox.v1, m.planePos) },
  ];
  return { box: b, outline, handles, bbox };
}

/** 要素の外へ出てもドラッグを受け続けるための捕捉。取れなくても（合成イベントなど）操作は続ける。 */
function capture(host: HTMLElement, pointerId: number): void {
  try {
    host.setPointerCapture(pointerId);
  } catch {
    /* 捕捉できないポインタ */
  }
}

const pts = (p: Pt[]): string => p.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join(" ");

export function Roi3dOverlay(props: Props) {
  const { engine, viewportId, plane, hostRef, boxes, selectedId, drawShape } = props;
  const [draft, setDraft] = useState<Draft | null>(null);
  // ポインタのハンドラは 1 度だけ付けるので、最新の props は ref 経由で読む。
  const live = useRef(props);
  live.current = props;
  const dragRef = useRef<Drag | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !drawShape) return;
    host.style.cursor = "crosshair";
    const local = (e: PointerEvent): Pt => {
      const r = host.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const p = live.current;
      const m = makeMapper(p.engine, p.viewportId, p.plane, host);
      if (!m) return;
      const [x, y] = local(e);
      const sel = p.boxes.find((b) => b.id === p.selectedId);
      const selLayout = sel ? layoutFor(sel, p.plane, m) : null;
      if (sel && selLayout) {
        const h = selLayout.handles.find((q) => Math.hypot(q.pt[0] - x, q.pt[1] - y) <= HANDLE_PX);
        if (h) {
          dragRef.current = { kind: "edge", base: sel, axis: h.axis, side: h.side };
          capture(host, e.pointerId);
          return;
        }
      }
      const w = m.fromCanvas(x, y);
      // 本体: 選択中を優先し、次に新しいものから。
      const order = [...p.boxes].reverse().sort((a, b) => Number(b.id === p.selectedId) - Number(a.id === p.selectedId));
      for (const b of order) {
        const l = layoutFor(b, p.plane, m);
        if (l && w.u >= l.bbox.u0 && w.u <= l.bbox.u1 && w.v >= l.bbox.v0 && w.v <= l.bbox.v1) {
          p.onSelect(b.id);
          dragRef.current = { kind: "move", base: b, start: [w.u, w.v] };
          capture(host, e.pointerId);
          return;
        }
      }
      dragRef.current = { kind: "draw", start: [w.u, w.v], planePos: m.planePos, startPx: [x, y] };
      capture(host, e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const p = live.current;
      const m = makeMapper(p.engine, p.viewportId, p.plane, host);
      if (!m) return;
      const [x, y] = local(e);
      const w = m.fromCanvas(x, y);
      if (d.kind === "draw") setDraft({ p0: d.start, p1: [w.u, w.v], planePos: d.planePos });
      else if (d.kind === "edge") {
        const { u } = PLANE_AXES[p.plane];
        p.onChange(resizeEdge(d.base, d.axis, d.side, d.axis === u ? w.u : w.v));
      } else {
        const { u, v } = PLANE_AXES[p.plane];
        const delta: Vec3 = [0, 0, 0];
        delta[u] = w.u - d.start[0];
        delta[v] = w.v - d.start[1];
        p.onChange(translate(d.base, delta));
      }
    };
    const onUp = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDraft(null);
      try {
        host.releasePointerCapture(e.pointerId);
      } catch {
        /* 捕捉していない */
      }
      if (!d || d.kind !== "draw") return;
      const p = live.current;
      const m = makeMapper(p.engine, p.viewportId, p.plane, host);
      if (!m || !p.drawShape) return;
      const [x, y] = local(e);
      if (Math.abs(x - d.startPx[0]) < MIN_DRAG_PX || Math.abs(y - d.startPx[1]) < MIN_DRAG_PX) return;
      const w = m.fromCanvas(x, y);
      const b = boxFromDiagonal(nextRoi3dId(), p.drawShape, p.plane, d.planePos, d.start, [w.u, w.v]);
      if (b) p.onCreate(b);
    };
    host.addEventListener("pointerdown", onDown);
    host.addEventListener("pointermove", onMove);
    host.addEventListener("pointerup", onUp);
    host.addEventListener("pointercancel", onUp);
    return () => {
      host.style.cursor = "";
      host.removeEventListener("pointerdown", onDown);
      host.removeEventListener("pointermove", onMove);
      host.removeEventListener("pointerup", onUp);
      host.removeEventListener("pointercancel", onUp);
      dragRef.current = null;
    };
  }, [hostRef, drawShape]);

  const m = makeMapper(engine, viewportId, plane, hostRef.current);
  if (!m) return null;
  const layouts = boxes.map((b) => layoutFor(b, plane, m)).filter((l): l is BoxLayout => l !== null);
  let draftOutline: Pt[] | null = null;
  if (draft && drawShape) {
    const b = boxFromDiagonal("draft", drawShape, plane, draft.planePos, draft.p0, draft.p1);
    const l = b ? layoutFor(b, plane, m) : null;
    draftOutline = l?.outline ?? null;
  }
  return (
    <svg style={svgStyle} data-testid={`mpr-roi3d-overlay-${plane}`}>
      {layouts.map((l) => {
        const sel = l.box.id === selectedId;
        return (
          <g key={l.box.id} data-testid="mpr-roi3d-section" data-selected={sel ? "1" : "0"}>
            <polygon points={pts(l.outline)} fill={sel ? "rgba(0,229,255,0.12)" : "rgba(74,144,217,0.10)"}
              stroke={sel ? "#00e5ff" : "#4a90d9"} strokeWidth={sel ? 2 : 1.5} />
            {sel && drawShape && l.handles.map((h) => (
              <rect key={`${h.axis}${h.side}`} x={h.pt[0] - 4} y={h.pt[1] - 4} width={8} height={8}
                fill="#00e5ff" stroke="#003c44" strokeWidth={1} data-testid="mpr-roi3d-handle" />
            ))}
          </g>
        );
      })}
      {draftOutline && <polygon points={pts(draftOutline)} fill="none" stroke="#ffd54a" strokeWidth={1.5} strokeDasharray="5 3" />}
    </svg>
  );
}

const svgStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  pointerEvents: "none",
  overflow: "hidden",
};
