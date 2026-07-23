/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import {
  RenderingEngine,
  Enums,
  getRenderingEngine,
  type VideoViewport,
} from "@cornerstonejs/core";
import { ensureCornerstoneInitialized } from "./cornerstoneSetup";
import {
  registerVideoMetadata,
  registerVideoMetadataProvider,
} from "./videoMetadataProvider";
import { fetchVideoMetadata, type Instance, type VideoMetadata } from "../api";
import { useI18n } from "../i18n/i18n";
import { LoadingSpinner } from "./LoadingSpinner";

const ENGINE_ID = "graphy-video-engine";
const VIEWPORT_ID = "graphy-video-viewport";
/** 再生位置ポーリング間隔（フレーム番号のスライダ追従）。 */
const POLL_MS = 100;

/**
 * encapsulated video（Video Photographic/Endoscopic/Microscopic）専用の独立ビューア。
 *
 * <p>2D の {@code SeriesViewer}（ZCT 5D スタック）とは分離した View（`fw/video-viewer-design.md` §2.1）。
 * 描画は Cornerstone {@link VideoViewport}（`ViewportType.VIDEO`）を自前の RenderingEngine で駆動し、
 * 再生 UI（再生/一時停止・フレームスライダ・速度）を自前で持つ。将来のサマライゼーション/クリッピングは
 * このコンポーネントに閉じて追加する（§5.6）。
 */
