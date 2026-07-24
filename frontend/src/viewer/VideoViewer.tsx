/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { RenderingEngine, Enums, EVENTS } from "@cornerstonejs/core";
import {
  ToolGroupManager,
  PanTool,
  ZoomTool,
  WindowLevelTool,
  LengthTool,
  AngleTool,
  EllipticalROITool,
  RectangleROITool,
  ProbeTool,
  Enums as csToolsEnums,
} from "@cornerstonejs/tools";
import { useI18n } from "../i18n/i18n";
import { fetchVideoMetadata, videoRenderedUrl, type VideoMetadata } from "../api";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import { ensureVideoMetadataProvider, registerVideoMetadata } from "./videoMetadataProvider";

const { MouseBindings } = csToolsEnums;

/**
 * 左ドラッグ（Primary）に割り当て可能な動画ツール。WW/WL と計測/ROI を切り替える
 * （Pan=中ドラッグ・Zoom=右ドラッグは固定）。P3c で ROI 解析（時系列）を載せる土台。
 */
const VIDEO_PRIMARY_TOOLS: { name: string; key: string }[] = [
  { name: WindowLevelTool.toolName, key: "wwwl" },
  { name: LengthTool.toolName, key: "length" },
  { name: AngleTool.toolName, key: "angle" },
  { name: RectangleROITool.toolName, key: "rectangle" },
  { name: EllipticalROITool.toolName, key: "ellipse" },
  { name: ProbeTool.toolName, key: "probe" },
];

/**
 * encapsulated 動画（Video Photographic/Endoscopic/Microscopic）を 2D ビューア枠内で再生する。
 *
 * <p>P3: **方式 A（Cornerstone VideoViewport）を primary** とし、cine コントロール（再生/一時停止・
 * シークバー・再生速度・ループ・フレーム精度送り）を自作で載せる。VideoViewport は WebGL キャンバスに
 * 動画フレームを描くため、後続 P3 で Pan/Zoom・WW/WL・ROI/計測ツールをフレーム上に載せられる。
 *
 * <p>VideoViewport の初期化に失敗した環境（WebGL 不可・HEVC 非対応等）は **方式 B（HTML5 `<video>`）に
 * 自動フォールバック**する。standalone 専用（`/rendered` は索引ローカルファイル前提）。
 */

/** VideoViewport の使用メソッドだけを型付けした最小インタフェース（Types 依存を避ける）。 */
interface VideoVP {
  setVideo(imageId: string, frame?: number): Promise<unknown>;
  setProperties(p: { loop?: boolean; playbackRate?: number }): void;
  play(): Promise<void>;
  pause(): void;
  togglePlayPause(): boolean;
  setFrameNumber(f: number): Promise<void>;
  setPlaybackRate(r?: number): void;
  getFrameNumber(): number;
  getNumberOfSlices(): number;
  resetCamera(): boolean;
  render(): void;
}

type Phase = "loading" | "viewport" | "fallback" | "transcode" | "error";

let engineSeq = 0;

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];

function fmtTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) {
    return "0:00";
  }
  const s = Math.floor(sec % 60);
  const m = Math.floor(sec / 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function VideoViewer({ sopInstanceUid }: { sopInstanceUid: string }) {
  const { t } = useI18n();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const vpRef = useRef<VideoVP | null>(null);
  const toolGroupIdRef = useRef<string | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [meta, setMeta] = useState<VideoMetadata | null>(null);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(1); // 1-based 現在フレーム
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(true);
  const [activeTool, setActiveTool] = useState<string>(WindowLevelTool.toolName);

  const src = useMemo(() => videoRenderedUrl(sopInstanceUid), [sopInstanceUid]);
  const fps = meta && meta.fps > 0 ? meta.fps : 0;
  const totalFrames = meta && meta.numberOfFrames > 0 ? meta.numberOfFrames : 1;

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;

    // 高頻度（毎フレーム）の IMAGE_RENDERED で現在フレームを更新。整数フレームが変わった時だけ setState。
    let lastFrame = 0;
    const onRendered = () => {
      const vp = vpRef.current;
      if (!vp) {
        return;
      }
      const f = vp.getFrameNumber();
      if (f !== lastFrame) {
        lastFrame = f;
        setFrame(f);
      }
    };

    const cleanup = () => {
      if (host) {
        host.removeEventListener(EVENTS.IMAGE_RENDERED, onRendered);
      }
      const vp = vpRef.current;
      if (vp) {
        try {
          vp.pause();
        } catch {
          /* 破棄済み等は無視 */
        }
      }
      const tgId = toolGroupIdRef.current;
      if (tgId) {
        try {
          ToolGroupManager.destroyToolGroup(tgId);
        } catch {
          /* 破棄済み等は無視 */
        }
      }
      const engine = engineRef.current;
      if (engine) {
        try {
          engine.destroy(); // enableElement した VIDEO viewport／WebGL コンテキストを解放
        } catch {
          /* 破棄済み等は無視 */
        }
      }
      toolGroupIdRef.current = null;
      vpRef.current = null;
      engineRef.current = null;
    };

    setPhase("loading");
    setMeta(null);
    setPlaying(false);
    setFrame(1);

    (async () => {
      await ensureCornerstoneInitialized();
      let m: VideoMetadata;
      try {
        m = await fetchVideoMetadata(sopInstanceUid);
      } catch {
        // メタ取得失敗 → <video> フォールバックで再生を試みる。
        if (!cancelled) {
          setPhase("fallback");
        }
        return;
      }
      if (cancelled) {
        return;
      }
      setMeta(m);
      if (m.transcodeRequired) {
        setPhase("transcode");
        return;
      }
      const imageId = registerVideoMetadata(sopInstanceUid, m);
      ensureVideoMetadataProvider();

      const el = hostRef.current;
      if (!el) {
        setPhase("fallback");
        return;
      }
      const engineId = `graphy-video-engine-${engineSeq}`;
      const viewportId = `graphy-video-vp-${engineSeq}`;
      engineSeq += 1;
      try {
        const engine = new RenderingEngine(engineId);
        engineRef.current = engine;
        engine.enableElement({ viewportId, type: Enums.ViewportType.VIDEO, element: el });
        const vp = engine.getViewport(viewportId) as unknown as VideoVP;
        vpRef.current = vp;
        await vp.setVideo(imageId, 1);
        if (cancelled) {
          cleanup();
          return;
        }
        vp.setProperties({ loop });
        vp.pause();
        el.addEventListener(EVENTS.IMAGE_RENDERED, onRendered);
        // ここで再生（方式 A）は成立。以降のツール配線が失敗しても再生・ツールバー表示は維持する。
        setActiveTool(WindowLevelTool.toolName);
        setPhase("viewport");
      } catch (e) {
        // VideoViewport 初期化失敗（WebGL 不可・コーデック非対応等）→ 方式 B にフォールバック。
        console.warn("VideoViewport 初期化に失敗、<video> にフォールバックします", e);
        cleanup();
        if (!cancelled) {
          setPhase("fallback");
        }
        return;
      }

      // ツール（Pan/Zoom/WW-WL ＋ 計測/ROI）を video viewport に紐付ける（best-effort。失敗しても再生は継続）。
      // グローバルツール登録は ensureCornerstoneInitialized 済み。Pan=中ドラッグ・Zoom=右ドラッグ固定、Primary 切替式。
      try {
        const toolGroupId = `${viewportId}-tg`;
        const tg = ToolGroupManager.getToolGroup(toolGroupId) ?? ToolGroupManager.createToolGroup(toolGroupId);
        if (tg) {
          tg.addTool(PanTool.toolName);
          tg.addTool(ZoomTool.toolName);
          for (const { name } of VIDEO_PRIMARY_TOOLS) {
            tg.addTool(name);
            tg.setToolPassive(name);
          }
          tg.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
          tg.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] });
          tg.setToolActive(WindowLevelTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
          tg.addViewport(viewportId, engineId);
          toolGroupIdRef.current = toolGroupId;
        }
      } catch (e) {
        console.warn("動画ツールの初期化に失敗（再生は継続）", e);
      }
    })();

    return () => {
      cancelled = true;
      cleanup();
    };
    // loop はマウント後に viewport へ反映（別 effect）。ここでの初期値のみ使用。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sopInstanceUid]);

  // ループ／再生速度を viewport に反映。
  useEffect(() => {
    const vp = vpRef.current;
    if (phase === "viewport" && vp) {
      try {
        vp.setProperties({ loop, playbackRate: rate });
        vp.setPlaybackRate(rate);
      } catch {
        /* 未初期化はスキップ */
      }
    }
  }, [loop, rate, phase]);

  const togglePlay = () => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    try {
      setPlaying(vp.togglePlayPause());
    } catch {
      /* 無視 */
    }
  };

  // Primary（左ドラッグ）ツールを切り替える。Pan/Zoom（中/右）は据え置き。
  const selectPrimaryTool = (toolName: string) => {
    const tgId = toolGroupIdRef.current;
    if (!tgId) {
      return;
    }
    const tg = ToolGroupManager.getToolGroup(tgId);
    if (!tg) {
      return;
    }
    for (const { name } of VIDEO_PRIMARY_TOOLS) {
      if (name !== toolName) {
        try {
          tg.setToolPassive(name);
        } catch {
          /* 無視 */
        }
      }
    }
    try {
      tg.setToolActive(toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] });
      setActiveTool(toolName);
    } catch {
      /* 無視 */
    }
  };

  const fitView = () => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    try {
      vp.resetCamera();
      vp.render();
    } catch {
      /* 無視 */
    }
  };

  const seekToFrame = (f: number) => {
    const vp = vpRef.current;
    if (!vp) {
      return;
    }
    const clamped = Math.min(Math.max(1, f), totalFrames);
    try {
      vp.pause();
      setPlaying(false);
      vp.setFrameNumber(clamped);
      setFrame(clamped);
    } catch {
      /* 無視 */
    }
  };

  if (phase === "transcode") {
    return <div style={noticeStyle}>🎞 {t("video.needsFfmpeg")}</div>;
  }

  // 方式 B フォールバック（VideoViewport 不可時）。P1 と同じ <video> 直再生。
  if (phase === "fallback") {
    return (
      <div style={{ marginTop: 10 }}>
        <div style={frameStyle}>
          <video key={src} src={src} controls loop={loop} playsInline preload="metadata" style={videoStyle} />
        </div>
        <div style={{ ...controlRowStyle }}>
          <span style={{ color: "#889", fontSize: 12 }}>{t("video.fallbackMode")}</span>
        </div>
      </div>
    );
  }

  const curSec = fps > 0 ? (frame - 1) / fps : 0;
  const totSec = fps > 0 ? (totalFrames - 1) / fps : 0;

  return (
    <div style={{ marginTop: 10 }}>
      {/* VideoViewport のホスト。cornerstone が内部に canvas を生成する。常時マウントして ref を確保。 */}
      <div style={frameStyle}>
        <div ref={hostRef} style={hostStyle} />
      </div>

      {phase === "loading" && <div style={{ ...noticeStyle, color: "#889" }}>{t("common.loading")}</div>}

      {phase === "viewport" && (
        <>
          {/* ツールバー（左ドラッグ=WW/WL・計測/ROI 切替。中=Pan・右=Zoom は固定）。 */}
          <div style={{ ...controlRowStyle, gap: 6 }}>
            {VIDEO_PRIMARY_TOOLS.map(({ name, key }) => (
              <button
                key={key}
                type="button"
                style={activeTool === name ? toolBtnActive : toolBtn}
                onClick={() => selectPrimaryTool(name)}
                title={t(`video.tool.${key}`)}
              >
                {t(`video.tool.${key}`)}
              </button>
            ))}
            <button type="button" style={toolBtn} onClick={fitView} title={t("video.tool.fit")}>
              {t("video.tool.fit")}
            </button>
            <span style={{ color: "#889", fontSize: 11 }}>{t("video.tool.hint")}</span>
          </div>

          {/* シークバー（フレーム精度。1..totalFrames）。 */}
          <div style={{ ...controlRowStyle, gap: 10 }}>
            <button type="button" style={playBtn} onClick={togglePlay} title={t(playing ? "video.pause" : "video.play")}>
              {playing ? "⏸" : "▶"}
            </button>
            <input
              type="range"
              min={1}
              max={totalFrames}
              step={1}
              value={frame}
              onChange={(e) => seekToFrame(Number(e.target.value))}
              style={{ flex: 1, minWidth: 120 }}
            />
            <span style={{ color: "#556", fontSize: 12, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {fps > 0 ? `${fmtTime(curSec)} / ${fmtTime(totSec)}` : `${frame} / ${totalFrames}`}
            </span>
          </div>

          <div style={controlRowStyle}>
            <label style={ctrlLabel}>
              <input type="checkbox" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
              {t("video.loop")}
            </label>

            <span style={ctrlLabel}>
              {t("video.speed")}
              <select value={rate} onChange={(e) => setRate(Number(e.target.value))} style={selectStyle}>
                {SPEEDS.map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
            </span>

            <span style={ctrlLabel}>
              {t("video.frame")}
              <button type="button" style={frameBtn} title={t("video.prevFrame")} onClick={() => seekToFrame(frame - 1)}>
                ◀
              </button>
              <button type="button" style={frameBtn} title={t("video.nextFrame")} onClick={() => seekToFrame(frame + 1)}>
                ▶
              </button>
            </span>

            {meta && (
              <span style={{ color: "#889", fontSize: 12 }}>
                {meta.columns}×{meta.rows}
                {fps > 0 ? ` · ${fps.toFixed(fps % 1 === 0 ? 0 : 1)} fps` : ""}
                {totalFrames > 1 ? ` · ${totalFrames} ${t("video.frame")}` : ""}
              </span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const frameStyle: React.CSSProperties = {
  background: "#000",
  borderRadius: 8,
  overflow: "hidden",
  display: "flex",
  justifyContent: "center",
  maxWidth: 900,
};

const hostStyle: React.CSSProperties = {
  width: "100%",
  height: "60vh",
  maxHeight: 640,
  minHeight: 240,
};

const videoStyle: React.CSSProperties = {
  width: "100%",
  maxHeight: "70vh",
  display: "block",
};

const controlRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 16,
  marginTop: 8,
  maxWidth: 900,
  fontSize: 13,
  color: "#445",
};

const ctrlLabel: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6 };
const selectStyle: React.CSSProperties = { padding: "2px 4px", borderRadius: 4, border: "1px solid #cdd5de" };
const frameBtn: React.CSSProperties = {
  padding: "2px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 4,
  background: "#f4f7fa",
  cursor: "pointer",
};
const playBtn: React.CSSProperties = {
  padding: "4px 12px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#0b5cad",
  color: "#fff",
  cursor: "pointer",
  fontSize: 14,
  minWidth: 42,
};
const toolBtn: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#f4f7fa",
  color: "#334",
  cursor: "pointer",
  fontSize: 12,
};
const toolBtnActive: React.CSSProperties = {
  ...toolBtn,
  background: "#0b5cad",
  color: "#fff",
  // border は shorthand で上書き（toolBtn の border shorthand と borderColor を混在させない＝React 警告回避）。
  border: "1px solid #0b5cad",
};
const noticeStyle: React.CSSProperties = { marginTop: 10, fontSize: 13, color: "#8a6d3b" };
