/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 手動内視鏡経路 編集オーバーレイ（`fw/3d-viewer-design.md` §15-#6）。旧 GRAPHY `EndoPathPicker`＋`EndoPathRenderer`。
 *
 * ビューポート上の SVG レイヤ（モーダル）。左ドラッグせず**クリックで経路点を追加**、**マーカーをドラッグで移動**、
 * **右クリック/Delete で削除**する。点は表面ピック（`scene3d.pickPathPoint`＝構造の上）or 焦点面フォールバックで
 * world mm に置く。編集はすべて Undo スタックに載る（追加/移動/削除で 1 コマンド）。
 * 「中心線化」で `Centerline3D`（中心線オブジェクト）へ確定 → 既存の ▶ 内視鏡 / CPR にそのまま乗る。
 *
 * カメラ変化のたびに点列を再投影する（`onStateChanged` 購読）。全て患者 LPS mm（要件 11）。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
import {
  applyEndoPath,
  commitEndoPath,
  commitEndoPathAsCenterline,
  pickPathPoint,
} from "./scene3d";
import { getEndoPath, setEndoSelected, useEndoPath } from "./endoPathStore";
import { makeCameraProjector } from "./volumeCut";
import { makeUnprojector } from "./measure3d";

type V3 = [number, number, number];
const HIT_PX = 8;
const CLICK_MOVE_PX = 6;

