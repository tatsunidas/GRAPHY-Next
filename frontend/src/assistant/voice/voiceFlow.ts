/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 音声入力の「送る前の判断」と「結果の振り分け」を決める純関数。画面（useVoiceInput）から分けて vitest で試す。
 */
import type { AiResolveResult, AiTranscribeResult } from "../../desktopBridge";

/** 最長の録音(秒)。暫定——実測で見直す。16 kHz mono WAV で約 1.9 MB。 */
export const MAX_RECORD_SEC = 60;

export type VoiceReadiness =
  | { kind: "ready"; local: boolean; host: string; plaintext: boolean }
  | { kind: "noProvider" }
  | { kind: "noKey"; label: string };

/** 録音を始めてよいか。宛先は main が決めた `aiResolve` の結果をそのまま使う。 */
export function readinessOf(r: AiResolveResult | null | undefined): VoiceReadiness {
  if (!r || !r.ok) return { kind: "noProvider" };
  if (!r.hasApiKey) return { kind: "noKey", label: r.label };
  return { kind: "ready", local: r.local === true, host: r.endpointHost, plaintext: r.plaintext === true };
}

/** 録音の前に確認を出すか。ローカルでは出さない。クラウド宛ては会話ごとの最初の 1 回。 */
export function needsConfirm(ready: VoiceReadiness, alreadyConfirmed: boolean): boolean {
  return ready.kind === "ready" && !ready.local && !alreadyConfirmed;
}

export type VoiceOutcome =
  | { kind: "text"; text: string; degraded: boolean }
  | { kind: "error"; code: "empty" | "failed"; error: string };

/** main の結果 → 画面の扱い。空の結果は成功にしない。 */
export function outcomeOf(res: AiTranscribeResult): VoiceOutcome {
  if (res.ok) {
    const text = res.text.trim();
    return text ? { kind: "text", text, degraded: res.degraded === true } : { kind: "error", code: "empty", error: "empty-transcript" };
  }
  return res.error === "empty-transcript" ? { kind: "error", code: "empty", error: res.error } : { kind: "error", code: "failed", error: res.error };
}

/** 入力欄の末尾に追記する。既存の文との間は空白 1 つ（改行で終わっていればそのまま）。 */
export function appendText(current: string, add: string): string {
  if (!current) return add;
  return /\s$/.test(current) ? current + add : `${current} ${add}`;
}
