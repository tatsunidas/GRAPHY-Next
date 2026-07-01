/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Slicer ウィンドウ（P2）。左=ベース断面（AXIAL）＋カットライン、右=斜め断面プレビュー、
 * 下=コントロールパネル（FOV/スライス厚/Gap/枚数/再構成モード）。
 *
 * 起動: MainScreen が選択スタディ/シリーズを `localStorage("graphy-slicer-ctx")` に書き、
 * desktop=`openViewer("slicer")` / web=`window.open("#slicer")` で本画面（`App` の #slicer ルート）を開く。
 * ビューポート/プレビュー配線は `viewer/slicer.ts`、確定リスライスは `viewer/reslice.ts`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RenderingEngine } from "@cornerstonejs/core";
import { fetchSeries, fetchInstances, type AppStatus, type Study, type Series } from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForInstance } from "../viewer/imageId";
import {
  setupSlicerViewports,
  setReslicePreview,
  teardownSlicer,
  extractResliceVolume,
  volumeMinSpacing,
  baseViewportCenter,
  isPreviewApprox,
  type SlicerViewportIds,
  type ResliceGeometry,
} from "../viewer/slicer";
import { buildMprVolume } from "../viewer/mpr";
import { buildReslicePlane, reslice, type ReconMode } from "../viewer/reslice";
import { useI18n } from "../i18n/i18n";

const ENGINE_ID = "graphy-slicer-engine";
const TOOL_GROUP_ID = "graphy-slicer-tg";
const VIEWPORT_IDS: SlicerViewportIds = { base: "slicer-base", recon: "slicer-recon" };

const RECON_MODES: ReconMode[] = ["SLICECUT", "MEAN", "MAX", "MIN", "MEDIAN", "MODE"];

interface SlicerContext {
  study: Study;
  series?: Series;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

interface SlabParams {
  fovWidth: number;
  fovHeight: number;
  thickness: number;
  gap: number;
  numSlices: number;
  mode: ReconMode;
}

const DEFAULT_SLAB: SlabParams = {
  fovWidth: 200,
  fovHeight: 200,
  thickness: 3,
  gap: 0,
  numSlices: 20,
  mode: "SLICECUT",
};

interface CutLine {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

type DragKind = null | "p0" | "p1" | "body";

export function SlicerScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const baseRef = useRef<HTMLDivElement>(null);
  const reconRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const startedRef = useRef(false);
  const geomRef = useRef<ResliceGeometry | null>(null);
  const dragRef = useRef<{ kind: DragKind; startX: number; startY: number; line: CutLine }>({
    kind: null,
    startX: 0,
    startY: 0,
    line: { x0: 0, y0: 0, x1: 0, y1: 0 },
  });

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [title, setTitle] = useState("");
  const [slab, setSlab] = useState<SlabParams>(DEFAULT_SLAB);
  const [line, setLine] = useState<CutLine | null>(null);
  const [genInfo, setGenInfo] = useState<string>("");
  const slabRef = useRef(slab);
  slabRef.current = slab;

  const mode = status?.mode === "standalone" ? "standalone" : "web";

  // カットライン・Slab から recon プレビューを更新し、幾何を保持する。
  const refreshPreview = useCallback((ln: CutLine) => {
    const engine = engineRef.current;
    if (!engine) return;
    const s = slabRef.current;
    const g = setReslicePreview(engine, VIEWPORT_IDS, ln, {
      numSlices: s.numSlices,
      thickness: s.thickness,
      gap: s.gap,
      mode: s.mode,
    });
    geomRef.current = g;
  }, []);

  const start = useCallback(async () => {
    let ctx: SlicerContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-slicer-ctx");
      if (raw) ctx = JSON.parse(raw) as SlicerContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("slicer.noContext"));
      return;
    }
    if (mode !== "standalone") {
      setPhase("unsupported");
      setMessage(t("slicer.webUnsupported"));
      return;
    }

    setPhase("loading");
    setMessage(t("slicer.loading"));
    try {
      await ensureCornerstoneInitialized();

      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("slicer.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);

      const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
      if (instances.length < 3) {
        setPhase("error");
        setMessage(t("slicer.needVolume"));
        return;
      }
      const imageIds = instances.map((i) => imageIdForInstance(mode, i.sopInstanceUid));
      const volumeId = `graphy-slicer-vol:${series.seriesInstanceUid}`;
      await buildMprVolume(imageIds, series.modality, volumeId);

      if (!baseRef.current || !reconRef.current) {
        setPhase("error");
        setMessage(t("slicer.error"));
        return;
      }
      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;
      await setupSlicerViewports(
        engine,
        ENGINE_ID,
        { base: baseRef.current, recon: reconRef.current },
        VIEWPORT_IDS,
        volumeId,
        TOOL_GROUP_ID,
      );
      setPhase("ready");

      // 初期カットライン（ベース中心を通る水平線, 幅=要素の 60%）。
      requestAnimationFrame(() => {
        const el = baseRef.current;
        if (!el) return;
        const { cx, cy } = baseViewportCenter(engine, VIEWPORT_IDS.base, el);
        const half = (el.clientWidth || 300) * 0.3;
        const ln: CutLine = { x0: cx - half, y0: cy, x1: cx + half, y1: cy };
        setLine(ln);
        refreshPreview(ln);
      });
    } catch (e) {
      setPhase("error");
      setMessage(`${t("slicer.error")}: ${String(e)}`);
    }
  }, [mode, t, refreshPreview]);

  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  useEffect(() => {
    return () => {
      teardownSlicer(engineRef.current, TOOL_GROUP_ID);
      engineRef.current = null;
    };
  }, []);

