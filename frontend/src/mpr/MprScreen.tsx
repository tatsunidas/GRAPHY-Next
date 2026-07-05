/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * MPR ウィンドウ（P1）。1×3（AX | SAG | COR）で VolumeViewport を表示する。
 *
 * 起動: MainScreen が選択スタディ/シリーズを `localStorage("graphy-mpr-ctx")` に書き、
 * desktop=`openViewer("mpr")` / web=`window.open("#mpr")` で本画面（`App` の #mpr ルート）を開く。
 * ボリューム構築・チルト補正・ビューポート配線は `viewer/mpr.ts`。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { RenderingEngine, Enums, eventTarget } from "@cornerstonejs/core";
import {
  fetchSeries,
  fetchInstances,
  prefetchSeries,
  type AppStatus,
  type Study,
  type Series,
} from "../api";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForInstance } from "../viewer/imageId";
import {
  buildMprVolume,
  setupMprViewports,
  teardownMpr,
  applyMprWl,
  resetMprWl,
  readMprOverlay,
  probeMpr,
  type MprViewportIds,
  type MprOverlay,
  type MprProbe,
} from "../viewer/mpr";
import { presetLabel } from "../viewer2d/wlPresets";
import { useWlPresets } from "../viewer2d/wlPresetStore";
import { useI18n } from "../i18n/i18n";

const ENGINE_ID = "graphy-mpr-engine";
const TOOL_GROUP_ID = "graphy-mpr-tg";
const VIEWPORT_IDS: MprViewportIds = {
  axial: "mpr-axial",
  sagittal: "mpr-sagittal",
  coronal: "mpr-coronal",
};

interface MprContext {
  study: Study;
  series?: Series;
  ts: number;
}

type Phase = "idle" | "loading" | "ready" | "error" | "unsupported";

