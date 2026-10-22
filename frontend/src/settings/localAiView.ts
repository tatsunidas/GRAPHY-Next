/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * 環境設定 ＞ 外部 AI ＞ ローカル AI の、画面に出す状態を決める純関数。設計: `fw/ai-routing-design.md` §18
 *
 * 🔑 導入の進み具合は main からのイベントで来る。画面の分岐をここへ寄せ、vitest で正例・負例を確かめる。
 */
import type { AiLocalEvent, AiLocalStatus } from "../desktopBridge";

export type LocalAiPhase = "unsupported" | "notInstalled" | "installing" | "ready" | "running";

export interface LocalAiProgress {
  phase: "runtime-download" | "runtime-extract" | "model-download" | "done";
  received?: number;
  total?: number;
}

/** 状態から画面の段階を決める。導入中（main が busy）は他より優先する。 */
export function phaseOf(s: AiLocalStatus | null, progress: LocalAiProgress | null): LocalAiPhase {
  if (!s || !s.supported) return "unsupported";
  if (s.busy || (progress && progress.phase !== "done")) return "installing";
  if (s.runtime?.installed && s.model?.installed) return s.running ? "running" : "ready";
  return "notInstalled";
}

/** 進捗を 0〜100 の整数に。総量が分からない・0 のときは null（嘘のパーセントを出さない）。 */
export function percentOf(p: LocalAiProgress | null): number | null {
  if (!p || p.received == null || !p.total || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.floor((p.received / p.total) * 100)));
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

/** イベントを進捗に畳む。`done` は進捗を消す合図（null）。他のイベントは進捗を変えない。 */
export function reduceProgress(prev: LocalAiProgress | null, ev: AiLocalEvent): LocalAiProgress | null {
  if (ev.type !== "progress") return prev;
  if (ev.phase === "done") return null;
  return { phase: ev.phase, received: ev.received, total: ev.total };
}

/** main が返すエラーコード → i18n キー。知らないコードは汎用の文にする（コードそのものは詳細として別に出す）。 */
export function errorKey(code: string): string {
  const known: Record<string, string> = {
    canceled: "settings.ai.local.err.canceled",
    "sha256-mismatch": "settings.ai.local.err.sha256",
    "size-mismatch": "settings.ai.local.err.sha256",
    "unknown-file": "settings.ai.local.err.unknownFile",
    "not-gguf": "settings.ai.local.err.notGguf",
    "unsupported-platform": "settings.ai.local.err.unsupported",
    "url-not-allowed": "settings.ai.local.err.network",
    "redirect-not-allowed": "settings.ai.local.err.network",
    "too-many-redirects": "settings.ai.local.err.network",
    incomplete: "settings.ai.local.err.network",
    busy: "settings.ai.local.err.busy",
  };
  if (known[code]) return known[code];
  if (code.startsWith("network:") || code.startsWith("http-")) return "settings.ai.local.err.network";
  return "settings.ai.local.err.generic";
}
