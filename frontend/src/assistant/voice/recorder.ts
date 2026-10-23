/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * マイクの録音（getUserMedia → MediaRecorder → decodeAudioData → 16 kHz mono WAV）。
 *
 * 🔴 録音は**メモリ上だけ**。ファイルにも localStorage にも置かない。終了・取消・失敗のどの経路でも
 *    マイクのトラックを止める（止め忘れるとマイク使用中の表示が消えず、他のアプリも使えない）。
 * 🔑 CSP は変更不要（getUserMedia / AudioContext は CSP の対象外）。許可は main の mediaPermission.js が
 *    アシスタント窓の音声だけに絞っている。
 */
import { prepareAudio, type PreparedAudio } from "./wav";

export type VoiceErrorCode = "denied" | "noDevice" | "busy" | "decode" | "failed";

export class VoiceError extends Error {
  constructor(readonly code: VoiceErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface Recorder {
  /** 録音を止めて、送る WAV にする。 */
  stop(): Promise<PreparedAudio>;
  /** 録音を捨てる。 */
  cancel(): void;
}

function mapMediaError(e: unknown): VoiceError {
  const name = e && typeof e === "object" && "name" in e ? String((e as { name: unknown }).name) : "";
  if (name === "NotAllowedError" || name === "SecurityError") return new VoiceError("denied");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new VoiceError("noDevice");
  if (name === "NotReadableError" || name === "AbortError") return new VoiceError("busy");
  return new VoiceError("failed", name || String(e));
}

function pickMime(): string | undefined {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"]) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

/** Blob（webm/opus 等）→ 16 kHz mono WAV。 */
export async function blobToAudio(blob: Blob): Promise<PreparedAudio> {
  const Ctx: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    return prepareAudio(channels, decoded.sampleRate);
  } catch (e) {
    throw new VoiceError("decode", String(e));
  } finally {
    void ctx.close();
  }
}

export async function startRecorder(): Promise<Recorder> {
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    throw mapMediaError(e);
  }
  const release = () => stream.getTracks().forEach((t) => t.stop());
  let rec: MediaRecorder;
  try {
    const mime = pickMime();
    rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (e) {
    release();
    throw new VoiceError("failed", String(e));
  }
  const chunks: Blob[] = [];
  rec.ondataavailable = (ev) => { if (ev.data.size > 0) chunks.push(ev.data); };
  const stopped = new Promise<void>((resolve) => { rec.onstop = () => resolve(); });
  rec.start();
  let done = false;
  return {
    async stop() {
      if (done) throw new VoiceError("failed", "already-stopped");
      done = true;
      if (rec.state !== "inactive") rec.stop();
      await stopped;
      release();
      return blobToAudio(new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
    },
    cancel() {
      if (done) return;
      done = true;
      rec.ondataavailable = null;
      rec.onstop = null;
      if (rec.state !== "inactive") rec.stop();
      release();
      chunks.length = 0;
    },
  };
}
