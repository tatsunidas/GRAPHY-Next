/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer ウィンドウ（P1）。単一の VOLUME_3D ビューポートで VR/MIP/MinIP を表示する。
 *
 * 起動: MainScreen が選択スタディ/シリーズを `localStorage("graphy-viewer3d-ctx")` に書き、
 * desktop=`openViewer("viewer3d")` / web=`window.open("#viewer3d")` で本画面（`App` の #viewer3d ルート）を開く。
 * ボリューム構築・チルト補正は MPR と共通の `viewer/mpr.ts#buildMprVolume`。表示配線は `viewer/volumeRender.ts`。
 * 設計: `fw/3d-viewer-design.md`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RenderingEngine } from "@cornerstonejs/core";
import {
  fetchSeries,
  fetchInstances,
  type AppStatus,
  type Study,
  type Series,
  type LutData,
} from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForInstance } from "../viewer/imageId";
import { buildMprVolume } from "../viewer/mpr";
import {
  setup3DViewport,
  setRenderMode,
  applyPreset,
  applyVrWl,
  applyColormap,
  applyOpacityPoints,
  reset3DView,
  teardown3D,
  type OpacityPoint,
} from "../viewer/volumeRender";
import {
  presetsForModality,
  defaultPreset,
  registerLutColormap,
  ensureGrayscaleColormap,
  type RenderMode,
} from "../viewer/transferFunction";
import { LutDialog } from "../viewer/LutDialog";
import { OpacityCurveDialog } from "./OpacityCurveDialog";
import { presetLabel } from "../viewer2d/wlPresets";
import { useWlPresets } from "../viewer2d/wlPresetStore";
import { useI18n } from "../i18n/i18n";

const ENGINE_ID = "graphy-viewer3d-engine";
const TOOL_GROUP_ID = "graphy-viewer3d-tg";
const VIEWPORT_ID = "viewer3d-main";

interface Viewer3DContext {
  study: Study;
  series?: Series;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

const MODES: RenderMode[] = ["VR", "MIP", "MINIP"];

export function Viewer3DScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const presets = useWlPresets();
  const vpRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const startedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [tilt, setTilt] = useState<number | null>(null);
  const [modality, setModality] = useState<string | null>(null);
  const [mode, setMode] = useState<RenderMode>("VR");
  const [preset, setPreset] = useState<string>("");
  const [volumeId, setVolumeId] = useState<string>("");
  const [lutName, setLutName] = useState<string | null>(null);
  const [opacityPts, setOpacityPts] = useState<OpacityPoint[]>([]);
  const [lutOpen, setLutOpen] = useState(false);
  const [curveOpen, setCurveOpen] = useState(false);

  const mode2 = status?.mode === "standalone" ? "standalone" : "web";

  const start = useCallback(async () => {
    let ctx: Viewer3DContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-viewer3d-ctx");
      if (raw) ctx = JSON.parse(raw) as Viewer3DContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("viewer3d.noContext"));
      return;
    }
    if (mode2 !== "standalone") {
      setPhase("unsupported");
      setMessage(t("viewer3d.webUnsupported"));
      return;
    }

    setPhase("loading");
    setMessage(t("viewer3d.loading"));

    try {
      await ensureCornerstoneInitialized();

      // シリーズ解決: ctx にあればそれ、無ければ最多インスタンスのシリーズ。
      let series = ctx.series;
      if (!series) {
        const list = await fetchSeries(ctx.study.studyInstanceUid);
        series = list.slice().sort((a, b) => b.numberOfInstances - a.numberOfInstances)[0];
      }
      if (!series) {
        setPhase("error");
        setMessage(t("viewer3d.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);
      setModality(series.modality);

      const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
      if (instances.length < 3) {
        setPhase("error");
        setMessage(t("viewer3d.needVolume"));
        return;
      }
      const imageIds = instances.map((i) => imageIdForInstance(mode2, i.sopInstanceUid));

      const volId = `graphy-viewer3d-vol:${series.seriesInstanceUid}`;
      const built = await buildMprVolume(imageIds, series.modality, volId);
      setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);
      setVolumeId(volId);
      ensureGrayscaleColormap(); // LUT 解除の戻り先を用意

      if (!vpRef.current) {
        setPhase("error");
        setMessage(t("viewer3d.error"));
        return;
      }

      const initialPreset = defaultPreset(series.modality, "VR");
      setPreset(initialPreset);

      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;
      await setup3DViewport(engine, ENGINE_ID, vpRef.current, VIEWPORT_ID, volId, TOOL_GROUP_ID, {
        modality: series.modality,
        mode: "VR",
        preset: initialPreset,
      });
      setPhase("ready");
    } catch (e) {
      setPhase("error");
      setMessage(`${t("viewer3d.error")}: ${String(e)}`);
    }
  }, [mode2, t]);

  // status(=mode) 確定後に 1 度だけ起動（MprScreen と同様、早期起動での mode 誤判定を避ける）。
  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  // アンマウント時のみ後片付け。
  useEffect(() => {
    return () => {
      teardown3D(engineRef.current, TOOL_GROUP_ID);
      engineRef.current = null;
    };
  }, []);

