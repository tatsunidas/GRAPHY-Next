/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
import { useEffect, useRef, useState } from "react";
import { utilities as csUtils } from "@cornerstonejs/core";
import { ensureCornerstoneInitialized } from "../viewer/cornerstoneSetup";
import { imageIdForCell, type ViewerMode } from "../viewer/imageId";

/**
 * レポートのキー画像カード/ピッカー用サムネイル。Cornerstone3D の {@code loadImageToCanvas} で
 * 単発描画する（ビューア用の常設ビューポートは使わず、描画のたびに一時要素を作って自己破棄する
 * ユーティリティなので、グリッド上に何枚並んでもリソースが残らない）。
 */
export function KeyImageThumb({
  mode,
  studyUid,
  seriesUid,
  sopUid,
  frameNumber,
  width = 200,
  height = 150,
}: {
  mode: ViewerMode;
  studyUid: string;
  seriesUid: string;
  sopUid: string;
  frameNumber?: number | null;
  width?: number;
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    const canvas = canvasRef.current;
    if (!canvas) return;
    (async () => {
      try {
        await ensureCornerstoneInitialized();
        if (cancelled) return;
        const imageId = imageIdForCell(mode, sopUid, frameNumber ?? undefined, studyUid, seriesUid);
        await csUtils.loadImageToCanvas({ canvas, imageId, imageAspect: true });
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, studyUid, seriesUid, sopUid, frameNumber]);

  return (
    <div style={{ ...wrap, width, height }} title={sopUid}>
      <canvas ref={canvasRef} width={width} height={height} />
      {error && <div style={errMsg}>画像を表示できません</div>}
    </div>
  );
}

const wrap: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  overflow: "hidden",
  background: "#111",
  borderRadius: 4,
  position: "relative",
  flex: "none",
};
const errMsg: React.CSSProperties = {
  position: "absolute",
  color: "#f88",
  fontSize: 10,
  textAlign: "center",
  padding: 4,
};