export function MprScreen({ status }: { status: AppStatus | null }) {
  const { t } = useI18n();
  const presets = useWlPresets();
  const axialRef = useRef<HTMLDivElement>(null);
  const sagittalRef = useRef<HTMLDivElement>(null);
  const coronalRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const startedRef = useRef(false);

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string>("");
  const [title, setTitle] = useState<string>("");
  const [tilt, setTilt] = useState<number | null>(null);
  const [overlays, setOverlays] = useState<Record<string, MprOverlay>>({});
  const [probe, setProbe] = useState<MprProbe | null>(null);

  const mode = status?.mode === "standalone" ? "standalone" : "web";

  const elFor = useCallback(
    (id: string): HTMLDivElement | null => {
      if (id === VIEWPORT_IDS.axial) return axialRef.current;
      if (id === VIEWPORT_IDS.sagittal) return sagittalRef.current;
      return coronalRef.current;
    },
    [],
  );

  // 方位ラベル/スライス番号のオーバーレイを 3 面ぶん再計算する。
  const refreshOverlays = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;
    const next: Record<string, MprOverlay> = {};
    for (const id of Object.values(VIEWPORT_IDS)) {
      const el = elFor(id);
      if (el) next[id] = readMprOverlay(engine, id, el);
    }
    setOverlays(next);
  }, [elFor]);

  const start = useCallback(async () => {
    // ctx 読み取り。
    let ctx: MprContext | null = null;
    try {
      const raw = localStorage.getItem("graphy-mpr-ctx");
      if (raw) ctx = JSON.parse(raw) as MprContext;
    } catch {
      ctx = null;
    }
    if (!ctx?.study) {
      setPhase("error");
      setMessage(t("mpr.noContext"));
      return;
    }
    // web も対応: imageId は BFF(WADO-RS) 経由の wadouri。ボリューム構築は cornerstone が
    // 各スライスを BFF から読み込む（standalone と同一経路）。

    setPhase("loading");
    setMessage(t("mpr.loading"));

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
        setMessage(t("mpr.noSeries"));
        return;
      }
      setTitle(series.seriesDescription || series.seriesInstanceUid);

      const instances = await fetchInstances(ctx.study.studyInstanceUid, series.seriesInstanceUid);
      if (instances.length < 3) {
        setPhase("error");
        setMessage(t("mpr.needVolume"));
        return;
      }
      const imageIds = instances.map((i) =>
        imageIdForInstance(mode, i.sopInstanceUid, ctx.study.studyInstanceUid, series.seriesInstanceUid),
      );

      // web: 全スライスを 1 リクエストで BFF キャッシュに載せてから volume 構築（個別 WADO-RS 往復を回避）。
      if (mode === "web") {
        try {
          await prefetchSeries(ctx.study.studyInstanceUid, series.seriesInstanceUid);
        } catch {
          /* prefetch は最適化。失敗しても個別取得で続行 */
        }
      }

      const volumeId = `graphy-mpr-vol:${series.seriesInstanceUid}`;
      const built = await buildMprVolume(imageIds, series.modality, volumeId);
      setTilt(built.corrected ? (built.tiltAngleDeg ?? null) : null);

      const els = axialRef.current && sagittalRef.current && coronalRef.current;
      if (!els) {
        setPhase("error");
        setMessage(t("mpr.error"));
        return;
      }

      const engine = new RenderingEngine(ENGINE_ID);
      engineRef.current = engine;
      await setupMprViewports(
        engine,
        ENGINE_ID,
        { axial: axialRef.current!, sagittal: sagittalRef.current!, coronal: coronalRef.current! },
        VIEWPORT_IDS,
        volumeId,
        TOOL_GROUP_ID,
      );
      setPhase("ready");
      // 初回オーバーレイ計算（レイアウト確定後に読む）。
      requestAnimationFrame(() => refreshOverlays());
    } catch (e) {
      setPhase("error");
      setMessage(`${t("mpr.error")}: ${String(e)}`);
    }
  }, [mode, t]);

  // status(=mode) が確定してから 1 度だけ起動する。マウント時は status=null のことが多く、
  // 早期に走らせると mode が "web" と誤判定されるため待つ。
  useEffect(() => {
    if (startedRef.current || !status) return;
    startedRef.current = true;
    void start();
  }, [status, start]);

  // アンマウント時のみ後片付け（status 変化で破棄しないよう分離）。
  useEffect(() => {
    return () => {
      teardownMpr(engineRef.current, TOOL_GROUP_ID);
      engineRef.current = null;
    };
  }, []);

  // カメラ変更（Crosshairs ジャンプ・スライス送り・pan/zoom）でオーバーレイを追従。
  useEffect(() => {
    if (phase !== "ready") return;
    const onCam = () => refreshOverlays();
    eventTarget.addEventListener(Enums.Events.CAMERA_MODIFIED, onCam);
    return () => eventTarget.removeEventListener(Enums.Events.CAMERA_MODIFIED, onCam);
  }, [phase, refreshOverlays]);

  // マウス直下の実空間座標＋輝度値を上段に出す。
  const onCellMove = useCallback((viewportId: string, e: React.MouseEvent<HTMLDivElement>) => {
    const engine = engineRef.current;
    if (!engine) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const r = probeMpr(engine, viewportId, e.clientX - rect.left, e.clientY - rect.top);
    if (r) setProbe(r);
  }, []);

  const viewportIds = [VIEWPORT_IDS.axial, VIEWPORT_IDS.sagittal, VIEWPORT_IDS.coronal];
  const onPreset = (value: string) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (value === "default") {
      resetMprWl(engine, viewportIds);
    } else {
      const p = presets.find((x) => x.key === value);
      if (p) applyMprWl(engine, viewportIds, p.center, p.width);
    }
  };

  const busy = phase === "loading" || phase === "idle";

  return (
    <div style={root}>
      <div style={header}>
        <span style={hTitle}>{t("main.toolbar.mpr")}</span>
        {title && <span style={hSeries}>{title}</span>}
        {phase === "ready" && (
          <label style={wlWrap}>
            <span style={wlLabel}>{t("viewer2d.wl.preset")}</span>
            <select style={wlSelect} defaultValue="default" onChange={(e) => onPreset(e.target.value)}>
              <option value="default">{t("viewer2d.wl.default")}</option>
              {presets.map((p) => (
                <option key={p.key} value={p.key}>
                  {presetLabel(p, t)}
                </option>
              ))}
            </select>
          </label>
        )}
        {tilt !== null && (
          <span style={tiltChip} title={t("mpr.tiltCorrectedHint")}>
            {t("mpr.tiltCorrected", { deg: tilt.toFixed(1) })}
          </span>
        )}
      </div>
      {phase === "ready" && (
        <div style={readout}>
          {probe ? (
            <>
              <span style={roItem}>
                <b style={roKey}>X</b> {probe.world[0].toFixed(1)}
                <b style={roKey}>Y</b> {probe.world[1].toFixed(1)}
                <b style={roKey}>Z</b> {probe.world[2].toFixed(1)}
                <span style={roUnit}>mm</span>
              </span>
              {probe.ijk && (
                <span style={roItem}>
                  <b style={roKey}>{t("mpr.voxel")}</b> {probe.ijk[0]},{probe.ijk[1]},{probe.ijk[2]}
                </span>
              )}
              <span style={roItem}>
                <b style={roKey}>{t("mpr.value")}</b>{" "}
                {probe.value === null ? "—" : Math.round(probe.value)}
              </span>
            </>
          ) : (
            <span style={roHint}>{t("mpr.probeHint")}</span>
          )}
        </div>
      )}
      <div style={body}>
        <Cell label={t("mpr.axial")} color="#00dc00" refEl={axialRef} overlay={overlays[VIEWPORT_IDS.axial]}
          onMove={(e) => onCellMove(VIEWPORT_IDS.axial, e)} onLeave={() => setProbe(null)} />
        <Cell label={t("mpr.sagittal")} color="#dcdc00" refEl={sagittalRef} overlay={overlays[VIEWPORT_IDS.sagittal]}
          onMove={(e) => onCellMove(VIEWPORT_IDS.sagittal, e)} onLeave={() => setProbe(null)} />
        <Cell label={t("mpr.coronal")} color="#00a0ff" refEl={coronalRef} overlay={overlays[VIEWPORT_IDS.coronal]}
          onMove={(e) => onCellMove(VIEWPORT_IDS.coronal, e)} onLeave={() => setProbe(null)} />
        {phase !== "ready" && (
          <div style={overlay}>
            <div style={overlayBox}>{busy ? t("mpr.loading") : message}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function Cell({
  label,
  color,
  refEl,
  overlay,
  onMove,
  onLeave,
}: {
  label: string;
  color: string;
  refEl: React.RefObject<HTMLDivElement>;
  overlay?: MprOverlay;
  onMove?: (e: React.MouseEvent<HTMLDivElement>) => void;
  onLeave?: () => void;
}) {
  const m = overlay?.markers ?? null;
  return (
    <div style={cell}>
      <div
        ref={refEl}
        style={vpEl}
        onContextMenu={(e) => e.preventDefault()}
        onMouseMove={onMove}
        onMouseLeave={onLeave}
      />
      <span style={{ ...cellLabel, color }}>{label}</span>
      {overlay && overlay.total > 0 && (
        <span style={sliceLabel}>
          {overlay.slice + 1} / {overlay.total}
        </span>
      )}
      {m && (
        <>
          <span style={{ ...markTop }}>{m.top}</span>
          <span style={{ ...markBottom }}>{m.bottom}</span>
          <span style={{ ...markLeft }}>{m.left}</span>
          <span style={{ ...markRight }}>{m.right}</span>
        </>
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
const wlWrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: 5, marginLeft: 8 };
const wlLabel: React.CSSProperties = { color: "#9aa6b2", fontSize: 12 };
const wlSelect: React.CSSProperties = {
  background: "#1b2126",
  color: "#e6eaee",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 12,
  padding: "2px 6px",
};
const tiltChip: React.CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  color: "#ffd27a",
  border: "1px solid #5a4a2a",
  background: "#2a220f",
  borderRadius: 4,
  padding: "1px 7px",
};
const readout: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "3px 12px",
  background: "#0d1013",
  borderBottom: "1px solid #23292f",
  fontSize: 12,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#c7d0d8",
  minHeight: 22,
};
const roItem: React.CSSProperties = { whiteSpace: "nowrap" };
const roKey: React.CSSProperties = { color: "#7f8b96", fontWeight: 600, margin: "0 4px 0 0" };
const roUnit: React.CSSProperties = { color: "#7f8b96", marginLeft: 4 };
const roHint: React.CSSProperties = { color: "#5a6672" };
const body: React.CSSProperties = { position: "relative", flex: 1, display: "flex", minHeight: 0 };
const cell: React.CSSProperties = {
  position: "relative",
  flex: 1,
  minWidth: 0,
  borderRight: "1px solid #23292f",
};
const vpEl: React.CSSProperties = { position: "absolute", inset: 0 };
const cellLabel: React.CSSProperties = {
  position: "absolute",
  top: 6,
  left: 8,
  fontSize: 12,
  fontWeight: 600,
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const sliceLabel: React.CSSProperties = {
  position: "absolute",
  bottom: 6,
  left: 8,
  fontSize: 11,
  color: "#c7d0d8",
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const markBase: React.CSSProperties = {
  position: "absolute",
  color: "#e6eaee",
  fontSize: 12,
  fontWeight: 700,
  textShadow: "0 0 3px #000",
  pointerEvents: "none",
};
const markTop: React.CSSProperties = { ...markBase, top: 4, left: "50%", transform: "translateX(-50%)" };
const markBottom: React.CSSProperties = { ...markBase, bottom: 4, left: "50%", transform: "translateX(-50%)" };
const markLeft: React.CSSProperties = { ...markBase, left: 4, top: "50%", transform: "translateY(-50%)" };
const markRight: React.CSSProperties = { ...markBase, right: 4, top: "50%", transform: "translateY(-50%)" };
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
