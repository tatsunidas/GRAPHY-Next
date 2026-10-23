/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * アシスタントの音声入力（マイク → 文字起こし → 入力欄）の状態機械。
 *
 * 🔴 結果は**入力欄へ入れるだけで、自動送信しない**（聞き間違いのまま患者のデータに触る操作へ進ませない）。
 * 🔴 送信先は録音の前に main から引き直す（設定が変わっていても、表示と実際の宛先がずれない）。
 *    クラウド宛ては会話ごとの最初の録音前に確認を出す。録音はメモリ上だけで、保存しない。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { desktop, type AiResolveResult } from "../../desktopBridge";
import { appendText, MAX_RECORD_SEC, needsConfirm, outcomeOf, readinessOf, type VoiceReadiness } from "./voiceFlow";
import { startRecorder, VoiceError, type Recorder } from "./recorder";
import { SILENCE_PEAK } from "./wav";

export type VoicePhase = "idle" | "confirm" | "recording" | "transcribing";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export function useVoiceInput(opts: { t: Translate; setInput: (f: (cur: string) => string) => void; setNote: (n: string | null) => void }) {
  const { t, setInput, setNote } = opts;
  const bridge = desktop();
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [resolved, setResolved] = useState<AiResolveResult | null>(null);
  const confirmedRef = useRef(false);
  const recRef = useRef<Recorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const ignoreRef = useRef(false);

  const refresh = useCallback(async () => {
    const r = await bridge?.aiResolve?.("speech-to-text");
    setResolved(r ?? null);
    return r ?? null;
  }, [bridge]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    recRef.current?.cancel();
  }, []);

  const readiness: VoiceReadiness = readinessOf(resolved);
  const available = !!bridge?.aiTranscribe;

  const finish = useCallback(async () => {
    const rec = recRef.current;
    if (!rec) return;
    recRef.current = null;
    if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
    setPhase("transcribing");
    ignoreRef.current = false;
    try {
      const audio = await rec.stop();
      if (audio.peak <= SILENCE_PEAK) { setNote(t("assistant.voice.err.empty")); return; }
      const res = await bridge!.aiTranscribe!({ audio: { base64: audio.base64, mimeType: audio.mimeType } });
      if (ignoreRef.current) return;
      const out = outcomeOf(res);
      if (out.kind === "text") {
        setInput((cur) => appendText(cur, out.text));
        setNote(out.degraded ? t("assistant.voice.degraded") : null);
      } else {
        setNote(out.code === "empty" ? t("assistant.voice.err.empty") : t("assistant.voice.err.failed", { error: out.error }));
      }
    } catch (e) {
      const code = e instanceof VoiceError ? e.code : "failed";
      setNote(code === "decode" ? t("assistant.voice.err.decode") : t("assistant.voice.err.failed", { error: String(e) }));
    } finally {
      setPhase("idle");
      setElapsed(0);
    }
  }, [bridge, setInput, setNote, t]);

  const begin = useCallback(async () => {
    setNote(null);
    try {
      const access = await bridge?.assistantMicAccess?.();
      if (access && !access.ok) { setNote(t("assistant.voice.err.denied")); return; }
      recRef.current = await startRecorder();
    } catch (e) {
      const code = e instanceof VoiceError ? e.code : "failed";
      setNote(code === "denied" ? t("assistant.voice.err.denied")
        : code === "noDevice" ? t("assistant.voice.err.noDevice")
        : code === "busy" ? t("assistant.voice.err.busy")
        : t("assistant.voice.err.failed", { error: String(e) }));
      setPhase("idle");
      return;
    }
    setPhase("recording");
    const t0 = Date.now();
    setElapsed(0);
    timerRef.current = window.setInterval(() => {
      const sec = Math.floor((Date.now() - t0) / 1000);
      setElapsed(sec);
      if (sec >= MAX_RECORD_SEC) {
        setNote(t("assistant.voice.maxReached", { max: MAX_RECORD_SEC }));
        void finish();
      }
    }, 250);
  }, [bridge, finish, setNote, t]);

  /** マイクボタン。待機中なら録音を始め（必要なら確認を挟み）、録音中なら止めて文字にする。 */
  const toggle = useCallback(async () => {
    if (phase === "recording") { await finish(); return; }
    if (phase !== "idle") return;
    const r = readinessOf(await refresh());
    if (r.kind === "noProvider") { setNote(t("assistant.voice.noProvider")); return; }
    if (r.kind === "noKey") { setNote(t("assistant.voice.notReady", { label: r.label })); return; }
    if (needsConfirm(r, confirmedRef.current)) { setPhase("confirm"); return; }
    await begin();
  }, [begin, finish, phase, refresh, setNote, t]);

  const answerConfirm = useCallback(async (yes: boolean) => {
    if (phase !== "confirm") return;
    if (!yes) { setPhase("idle"); return; }
    confirmedRef.current = true;
    setPhase("idle");
    await begin();
  }, [begin, phase]);

  /** 録音を捨てる／文字起こしの結果を無視する。 */
  const cancel = useCallback(() => {
    if (phase === "recording") {
      recRef.current?.cancel();
      recRef.current = null;
      if (timerRef.current !== null) { window.clearInterval(timerRef.current); timerRef.current = null; }
      setPhase("idle");
      setElapsed(0);
    } else if (phase === "transcribing") {
      ignoreRef.current = true;
      setPhase("idle");
    }
  }, [phase]);

  return { available, phase, elapsed, readiness, toggle, answerConfirm, cancel };
}
