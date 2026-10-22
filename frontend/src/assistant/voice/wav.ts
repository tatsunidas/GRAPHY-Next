/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 録音した音声を、文字起こしに渡す形（16 kHz・モノラル・16 bit の WAV）にする純関数。
 *
 * 🔑 16 kHz は音声認識モデルの入力の標準で、これより高くしてもモデル側で落とされる。
 *    mono 16 bit 16 kHz の WAV は 1 分で約 1.9 MB——送る量が小さく、ブラウザの圧縮形式（webm/opus）の
 *    違いを相手が気にしなくて済む。
 * 🔴 ここは DOM に依存しない（AudioContext の復号は recorder.ts）。vitest で正例・負例を確かめる。
 */

export const TARGET_RATE = 16000;
/** 無音とみなす最大振幅。16 bit の量子化雑音（数 LSB）と同じ水準——これ以下は録れていないのと同じ。 */
export const SILENCE_PEAK = 4 / 32768;

/** 複数チャンネルを平均してモノラルにする。空なら空。 */
export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const c of channels) sum += c[i];
    out[i] = sum / channels.length;
  }
  return out;
}

/**
 * サンプルレート変換。ダウンサンプルは区間平均（折り返し雑音を抑える簡易なローパス）、
 * アップサンプルは線形補間。同じレートならそのまま返す。
 */
export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (!(fromRate > 0) || !(toRate > 0)) throw new Error("invalid-rate");
  if (fromRate === toRate || input.length === 0) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  if (ratio > 1) {
    for (let i = 0; i < outLen; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let sum = 0;
      for (let j = a; j < b; j++) sum += input[j];
      out[i] = sum / (b - a);
    }
  } else {
    for (let i = 0; i < outLen; i++) {
      const pos = i * ratio;
      const a = Math.floor(pos);
      const b = Math.min(input.length - 1, a + 1);
      const f = pos - a;
      out[i] = input[a] * (1 - f) + input[b] * f;
    }
  }
  return out;
}

/** 最大の絶対値。 */
export function peakOf(samples: Float32Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > p) p = v;
  }
  return p;
}

/** 16 bit PCM の WAV にする。範囲外は丸める。 */
export function encodeWav16(samples: Float32Array, rate: number): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  str(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true); str(8, "WAVE");
  str(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, "data"); v.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return new Uint8Array(buf);
}

/** Uint8Array → base64（大きい配列で引数が溢れないよう分割する）。 */
export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(bin);
}

export type PreparedAudio = { base64: string; mimeType: "audio/wav"; seconds: number; peak: number };

/** 復号済みのチャンネル → 送る WAV。 */
export function prepareAudio(channels: Float32Array[], sampleRate: number): PreparedAudio {
  const mono = resample(mixToMono(channels), sampleRate, TARGET_RATE);
  const wav = encodeWav16(mono, TARGET_RATE);
  return { base64: toBase64(wav), mimeType: "audio/wav", seconds: mono.length / TARGET_RATE, peak: peakOf(mono) };
}
