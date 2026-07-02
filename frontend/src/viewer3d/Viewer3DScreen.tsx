/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 3D Viewer ウィンドウ。描画・操作は **pure VTK.js**（`viewer/vtkVolumeView.ts`）。
 *
 * ボリューム構築は Cornerstone 共通の `buildMprVolume`（CT ガントリチルト補正込み）を流用し、その
 * `vtkImageData` を pure vtk の `vtkGenericRenderWindow` へ横取りして渡す（設計 `fw/3d-viewer-design.md`）。
 * これにより cornerstone VOLUME_3D の制約（blend no-op / clipping-plane CONTEXT_LOST / オフスクリーン
 * interactor でウィジェット操作不可 / 回転後 worldToCanvas 不正確）を回避し、**ドラッグ可能なクリップ箱**・
 * 真の MIP/MinIP・座標整合を得る。2D/MPR/Slicer は現状維持。
 */
import { useCallback, useEffect, useRef, useState } from "react";
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
  createVtkVolumeView,
  vtkImageDataFromVolume,
  type VtkVolumeView,
  type VtkRenderMode,
  type VtkOpacityPoint,
} from "../viewer/vtkVolumeView";
import { presetLabel } from "../viewer2d/wlPresets";
import { useWlPresets } from "../viewer2d/wlPresetStore";
import { presetsForModality } from "../viewer/transferFunction";
import { LutDialog } from "../viewer/LutDialog";
import { OpacityCurveDialog } from "./OpacityCurveDialog";
import { SceneObjectPanel } from "./SceneObjectPanel";
import { Viewer3DCutOverlay } from "./Viewer3DCutOverlay";
import { Viewer3DMeasureOverlay } from "./Viewer3DMeasureOverlay";
import { Viewer3DEndoPathOverlay } from "./Viewer3DEndoPathOverlay";
import { Viewer3DCinematicOverlay } from "./Viewer3DCinematicOverlay";
import { CenterlineDialog } from "./CenterlineDialog";
import { MeshRepairDialog } from "./MeshRepairDialog";
import { ColorLegend } from "./ColorLegend";
import { Viewer3DMenuBar } from "./Viewer3DMenuBar";
import { CinematicSettingsDialog } from "./CinematicSettingsDialog";
import { RepresentationStateDialog } from "./RepresentationStateDialog";
import { ViewInfoOverlay } from "./ViewInfoOverlay";
import { fetchLutData } from "../api";
import { attachSceneRenderer, resetScene, setClipContext, updateClip } from "./scene3d";
import { geomFromImageData, type VolumeGeom } from "../viewer/labelVolume";
import { useI18n } from "../i18n/i18n";

interface Viewer3DContext {
  study: Study;
  series?: Series;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

const MODES: VtkRenderMode[] = ["VR", "MIP", "MINIP", "ORTHO"];

/** モダリティ既定の W/L（CT=40/400、他は scalar 範囲）。 */
function defaultWl(modality: string | null, range: [number, number]): { center: number; width: number } {
  if ((modality ?? "").toUpperCase() === "CT") return { center: 40, width: 400 };
  const [mn, mx] = range;
  return { center: (mn + mx) / 2, width: Math.max(1, mx - mn) };
}

export function Viewer3DScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const presets = useWlPresets();
  const vpRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<VtkVolumeView | null>(null);
  const startedRef = useRef(false);
  const wlDefaultRef = useRef<{ center: number; width: number }>({ center: 40, width: 400 });

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [tilt, setTilt] = useState<number | null>(null);
  const [mode, setMode] = useState<VtkRenderMode>("VR");
  const [orthoPos, setOrthoPos] = useState<{ x: number; y: number; z: number }>({ x: 0.5, y: 0.5, z: 0.5 });
  const [lutName, setLutName] = useState<string | null>(null);
  const [opacityPts, setOpacityPts] = useState<VtkOpacityPoint[]>([]);
  const [clipOn, setClipOn] = useState(false);
  const [lutOpen, setLutOpen] = useState(false);
  const [curveOpen, setCurveOpen] = useState(false);
  const [cinematicOpen, setCinematicOpen] = useState(false);
  const [reprOpen, setReprOpen] = useState(false);
  const [rotateMode, setRotateMode] = useState<"camera" | "actor">("camera");
  const [presetName, setPresetName] = useState<string>("none");
  const modalityRef = useRef<string | null>(null);
  // 派生シリーズ保存（CPR/ストレート化）用の study/series 識別子。
  const seriesRef = useRef<{ studyUid: string; seriesUid: string; seriesDesc: string } | null>(null);
  const [volumeId, setVolumeId] = useState<string>("");
  // 表示ボリュームの実空間幾何（mesh→ROI ボクセル化の対象）。
  const [sceneGeom, setSceneGeom] = useState<VolumeGeom | null>(null);
  // 3D Cut（lasso）対象 ROI の id（null=カット非アクティブ）。
  const [cutTargetId, setCutTargetId] = useState<string | null>(null);
  // 3D 計測（ルーラー）モード。
  const [measureMode, setMeasureMode] = useState(false);
  // 手動内視鏡経路 編集モード。
  const [endoPathMode, setEndoPathMode] = useState(false);
  // 中心線解析ダイアログ対象（ROI/メッシュ）。
  const [analyzeTarget, setAnalyzeTarget] = useState<{ id: string; name: string } | null>(null);
  // メッシュ修復ダイアログ対象。
  const [repairTarget, setRepairTarget] = useState<{ id: string; name: string } | null>(null);
  // カラーレジェンド overlay 表示。
  const [legendOn, setLegendOn] = useState(false);
  // Cinematic v2（パストレース）オーバーレイ表示。
  const [pathTraceOn, setPathTraceOn] = useState(false);

