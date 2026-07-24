/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { fetchVideoMetadata, videoRenderedUrl, type VideoMetadata } from "../api";

/**
 * encapsulated 動画（Video Photographic/Endoscopic/Microscopic）を 2D ビューア枠内で再生する。
 *
 * <p>P1 実装は方式 B（HTML5 {@code <video>}）。backend の {@code /api/instances/{sop}/rendered}
 * （Range 対応 {@code video/mp4}）を src にして、ネイティブコントロール＋独自の再生速度/ループ/フレーム送りを
 * 提供する。設計（fw/video-viewer-design.md）では最終的に Cornerstone VideoViewport（方式 A）へ差し替える
 * 予定で、この {@code /rendered} 供給・諸元配線はそのまま流用できる。
 *
 * <p>standalone 専用（{@code /rendered} は索引ローカルファイル前提）。web モードは呼び出し側で出し分ける。
 */
export function VideoViewer({ sopInstanceUid }: { sopInstanceUid: string }) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [meta, setMeta] = useState<VideoMetadata | null>(null);
  const [failed, setFailed] = useState(false);
  const [rate, setRate] = useState(1);
  const [loop, setLoop] = useState(true);

  const src = useMemo(() => videoRenderedUrl(sopInstanceUid), [sopInstanceUid]);

  // 諸元（fps 等）はベストエフォート。取得できなくても再生は可能。ただし transcodeRequired の場合は
  // /rendered が 415 を返すため、ネイティブ再生ではなく案内表示に切り替える。
  useEffect(() => {
    let alive = true;
    setMeta(null);
    setFailed(false);
    fetchVideoMetadata(sopInstanceUid)
      .then((m) => {
        if (alive) {
          setMeta(m);
        }
      })
      .catch(() => {
        /* メタ取得失敗は致命ではない（video 要素の error で最終判定する） */
      });
    return () => {
      alive = false;
    };
  }, [sopInstanceUid]);

  // 再生速度・ループを video 要素へ反映。
  useEffect(() => {
    const v = videoRef.current;
    if (v) {
      v.playbackRate = rate;
    }
  }, [rate, src]);

  const needsTranscode = meta?.transcodeRequired === true;

  // フレーム送り（±1 フレーム）。fps 既知のときのみ。<video> の time シークは GOP 精度なので近似。
  const fps = meta && meta.fps > 0 ? meta.fps : 0;
  const stepFrame = (dir: 1 | -1) => {
    const v = videoRef.current;
    if (!v || fps <= 0) {
      return;
    }
    v.pause();
    const dt = 1 / fps;
    v.currentTime = Math.min(
      Math.max(0, v.currentTime + dir * dt),
      Number.isFinite(v.duration) ? v.duration : v.currentTime + dir * dt,
    );
  };

  if (needsTranscode) {
    return (
      <div style={noticeStyle}>
        🎞 {t("video.needsFfmpeg")}
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div style={frameStyle}>
        {!failed ? (
          // key=src で SOP 切替時に確実に再ロード。crossOrigin 不要（同一オリジン方針）。
          <video
            key={src}
            ref={videoRef}
            src={src}
            controls
            loop={loop}
            playsInline
            preload="metadata"
            style={videoStyle}
            onError={() => setFailed(true)}
          />
        ) : (
          <div style={{ ...noticeStyle, margin: 0 }}>⚠ {t("video.error")}</div>
        )}
      </div>

      {!failed && (
        <div style={controlRowStyle}>
          <label style={ctrlLabel}>
            <input
              type="checkbox"
              checked={loop}
              onChange={(e) => setLoop(e.target.checked)}
            />
            {t("video.loop")}
          </label>

          <span style={ctrlLabel}>
            {t("video.speed")}
            <select value={rate} onChange={(e) => setRate(Number(e.target.value))} style={selectStyle}>
              {[0.25, 0.5, 1, 1.5, 2, 4].map((r) => (
                <option key={r} value={r}>
                  {r}×
                </option>
              ))}
            </select>
          </span>

          {fps > 0 && (
            <span style={ctrlLabel}>
              {t("video.frame")}
              <button type="button" style={frameBtn} title={t("video.prevFrame")} onClick={() => stepFrame(-1)}>
                ◀
              </button>
              <button type="button" style={frameBtn} title={t("video.nextFrame")} onClick={() => stepFrame(1)}>
                ▶
              </button>
            </span>
          )}

          {meta && (
            <span style={{ color: "#889", fontSize: 12 }}>
              {meta.columns}×{meta.rows}
              {fps > 0 ? ` · ${fps.toFixed(fps % 1 === 0 ? 0 : 1)} fps` : ""}
              {meta.numberOfFrames > 1 ? ` · ${meta.numberOfFrames} ${t("video.frame")}` : ""}
            </span>
          )}
        </div>
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
  fontSize: 13,
  color: "#445",
};

const ctrlLabel: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

const selectStyle: React.CSSProperties = {
  padding: "2px 4px",
  borderRadius: 4,
  border: "1px solid #cdd5de",
};

const frameBtn: React.CSSProperties = {
  padding: "2px 8px",
  border: "1px solid #cdd5de",
  borderRadius: 4,
  background: "#f4f7fa",
  cursor: "pointer",
};

const noticeStyle: React.CSSProperties = {
  marginTop: 10,
  fontSize: 13,
  color: "#8a6d3b",
};