export function Viewer3DEndoPathOverlay({
  view,
  active,
  onExit,
}: {
  view: VtkVolumeView;
  active: boolean;
  onExit: () => void;
}) {
  const { t } = useI18n();
  const { points, selected } = useEndoPath();
  const svgRef = useRef<SVGSVGElement>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const [status, setStatus] = useState("");

  // ドラッグ状態（再レンダーを跨ぐので ref）。
  const drag = useRef<{ index: number; before: V3[]; moved: boolean } | null>(null);
  const down = useRef<{ x: number; y: number; onMarker: boolean } | null>(null);

  useEffect(() => {
    bump();
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

  useEffect(() => {
    if (!active) setStatus("");
  }, [active]);

  const rect = svgRef.current?.getBoundingClientRect();
  const parts = view.getSceneParts();
  const project = rect ? makeCameraProjector(parts.renderer, rect.width, rect.height) : null;

  const projected = points.map((p) => project?.(p) ?? null);

  const rayAt = (clientX: number, clientY: number) => {
    if (!rect) return null;
    const unproj = makeUnprojector(parts.renderer, rect.width, rect.height);
    if (!unproj) return null;
    return unproj(clientX - rect.left, clientY - rect.top);
  };

  const markerAt = (cx: number, cy: number): number => {
    for (let i = 0; i < projected.length; i++) {
      const p = projected[i];
      if (p && Math.hypot(p[0] - cx, p[1] - cy) <= HIT_PX) return i;
    }
    return -1;
  };

  const onDown = (e: React.PointerEvent) => {
    if (!active || e.button !== 0 || !rect) return;
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const hit = markerAt(cx, cy);
    down.current = { x: e.clientX, y: e.clientY, onMarker: hit >= 0 };
    if (hit >= 0) {
      setEndoSelected(hit);
      drag.current = { index: hit, before: getEndoPath().map((p) => [...p] as V3), moved: false };
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (!active || !drag.current) return;
    const ray = rayAt(e.clientX, e.clientY);
    if (!ray) return;
    drag.current.moved = true;
    const p = pickPathPoint(ray);
    const cur = getEndoPath().map((q) => [...q] as V3);
    if (drag.current.index < cur.length) {
      cur[drag.current.index] = p;
      applyEndoPath(cur); // ライブ反映（記録なし）
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
    const dn = down.current;
    drag.current = null;
    down.current = null;
    if (d) {
      // ドラッグ移動を 1 コマンドとして確定（動いた時のみ）。
      if (d.moved) commitEndoPath(d.before, getEndoPath(), t("endoPath.move"));
      return;
    }
    // マーカー外クリック（ほぼ動いていない）→ 点を追加。
    if (dn && !dn.onMarker) {
      const dist = Math.hypot(e.clientX - dn.x, e.clientY - dn.y);
      if (dist <= CLICK_MOVE_PX) {
        const ray = rayAt(e.clientX, e.clientY);
        if (ray) {
          const before = getEndoPath().map((p) => [...p] as V3);
          const p = pickPathPoint(ray);
          commitEndoPath(before, [...before, p], t("endoPath.add"));
          setEndoSelected(before.length); // 追加点を選択
        }
      }
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    if (!active || !rect) return;
    e.preventDefault();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const hit = markerAt(cx, cy);
    if (hit >= 0) deleteAt(hit);
  };

  const deleteAt = (i: number) => {
    const before = getEndoPath().map((p) => [...p] as V3);
    if (i < 0 || i >= before.length) return;
    const after = before.filter((_, k) => k !== i);
    commitEndoPath(before, after, t("endoPath.delete"));
    setEndoSelected(null);
  };

  // Delete/Backspace で選択点を削除。
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && /^(INPUT|TEXTAREA|SELECT)$/.test(tgt.tagName)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selected != null) {
        e.preventDefault();
        deleteAt(selected);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, selected]);

  const onMakeCenterline = () => {
    const id = commitEndoPathAsCenterline();
    if (!id) {
      setStatus(t("endoPath.needTwo"));
      return;
    }
    // 確定したら編集経路をクリアしてモードを抜ける（中心線オブジェクトが残る）。
    commitEndoPath(getEndoPath(), [], t("endoPath.clear"));
    setStatus(t("endoPath.made"));
    onExit();
  };

  const onClear = () => {
    const before = getEndoPath().map((p) => [...p] as V3);
    if (!before.length) return;
    commitEndoPath(before, [], t("endoPath.clear"));
    setEndoSelected(null);
  };

  const pathD =
    projected.length && projected.every(Boolean)
      ? projected.map((p, i) => `${i === 0 ? "M" : "L"}${p![0].toFixed(1)} ${p![1].toFixed(1)}`).join(" ")
      : "";

  return (
    <div style={{ ...root, pointerEvents: active ? "auto" : "none" }}>
      <svg
        ref={svgRef}
        style={{ ...svgEl, cursor: active ? "crosshair" : "default" }}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onContextMenu={onContextMenu}
      >
        {pathD && <path d={pathD} fill="none" stroke="#39d0ff" strokeWidth={1.5} />}
        {projected.map((p, i) =>
          p ? (
            <circle
              key={i}
              cx={p[0]}
              cy={p[1]}
              r={i === selected ? 6 : 4}
              fill={i === selected ? "#ffd24a" : "#39d0ff"}
              stroke="#0b2230"
              strokeWidth={1}
            />
          ) : null,
        )}
      </svg>

      {active && (
        <div style={bar}>
          <span style={barTitle}>{t("endoPath.title")}</span>
          <span style={barCount}>{t("endoPath.count", { n: String(points.length) })}</span>
          <button style={points.length >= 2 ? primaryBtn : btnDisabled} disabled={points.length < 2} onClick={onMakeCenterline}>
            {t("endoPath.makeCenterline")}
          </button>
          <button style={btn} disabled={!points.length} onClick={onClear}>
            {t("endoPath.clearBtn")}
          </button>
          <button style={btn} onClick={onExit}>
            {t("endoPath.done")}
          </button>
        </div>
      )}

      {active && <div style={hint}>{status || t("endoPath.hint")}</div>}
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 18 };
const svgEl: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  touchAction: "none",
};
const bar: React.CSSProperties = {
  position: "absolute",
  top: 10,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  background: "rgba(20,24,28,0.92)",
  border: "1px solid #2c343b",
  borderRadius: 8,
  fontSize: 12,
  color: "#e6eaee",
};
const barTitle: React.CSSProperties = { fontWeight: 600 };
const barCount: React.CSSProperties = { color: "#9aa6b2", fontVariantNumeric: "tabular-nums" };
const btn: React.CSSProperties = {
  padding: "4px 10px",
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 11,
};
const btnDisabled: React.CSSProperties = { ...btn, color: "#5a646e", cursor: "default", opacity: 0.6 };
const primaryBtn: React.CSSProperties = { ...btn, background: "#0b5cad", color: "#fff", border: "1px solid #0b5cad", fontWeight: 600 };
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