  // カット/計測/経路編集は排他（同時にオーバーレイがクリックを奪い合わないように）。
  const startCut = useCallback((id: string) => {
    setMeasureMode(false);
    setEndoPathMode(false);
    setCutTargetId(id);
  }, []);
  const toggleMeasure = useCallback(() => {
    setCutTargetId(null);
    setEndoPathMode(false);
    setMeasureMode((v) => !v);
  }, []);
  const toggleEndoPath = useCallback(() => {
    setCutTargetId(null);
    setMeasureMode(false);
    setEndoPathMode((v) => !v);
  }, []);
  const analyzeCenterline = useCallback((id: string, name: string) => {
    setMeasureMode(false);
    setEndoPathMode(false);
    setCutTargetId(null);
    setAnalyzeTarget({ id, name });
  }, []);

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
      modalityRef.current = series.modality;
      seriesRef.current = {
        studyUid: ctx.study.studyInstanceUid,
        seriesUid: series.seriesInstanceUid,
        seriesDesc: series.seriesDescription || series.seriesInstanceUid,
      };

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

      // Cornerstone が構築したボリュームから scalar 付き vtkImageData を組み立てて pure vtk へ渡す
      // （streaming volume の imageData は scalar を pointData に持たないため作り直す）。
      const imageData = vtkImageDataFromVolume(volId);
      if (!vpRef.current || !imageData) {
        setPhase("error");
        setMessage(t("viewer3d.error"));
        return;
      }

      // scalar 範囲から既定 W/L を決める。
      let range: [number, number] = [0, 1];
      try {
        const r = imageData.getPointData().getScalars().getRange();
        if (Array.isArray(r) && r.length >= 2) range = [r[0], r[1]];
      } catch {
        /* ignore */
      }
      const wl = defaultWl(series.modality, range);
      wlDefaultRef.current = wl;