  const onMode = (next: RenderMode) => {
    setMode(next);
    const engine = engineRef.current;
    if (!engine) return;
    // VR は選択中の色プリセットを維持。MIP/MinIP はモード連動のグレースケール寄りプリセットを適用
    // （`preset` state は VR 色プリセットのまま保持し、VR 復帰時に元へ戻す）。
    if (next === "VR") {
      setRenderMode(engine, VIEWPORT_ID, next, modality, preset || undefined);
    } else {
      setRenderMode(engine, VIEWPORT_ID, next, modality, defaultPreset(modality, next));
    }
  };

  const onPreset = (name: string) => {
    setPreset(name);
    const engine = engineRef.current;
    if (!engine) return;
    // 色プリセットは VR にのみ反映（MIP/MinIP はグレースケール表示。VR 復帰時に適用される）。
    if (mode === "VR") applyPreset(engine, VIEWPORT_ID, name);
  };

  const onWlPreset = (value: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (value === "default") {
      // 現在のレンダリングプリセットを再適用（TF/VOI を既定へ）。
      if (preset) applyPreset(engine, VIEWPORT_ID, preset);
    } else {
      const p = presets.find((x) => x.key === value);
      if (p) applyVrWl(engine, VIEWPORT_ID, p.center, p.width);
    }
  };

  const onResetView = () => {
    const engine = engineRef.current;
    // 回転/パン/ズームに加え、コントラスト(W/L)・TF も現在モードの初期状態へ戻す。
    if (engine) reset3DView(engine, VIEWPORT_ID, mode, modality, mode === "VR" ? preset || undefined : undefined);
  };

  const busy = phase === "loading" || phase === "idle";
  const presetOptions = presetsForModality(modality);

  return (
    <div style={root}>
      <div style={header}>
        <span style={hTitle}>{t("main.toolbar.viewer3d")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {tilt !== null && (
          <span style={tiltChip} title={t("mpr.tiltCorrectedHint")}>
            {t("mpr.tiltCorrected", { deg: tilt.toFixed(1) })}
          </span>
        )}
      </div>
      <div style={bodyWrap}>
        <div style={body}>
          <div
            ref={vpRef}
            style={vpEl}
            onContextMenu={(e) => e.preventDefault()}
          />
          {phase !== "ready" && (
            <div style={overlay}>
              <div style={overlayBox}>{busy ? t("viewer3d.loading") : message}</div>
            </div>
          )}
        </div>
        {phase === "ready" && (
          <div style={panel}>
            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer3d.mode")}</div>
              <div style={modeRow}>
                {MODES.map((m) => (
                  <button
                    key={m}
                    style={mode === m ? modeBtnActive : modeBtn}
                    onClick={() => onMode(m)}
                  >
                    {t(`viewer3d.mode.${m.toLowerCase()}`)}
                  </button>
                ))}
              </div>
            </div>

            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer3d.preset")}</div>
              <select style={select} value={preset} onChange={(e) => onPreset(e.target.value)}>
                {presetOptions.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>

            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer2d.wl.preset")}</div>
              <select style={select} defaultValue="default" onChange={(e) => onWlPreset(e.target.value)}>
                <option value="default">{t("viewer2d.wl.default")}</option>
                {presets.map((p) => (
                  <option key={p.key} value={p.key}>
                    {presetLabel(p, t)}
                  </option>
                ))}
              </select>
            </div>

            <div style={panelSection}>
              <button style={resetBtn} onClick={onResetView}>
                {t("viewer3d.resetView")}
              </button>
            </div>

            <div style={hint}>{t("viewer3d.navHint")}</div>
          </div>
        )}
      </div>
    </div>
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
const tiltChip: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  color: "#ffd27a",
  border: "1px solid #5a4a2a",
  background: "#2a220f",
  borderRadius: 4,
  padding: "1px 7px",
};
const bodyWrap: React.CSSProperties = { position: "relative", flex: 1, display: "flex", minHeight: 0 };
const body: React.CSSProperties = { position: "relative", flex: 1, minWidth: 0 };
const vpEl: React.CSSProperties = { position: "absolute", inset: 0 };
const panel: React.CSSProperties = {
  width: 240,
  flexShrink: 0,
  borderLeft: "1px solid #23292f",
  background: "#0d1013",
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 16,
  overflowY: "auto",
};
const panelSection: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6 };
const panelLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: "#7f8b96",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};
const modeRow: React.CSSProperties = { display: "flex", gap: 4 };
const modeBtn: React.CSSProperties = {
  flex: 1,
  padding: "6px 4px",
  background: "#1b2126",
  color: "#c7d0d8",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 12,
};
const modeBtnActive: React.CSSProperties = {
  ...modeBtn,
  background: "#0b5cad",
  color: "#fff",
  border: "1px solid #0b5cad",
};
const select: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "5px 6px",
};
const resetBtn: React.CSSProperties = {
  padding: "7px 10px",
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 12,
};
const hint: React.CSSProperties = {
  marginTop: "auto",
  fontSize: 11,
  color: "#5a6672",
  lineHeight: 1.5,
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
