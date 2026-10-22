/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 動画から等間隔にコマを取り出す（<video>＋canvas。CSP の media-src blob: の範囲で動き、ffmpeg は使わない）。音声は扱わない。
import { AttachError, VIDEO_FRAME_LONG_EDGE, VIDEO_MAX_FRAMES } from "./limits";

export interface VideoFrames {
  duration: number;
  width: number;
  height: number;
  /** JPEG の base64（data: 接頭辞なし）と、そのコマの時刻（秒）。 */
  frames: Array<{ base64: string; mimeType: "image/jpeg"; time: number }>;
}

/** 区間を等分した中央の時刻。先頭・末尾の黒コマを避ける。 */
export function frameTimes(duration: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => ((i + 0.5) * duration) / n);
}

function once(el: HTMLVideoElement, ok: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      el.removeEventListener(ok, onOk);
      el.removeEventListener("error", onErr);
    };
    const onOk = () => (done(), resolve());
    const onErr = () => (done(), reject(new AttachError("unsupported")));
    el.addEventListener(ok, onOk);
    el.addEventListener("error", onErr);
  });
}

export async function extractVideoFrames(file: File): Promise<VideoFrames> {
  const url = URL.createObjectURL(file);
  const v = document.createElement("video");
  v.muted = true;
  v.preload = "auto";
  try {
    const meta = once(v, "loadedmetadata");
    v.src = url;
    await meta;
    // MediaRecorder 由来の webm は長さが Infinity で出る。末尾へシークさせると確定する。
    if (v.duration === Infinity) {
      const fixed = once(v, "durationchange");
      v.currentTime = 1e101;
      await Promise.race([fixed, new Promise((r) => setTimeout(r, 3000))]);
      v.currentTime = 0;
    }
    const duration = v.duration;
    if (!Number.isFinite(duration) || duration <= 0 || !v.videoWidth) throw new AttachError("unsupported");
    const scale = Math.min(1, VIDEO_FRAME_LONG_EDGE / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(1, Math.round(v.videoWidth * scale));
    const h = Math.max(1, Math.round(v.videoHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new AttachError("unsupported");
    const frames: VideoFrames["frames"] = [];
    for (const t of frameTimes(duration, VIDEO_MAX_FRAMES)) {
      const seeked = once(v, "seeked");
      v.currentTime = t;
      await seeked;
      ctx.drawImage(v, 0, 0, w, h);
      const url2 = canvas.toDataURL("image/jpeg", 0.8);
      frames.push({ base64: url2.slice(url2.indexOf(",") + 1), mimeType: "image/jpeg", time: t });
    }
    return { duration, width: v.videoWidth, height: v.videoHeight, frames };
  } finally {
    v.removeAttribute("src");
    v.load();
    URL.revokeObjectURL(url);
  }
}
