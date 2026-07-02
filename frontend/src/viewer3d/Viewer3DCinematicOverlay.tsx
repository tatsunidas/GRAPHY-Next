/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * Cinematic v2（パストレース）オーバーレイ（`fw/3d-viewer-design.md` §6.4 v2 / P7）。
 *
 * pure-vtk ビューポートの上に **独立した WebGL2 canvas** を重ね、`cinematicPathTracer` エンジンで
 * プログレッシブ・パストレースを表示する。vtk のカメラ（回転/Pan/Zoom は下の vtk が処理）を毎フレーム読み取り、
 * 変化したら蓄積をリセット、静止中は指定フレーム数まで蓄積して収束させる。
 *
 * ボリューム/LUT/W-L は vtk ビュー（`getSceneParts`/`getLut256`）から取得＝表示と同じ実空間・単一入口の輝度校正。
 * canvas は不透明（背景黒）でボリュームを置き換え表示する（メッシュ/ROI の重畳は非対応＝ボリュームのみ）。
 */
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import type { VtkVolumeView } from "../viewer/vtkVolumeView";
import { geomFromImageData } from "../viewer/labelVolume";
import { inverseViewProj } from "./measure3d";
import {
  createCinematicPathTracer,
  defaultPathTraceParams,
  type CinematicEngine,
} from "../viewer/cinematicPathTracer";

const MAX_FRAMES = 400; // 収束目安（これ以上は蓄積を止めて GPU を休める）

export function Viewer3DCinematicOverlay({
  view,
  active,
}: {
  view: VtkVolumeView;
  active: boolean;
}) {
  const { t } = useI18n();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string>("");
  const [frames, setFrames] = useState(0);

  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // ビューポートの実サイズに canvas を合わせる。
    const parent = canvas.parentElement;
    const rect = parent?.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect?.width ?? canvas.clientWidth));
    const h = Math.max(1, Math.floor(rect?.height ?? canvas.clientHeight));
    canvas.width = w;
    canvas.height = h;

    const parts = view.getSceneParts();
    const geom = geomFromImageData(parts.imageData);
    if (!geom) {
      setError(t("cine2.error"));
      return;
    }
    const engine: CinematicEngine | null = createCinematicPathTracer(
      canvas,
      parts.imageData,
      geom,
      defaultPathTraceParams(),
    );
    if (!engine) {
      setError(t("cine2.unsupported"));
      return;
    }
    setError("");
    engine.setLut(view.getLut256());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renderer: any = parts.renderer;
    let raf = 0;
    let lastFingerprint = "";
    let lastW = w;
    let lastH = h;

    const cameraFingerprint = (): string => {
      try {
        const cam = renderer.getActiveCamera();
        const p = cam.getPosition();
        const f = cam.getFocalPoint();
        const u = cam.getViewUp();
        const s = cam.getParallelScale();
        return [...p, ...f, ...u, s].map((x: number) => x.toFixed(3)).join(",");
      } catch {
        return "";
      }
    };

    const tick = () => {
      // リサイズ追従。
      const r = parent?.getBoundingClientRect();
      const cw = Math.max(1, Math.floor(r?.width ?? lastW));
      const ch = Math.max(1, Math.floor(r?.height ?? lastH));
      if (cw !== lastW || ch !== lastH) {
        engine.resize(cw, ch);
        lastW = cw;
        lastH = ch;
        lastFingerprint = ""; // リサイズで再取得
      }

      // カメラ変化検出 → リセット＋再取得（LUT も取り直す：W/L 変更に追従）。
      const fp = cameraFingerprint();
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        const ivp = inverseViewProj(renderer, lastW, lastH);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cam: any = renderer.getActiveCamera();
        if (ivp) {
          engine.setCamera(ivp, cam.getPosition() as [number, number, number]);
          engine.setLut(view.getLut256());
          engine.reset();
        }
      }

      if (engine.getFrameCount() < MAX_FRAMES) {
        engine.renderFrame();
        setFrames(engine.getFrameCount());
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      engine.dispose();
    };
  }, [active, view, t]);

  if (!active) return null;

  return (
    <div style={root}>
      <canvas ref={canvasRef} style={canvasEl} />
      <div style={badge}>
        {error
          ? error
          : t("cine2.progress", { n: String(Math.min(frames, MAX_FRAMES)), max: String(MAX_FRAMES) })}
      </div>
    </div>
  );
}

const root: React.CSSProperties = { position: "absolute", inset: 0, zIndex: 12, pointerEvents: "none" };
const canvasEl: React.CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", background: "#000" };
const badge: React.CSSProperties = {
  position: "absolute",
  bottom: 10,
  left: 10,
  padding: "3px 8px",
  background: "rgba(20,24,28,0.8)",
  border: "1px solid #2c343b",
  borderRadius: 5,
  fontSize: 11,
  color: "#c7d0d8",
};