export function VideoViewer({ instances }: { instances: Instance[] }) {
  const { t } = useI18n();
  const elRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<RenderingEngine | null>(null);
  const vpRef = useRef<VideoViewport | null>(null);
  const pollRef = useRef<number | null>(null);

  const [activeSop, setActiveSop] = useState<string>(instances[0]?.sopInstanceUid ?? "");
  const [meta, setMeta] = useState<VideoMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsFfmpeg, setNeedsFfmpeg] = useState(false);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState(true);
  const [frame, setFrame] = useState(1);
  const [totalFrames, setTotalFrames] = useState(0);
  const [speed, setSpeed] = useState(1);

  // 再生位置（フレーム番号）をスライダへ追従させるポーリング。
  const stopPoll = () => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setNeedsFfmpeg(false);
    setLoading(true);
    setSpeed(1);

    (async () => {
      if (!activeSop || !elRef.current) return;
      try {
        const m = await fetchVideoMetadata(activeSop);
        if (cancelled) return;
        setMeta(m);
        if (!m.playable) {
          setNeedsFfmpeg(true);
          setLoading(false);
          return;
        }

        await ensureCornerstoneInitialized();
        if (cancelled) return;
        registerVideoMetadataProvider();
        const imageId = registerVideoMetadata(activeSop, m);

        let engine = getRenderingEngine(ENGINE_ID) as RenderingEngine | undefined;
        if (!engine) {
          engine = new RenderingEngine(ENGINE_ID);
        }
        engineRef.current = engine;
        // クリップ切替時は既存 viewport を再利用（同一 viewportId の再 enable を避ける）。
        if (!engine.getViewport(VIEWPORT_ID)) {
          engine.enableElement({
            viewportId: VIEWPORT_ID,
            type: Enums.ViewportType.VIDEO,
            element: elRef.current,
          });
        }
        const vp = engine.getViewport(VIEWPORT_ID) as unknown as VideoViewport;
        vpRef.current = vp;

        await vp.setVideo(imageId);
        if (cancelled) return;

        const total = m.numberOfFrames || vp.getNumberOfSlices?.() || 0;
        setTotalFrames(total);
        await vp.play();
        setPlaying(true);
        setLoading(false);

        stopPoll();
        pollRef.current = window.setInterval(() => {
          const v = vpRef.current;
          if (!v) return;
          try {
            setFrame(v.getFrameNumber());
          } catch {
            /* 再生前などは無視 */
          }
        }, POLL_MS);
      } catch (e) {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [activeSop]);

  // アンマウント時に engine を破棄（VIDEO 専用エンジンなので丸ごと）。
  useEffect(() => {
    return () => {
      stopPoll();
      try {
        engineRef.current?.destroy();
      } catch {
        /* ignore */
      }
      engineRef.current = null;
      vpRef.current = null;
    };
  }, []);

  const togglePlay = () => {
    const vp = vpRef.current;
    if (!vp) return;
    const nowPlaying = vp.togglePlayPause();
    setPlaying(nowPlaying);
  };

  const onSeek = (n: number) => {
    const vp = vpRef.current;
    if (!vp) return;
    setFrame(n);
    void vp.setFrameNumber(n);
  };

  const onSpeed = (rate: number) => {
    setSpeed(rate);
    vpRef.current?.setPlaybackRate(rate);
  };

  const step = (delta: number) => {
    if (!totalFrames) return;
    const next = Math.min(totalFrames, Math.max(1, frame + delta));
    onSeek(next);
  };

  return (
    <div style={{ marginTop: 10, maxWidth: 900 }}>
      {/* クリップ（動画）選択: シリーズに複数の動画インスタンスがある場合。 */}
      {instances.length > 1 && (
        <div style={{ marginBottom: 8, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: "#667" }}>{t("video.clip")}</span>
          {instances.map((inst, i) => (
            <button
              key={inst.sopInstanceUid}
              onClick={() => setActiveSop(inst.sopInstanceUid)}
              style={inst.sopInstanceUid === activeSop ? clipBtnActive : clipBtn}
            >
              {inst.instanceNumber ?? i + 1}
            </button>
          ))}
        </div>
      )}

      {error && <div style={{ color: "#b00020", fontSize: 13 }}>{error}</div>}
      {needsFfmpeg && (
        <div style={{ fontSize: 13, color: "#8a6d3b" }}>🎞 {t("nondicom.video.needsFfmpeg")}</div>
      )}

      {!needsFfmpeg && !error && (
        <div style={{ position: "relative" }}>
          <div
            ref={elRef}
            style={{ width: "100%", height: 480, background: "#000", borderRadius: 4 }}
            onContextMenu={(e) => e.preventDefault()}
          />
          {loading && (
            <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
              <LoadingSpinner />
            </div>
          )}
        </div>
      )}

      {/* 再生コントロール（動画専用）。 */}
      {!needsFfmpeg && !error && !loading && (
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <button onClick={togglePlay} style={ctrlBtn} title={t(playing ? "video.pause" : "video.play")}>
            {playing ? "⏸" : "▶"}
          </button>
          <button onClick={() => step(-1)} style={ctrlBtn} title={t("video.prevFrame")}>⏮</button>
          <button onClick={() => step(1)} style={ctrlBtn} title={t("video.nextFrame")}>⏭</button>
          <input
            type="range"
            min={1}
            max={Math.max(1, totalFrames)}
            value={frame}
            onChange={(e) => onSeek(Number(e.target.value))}
            style={{ flex: 1, minWidth: 160 }}
          />
          <span style={{ fontSize: 12, color: "#556", fontVariantNumeric: "tabular-nums" }}>
            {frame} / {totalFrames || "?"}
          </span>
          <label style={{ fontSize: 12, color: "#556", display: "flex", alignItems: "center", gap: 4 }}>
            {t("video.speed")}
            <select value={speed} onChange={(e) => onSpeed(Number(e.target.value))} style={{ fontSize: 12 }}>
              {[0.25, 0.5, 1, 1.5, 2].map((r) => (
                <option key={r} value={r}>{r}×</option>
              ))}
            </select>
          </label>
          {meta && (
            <span style={{ fontSize: 11, color: "#889" }}>
              {meta.columns}×{meta.rows}
              {meta.fps ? ` · ${meta.fps.toFixed(1)}fps` : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const clipBtn: React.CSSProperties = {
  padding: "2px 10px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#fff",
  color: "#334",
  cursor: "pointer",
  fontSize: 12,
};
const clipBtnActive: React.CSSProperties = { ...clipBtn, background: "#0b5cad", color: "#fff", borderColor: "#0b5cad" };
const ctrlBtn: React.CSSProperties = {
  padding: "3px 10px",
  border: "1px solid #cdd5de",
  borderRadius: 6,
  background: "#f4f7fa",
  color: "#223",
  cursor: "pointer",
  fontSize: 14,
  lineHeight: 1,
};