  // Slab パラメータ変更でプレビュー更新。
  useEffect(() => {
    if (phase === "ready" && line) refreshPreview(line);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slab]);

  // ── カットラインのドラッグ（左ボタン） ──
  const onOverlayPointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (e.button !== 0 || !line) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const d0 = Math.hypot(x - line.x0, y - line.y0);
      const d1 = Math.hypot(x - line.x1, y - line.y1);
      let kind: DragKind = "body";
      if (d0 < 12) kind = "p0";
      else if (d1 < 12) kind = "p1";
      dragRef.current = { kind, startX: x, startY: y, line: { ...line } };
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
      e.stopPropagation();
    },
    [line],
  );

  const onOverlayPointerMove = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d.kind) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const dx = x - d.startX;
    const dy = y - d.startY;
    let next: CutLine;
    if (d.kind === "p0") next = { ...d.line, x0: x, y0: y };
    else if (d.kind === "p1") next = { ...d.line, x1: x, y1: y };
    else next = { x0: d.line.x0 + dx, y0: d.line.y0 + dy, x1: d.line.x1 + dx, y1: d.line.y1 + dy };
    setLine(next);
    refreshPreview(next);
  }, [refreshPreview]);

  const onOverlayPointerUp = useCallback((e: React.PointerEvent<SVGSVGElement>) => {
    dragRef.current.kind = null;
    try {
      (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }, []);

  // ── 確定リスライス（クライアント側でスタック生成、保存は P3） ──
  const onGenerate = useCallback(() => {
    const engine = engineRef.current;
    const g = geomRef.current;
    if (!engine || !g) return;
    const vol = extractResliceVolume(engine, VIEWPORT_IDS.base);
    if (!vol) {
      setGenInfo(t("slicer.error"));
      return;
    }
    const outSpacing = volumeMinSpacing(engine, VIEWPORT_IDS.base);
    // rowDir=カットライン方向, colDir=断面法線の反対（行は下方向）。buildReslicePlane が正規化。
    const plane = buildReslicePlane({
      center: g.center,
      normal: g.normal,
      up: g.up,
      fovWidth: slab.fovWidth,
      fovHeight: slab.fovHeight,
      colSpacing: outSpacing,
      rowSpacing: outSpacing,
    });
    const stack = reslice(vol, plane, {
      numSlices: slab.numSlices,
      thickness: slab.thickness,
      gap: slab.gap,
      mode: slab.mode,
    });
    setGenInfo(
      t("slicer.generated", {
        n: String(stack.numSlices),
        rows: String(stack.rows),
        cols: String(stack.cols),
      }),
    );
  }, [slab, t]);

  const busy = phase === "loading" || phase === "idle";
  const num = (v: number) => (Number.isFinite(v) ? v : 0);
  const setNum = (key: keyof SlabParams, min: number) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Math.max(min, num(parseFloat(e.target.value)));
    setSlab((s) => ({ ...s, [key]: v }));
  };

  return (
    <div style={root}>
      <div style={header}>
        <span style={hTitle}>{t("main.toolbar.slicer")}</span>
        {title && <span style={hSeries}>{title}</span>}
      </div>

      <div style={body}>
        <div style={cell}>
          <div ref={baseRef} style={vpEl} onContextMenu={(e) => e.preventDefault()} />
          {line && phase === "ready" && (
            <svg
              style={svgOverlay}
              onPointerDown={onOverlayPointerDown}
              onPointerMove={onOverlayPointerMove}
              onPointerUp={onOverlayPointerUp}
            >
              <line x1={line.x0} y1={line.y0} x2={line.x1} y2={line.y1} stroke="#ff5a5a" strokeWidth={1.5} />
              <circle cx={line.x0} cy={line.y0} r={6} fill="#ff5a5a" style={{ cursor: "move" }} />
              <circle cx={line.x1} cy={line.y1} r={6} fill="#ff5a5a" style={{ cursor: "move" }} />
            </svg>
          )}
          <span style={{ ...cellLabel, color: "#ff8a8a" }}>{t("slicer.base")}</span>
          {phase === "ready" && <span style={hint}>{t("slicer.lineHint")}</span>}
        </div>
        <div style={cell}>
          <div ref={reconRef} style={vpEl} onContextMenu={(e) => e.preventDefault()} />
          <span style={{ ...cellLabel, color: "#5ad1ff" }}>{t("slicer.recon")}</span>
          {isPreviewApprox(slab.mode) && phase === "ready" && (
            <span style={approxChip}>{t("slicer.previewApprox")}</span>
          )}
        </div>
        {phase !== "ready" && (
          <div style={overlay}>
            <div style={overlayBox}>{busy ? t("slicer.loading") : message}</div>
          </div>
        )}
      </div>

      {phase === "ready" && (
        <div style={panel}>
          <Field label={t("slicer.fovW")} value={slab.fovWidth} onChange={setNum("fovWidth", 1)} unit="mm" />
          <Field label={t("slicer.fovH")} value={slab.fovHeight} onChange={setNum("fovHeight", 1)} unit="mm" />
          <Field label={t("slicer.thickness")} value={slab.thickness} onChange={setNum("thickness", 0.1)} unit="mm" step={0.5} />
          <Field label={t("slicer.gap")} value={slab.gap} onChange={setNum("gap", 0)} unit="mm" step={0.5} />
          <Field label={t("slicer.numSlices")} value={slab.numSlices} onChange={setNum("numSlices", 1)} step={1} />
          <label style={fieldWrap}>
            <span style={fieldLabel}>{t("slicer.reconMode")}</span>
            <select
              style={select}
              value={slab.mode}
              onChange={(e) => setSlab((s) => ({ ...s, mode: e.target.value as ReconMode }))}
            >
              {RECON_MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <div style={{ flex: 1 }} />
          {genInfo && <span style={genInfoStyle}>{genInfo}</span>}
          <button style={genBtn} onClick={onGenerate}>
            {t("slicer.generate")}
          </button>
          <button style={saveBtn} disabled title={t("slicer.saveTodo")}>
            {t("slicer.save")}
          </button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  unit,
  step,
}: {
  label: string;
  value: number;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  unit?: string;
  step?: number;
}) {
  return (
    <label style={fieldWrap}>
      <span style={fieldLabel}>{label}</span>
      <input type="number" style={input} value={value} onChange={onChange} step={step ?? 1} />
      {unit && <span style={fieldUnit}>{unit}</span>}
    </label>
  );
}

// ── styles ────────────────────────────────────────────────────
const root: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  flexDirection: "column",
  background: "#000",
  color: "#e6eaee",
  fontFamily: "system-ui, sans-serif",
};
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "6px 12px",
  background: "#14181c",
  borderBottom: "1px solid #23292f",
  fontSize: 13,
};
const hTitle: React.CSSProperties = { fontWeight: 600 };
const hSeries: React.CSSProperties = { color: "#9aa6b2" };
const body: React.CSSProperties = { position: "relative", flex: 1, display: "flex", minHeight: 0 };
const cell: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0, borderRight: "1px solid #23292f" };
const vpEl: React.CSSProperties = { position: "absolute", inset: 0 };
const svgOverlay: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", touchAction: "none" };
const cellLabel: React.CSSProperties = {
  position: "absolute",
  top: 6,
  left: 8,
  fontSize: 12,
  fontWeight: 600,
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const hint: React.CSSProperties = {
  position: "absolute",
  bottom: 6,
  left: 8,
  fontSize: 11,
  color: "#8a96a2",
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const approxChip: React.CSSProperties = {
  position: "absolute",
  top: 6,
  right: 8,
  fontSize: 10,
  color: "#ffd27a",
  border: "1px solid #5a4a2a",
  background: "#2a220f",
  borderRadius: 4,
  padding: "1px 6px",
  pointerEvents: "none",
};
const overlay: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "rgba(0,0,0,0.55)",
};
const overlayBox: React.CSSProperties = {
  padding: "10px 18px",
  background: "#1b2126",
  border: "1px solid #2c343b",
  borderRadius: 8,
  fontSize: 13,
  maxWidth: "80%",
  textAlign: "center",
};
const panel: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "8px 12px",
  background: "#14181c",
  borderTop: "1px solid #23292f",
  fontSize: 12,
  flexWrap: "wrap",
};
const fieldWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const fieldLabel: React.CSSProperties = { color: "#9aa6b2" };
const fieldUnit: React.CSSProperties = { color: "#7f8b96" };
const input: React.CSSProperties = {
  width: 62,
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "2px 6px",
};
const select: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "2px 6px",
};
const genInfoStyle: React.CSSProperties = { color: "#8fe08f", fontSize: 12 };
const genBtn: React.CSSProperties = {
  background: "#0b5cad",
  color: "#fff",
  border: "none",
  borderRadius: 5,
  fontSize: 12,
  padding: "5px 12px",
  cursor: "pointer",
};
const saveBtn: React.CSSProperties = {
  background: "#1b2126",
  color: "#7f8b96",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "5px 12px",
  cursor: "not-allowed",
};