      const view = createVtkVolumeView(vpRef.current, imageData, {
        mode: "VR",
        center: wl.center,
        width: wl.width,
      });
      viewRef.current = view;
      // mesh / 3D ROI アクターを同一 vtk シーンへ重畳するため renderer を接続。
      try {
        const parts = view.getSceneParts();
        attachSceneRenderer({ renderer: parts.renderer, render: parts.render });
        const geom = geomFromImageData(parts.imageData);
        setSceneGeom(geom);
        // クリップ箱（埋め込み表示）の基準幾何を設定し、クロップ変化を購読して
        // 埋め込みオブジェクトをボリュームと一緒にカットする。
        setClipContext(geom);
        view.subscribeClip((extent) => updateClip(extent));
      } catch {
        /* シーン重畳が使えなくてもボリューム表示は継続 */
      }
      setPhase("ready");
    } catch (e) {
      setPhase("error");
      setMessage(`${t("viewer3d.error")}: ${String(e)}`);
    }
  }, [mode2, t]);

  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  // アンマウント時に vtk を破棄。
  useEffect(() => {
    return () => {
      try {
        resetScene();
      } catch {
        /* ignore */
      }
      try {
        viewRef.current?.destroy();
      } catch {
        /* ignore */
      }
      viewRef.current = null;
    };
  }, []);

  // コンテナのリサイズに追従。
  useEffect(() => {
    if (phase !== "ready" || !vpRef.current) return;
    const ro = new ResizeObserver(() => viewRef.current?.resize());
    ro.observe(vpRef.current);
    return () => ro.disconnect();
  }, [phase]);

  const onMode = (next: VtkRenderMode) => {
    setMode(next);
    setOpacityPts([]); // モード変更で手動不透明度カーブは解除（view 側も解除される）
    // VR プリセットは VR 専用。モード変更時は解除してから切替（MIP/MinIP の TF を正しく適用）。
    setPresetName("none");
    viewRef.current?.applyPreset(null);
    viewRef.current?.setMode(next);
    if (next === "ORTHO") viewRef.current?.setOrthoPositions(orthoPos.x, orthoPos.y, orthoPos.z);
  };

  // VR プリセット（色/不透明度 TF）。"none" でグレースケール/W-L へ。
  const onPreset = (value: string) => {
    setPresetName(value);
    viewRef.current?.applyPreset(value === "none" ? null : value);
  };

  // Ortho の各軸スライス位置（0..1）。
  const onOrthoChange = (axis: "x" | "y" | "z", val: number) => {
    const next = { ...orthoPos, [axis]: val };
    setOrthoPos(next);
    viewRef.current?.setOrthoPositions(next.x, next.y, next.z);
  };

  const onSelectLut = (lut: LutData | null) => {
    setLutName(lut ? lut.name : null);
    viewRef.current?.setColorLut(lut ? { r: lut.r, g: lut.g, b: lut.b } : null);
  };

  const onOpacityChange = (points: VtkOpacityPoint[]) => {
    setOpacityPts(points);
    viewRef.current?.setOpacityPoints(points);
  };

  const onWlPreset = (value: string) => {
    const view = viewRef.current;
    if (!view) return;
    if (value === "default") {
      const wl = wlDefaultRef.current;
      view.setWindowLevel(wl.center, wl.width);
    } else {
      const p = presets.find((x) => x.key === value);
      if (p) view.setWindowLevel(p.center, p.width);
    }
  };

  const onToggleClip = () => {
    const next = !clipOn;
    setClipOn(next);
    viewRef.current?.setClipEnabled(next);
  };

  const onResetView = () => {
    const view = viewRef.current;
    if (!view) return;
    // 視点＋コントラスト＋TF＋クリップを初期状態へ。
    view.resetView();
    const wl = wlDefaultRef.current;
    view.setWindowLevel(wl.center, wl.width);
    view.setColorLut(null);
    view.setOpacityPoints(null);
    view.setClipEnabled(false);
    setLutName(null);
    setOpacityPts([]);
    setClipOn(false);
  };

  const onSetRotate = (m: "camera" | "actor") => {
    setRotateMode(m);
    viewRef.current?.setRotateMode(m);
  };

  // Representation State ダイアログからの適用: 幾何は view 側で反映済み。ここではモードと LUT を同期。
  const onApplyReprState = (patch: { mode: VtkRenderMode; lutName: string | null }) => {
    if (patch.mode !== mode) {
      setMode(patch.mode);
      setOpacityPts([]);
      viewRef.current?.setMode(patch.mode);
      if (patch.mode === "ORTHO") viewRef.current?.setOrthoPositions(orthoPos.x, orthoPos.y, orthoPos.z);
    }
    if (patch.lutName !== lutName) {
      if (!patch.lutName) {
        onSelectLut(null);
      } else {
        fetchLutData(patch.lutName)
          .then((d) => onSelectLut(d))
          .catch(() => {
            /* ignore */
          });
      }
    }
  };

  const busy = phase === "loading" || phase === "idle";

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
      {phase === "ready" && (
        <Viewer3DMenuBar
          onOpenCinematic={() => setCinematicOpen(true)}
          onOpenReprState={() => setReprOpen(true)}
          rotateMode={rotateMode}
          onSetRotate={onSetRotate}
        />
      )}
      <div style={bodyWrap}>
        <div style={body}>
          <div ref={vpRef} style={vpEl} onContextMenu={(e) => e.preventDefault()} />
          {phase === "ready" && viewRef.current && (
            <ViewInfoOverlay view={viewRef.current} lutName={lutName} />
          )}
          {phase === "ready" && viewRef.current && (
            <Viewer3DCinematicOverlay view={viewRef.current} active={pathTraceOn} />
          )}
          {phase === "ready" && viewRef.current && (
            <Viewer3DMeasureOverlay view={viewRef.current} active={measureMode} />
          )}
          {phase === "ready" && viewRef.current && (
            <Viewer3DEndoPathOverlay
              view={viewRef.current}
              active={endoPathMode}
              onExit={() => setEndoPathMode(false)}
            />
          )}
          {phase === "ready" && viewRef.current && cutTargetId && (
            <Viewer3DCutOverlay
              view={viewRef.current}
              targetId={cutTargetId}
              onDone={() => setCutTargetId(null)}
            />
          )}
          {phase === "ready" && viewRef.current && analyzeTarget && volumeId && seriesRef.current && (
            <CenterlineDialog
              view={viewRef.current}
              objectId={analyzeTarget.id}
              volumeId={volumeId}
              geom={sceneGeom}
              studyUid={seriesRef.current.studyUid}
              seriesUid={seriesRef.current.seriesUid}
              seriesDesc={seriesRef.current.seriesDesc}
              modality={modalityRef.current}
              onClose={() => setAnalyzeTarget(null)}
            />
          )}
          {phase === "ready" && viewRef.current && legendOn && (
            <ColorLegend
              view={viewRef.current}
              lutName={lutName}
              modality={modalityRef.current}
              corner="tr"
              onClose={() => setLegendOn(false)}
            />
          )}
          {phase === "ready" && repairTarget && (
            <MeshRepairDialog objectId={repairTarget.id} onClose={() => setRepairTarget(null)} />
          )}
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
                  <button key={m} style={mode === m ? modeBtnActive : modeBtn} onClick={() => onMode(m)}>
                    {t(`viewer3d.mode.${m.toLowerCase()}`)}
                  </button>
                ))}
              </div>
            </div>

            {mode === "VR" && (
              <div style={panelSection}>
                <div style={panelLabel}>{t("viewer3d.preset")}</div>
                <select style={select} value={presetName} onChange={(e) => onPreset(e.target.value)}>
                  <option value="none">{t("viewer3d.presetNone")}</option>
                  {presetsForModality(modalityRef.current).map((n) => (
                    <option key={n} value={n}>
                      {n.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {mode === "ORTHO" && (
              <div style={panelSection}>
                <div style={panelLabel}>{t("viewer3d.orthoPos")}</div>
                {(["x", "y", "z"] as const).map((ax) => (
                  <div key={ax} style={orthoRow}>
                    <span style={orthoAxis}>{ax.toUpperCase()}</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(orthoPos[ax] * 100)}
                      onChange={(e) => onOrthoChange(ax, Number(e.target.value) / 100)}
                      style={{ flex: 1, minWidth: 0 }}
                    />
                  </div>
                ))}
              </div>
            )}

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
              <div style={panelLabel}>{t("viewer3d.transfer")}</div>
              <button style={resetBtn} onClick={() => setLutOpen(true)}>
                {t("viewer3d.lut")}
                {lutName ? `: ${lutName.replace(/_/g, " ")}` : ""}
              </button>
              <button style={resetBtn} onClick={() => setCurveOpen((v) => !v)}>
                {t("viewer3d.opacityCurveBtn")}
              </button>
            </div>

            <div style={panelSection}>
              <div style={panelLabel}>{t("viewer3d.clip")}</div>
              <button style={clipOn ? modeBtnActive : resetBtn} onClick={onToggleClip}>
                {clipOn ? t("viewer3d.clipOnBtn") : t("viewer3d.clipOffBtn")}
              </button>
              {clipOn && <div style={hint}>{t("viewer3d.clipDragHint")}</div>}
            </div>

            <div style={panelSection}>
              <button style={resetBtn} onClick={onResetView}>
                {t("viewer3d.resetView")}
              </button>
              <button style={resetBtn} onClick={() => setLegendOn((v) => !v)}>
                {legendOn ? t("legend.hide") : t("legend.show")}
              </button>
              <button
                style={pathTraceOn ? modeBtnActive : resetBtn}
                title={t("cine2.hint")}
                onClick={() => setPathTraceOn((v) => !v)}
              >
                {pathTraceOn ? t("cine2.stop") : t("cine2.start")}
              </button>
            </div>

            <div style={panelSection}>
              <SceneObjectPanel
                geom={sceneGeom}
                onStartCut={startCut}
                onAnalyzeCenterline={analyzeCenterline}
                onRepairMesh={(id, name) => setRepairTarget({ id, name })}
                measureMode={measureMode}
                onToggleMeasure={toggleMeasure}
                endoPathMode={endoPathMode}
                onToggleEndoPath={toggleEndoPath}
              />
            </div>

            <div style={hint}>{t("viewer3d.navHint")}</div>
          </div>
        )}
      </div>
      {lutOpen && (
        <LutDialog currentLutName={lutName} onSelect={onSelectLut} onClose={() => setLutOpen(false)} />
      )}
      {curveOpen && volumeId && (
        <OpacityCurveDialog
          volumeId={volumeId}
          points={opacityPts}
          onChange={onOpacityChange}
          onClose={() => setCurveOpen(false)}
        />
      )}
      {cinematicOpen && viewRef.current && (
        <CinematicSettingsDialog view={viewRef.current} onClose={() => setCinematicOpen(false)} />
      )}
      {reprOpen && viewRef.current && (
        <RepresentationStateDialog
          view={viewRef.current}
          lutName={lutName}
          onApplied={onApplyReprState}
          onClose={() => setReprOpen(false)}
        />
      )}
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
const orthoRow: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8 };
const orthoAxis: React.CSSProperties = { width: 14, fontSize: 12, color: "#9aa6b2", flexShrink: 0 };
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
