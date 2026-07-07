/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 軽量ロガー。debug は dev または localStorage("graphy.debug")="true" のときのみ出力。
// 過剰ログを避けつつ、リスク箇所・未検証箇所のトラブル追跡用に debug を残せる。
//
// さらに、System メニューの「Log」ビューア用にインメモリのリングバッファを持つ。
// console.* をラップして「全てのログ」（本アプリ・サードパーティ・未捕捉例外）を
// 収集し、Log ビューアが購読して表示する。record は console を呼ばないので再帰しない。

function debugEnabled(): boolean {
  try {
    if (localStorage.getItem("graphy.debug") === "true") return true;
  } catch {
    // ignore
  }
  return Boolean(import.meta.env?.DEV);
}

const PREFIX = "[graphy]";

// ── ログビューア用リングバッファ ───────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** 単調増加のシーケンス番号（React の key・並び安定用）。 */
  seq: number;
  /** epoch ミリ秒。 */
  ts: number;
  level: LogLevel;
  text: string;
}

const BUFFER_MAX = 3000;
const buffer: LogEntry[] = [];
let seq = 0;

type Listener = (entry: LogEntry) => void;
const listeners = new Set<Listener>();

/** 任意の引数配列を 1 行の文字列へ整形する（Error はスタック優先）。 */
function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
      if (a === undefined) return "undefined";
      if (a === null) return "null";
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** 1 行をバッファへ積み、購読者へ通知する（console は呼ばないので再帰しない）。 */
function push(level: LogLevel, ts: number, text: string): void {
  const entry: LogEntry = { seq: seq++, ts, level, text };
  buffer.push(entry);
  if (buffer.length > BUFFER_MAX) buffer.splice(0, buffer.length - BUFFER_MAX);
  for (const l of listeners) {
    try {
      l(entry);
    } catch {
      // リスナ例外はログ収集を妨げない
    }
  }
}

function record(level: LogLevel, args: unknown[]): void {
  push(level, Date.now(), fmt(args));
}

/**
 * 外部（バックエンド等）由来のログを、発生時刻（ts）付きで取り込む。console 経由ではないため
 * 二重記録・再帰は起きない。backendLog.ts がサーバログのポーリング結果をここへ流す。
 */
export function ingestExternal(level: LogLevel, ts: number, text: string): void {
  push(level, ts, text);
}

/** 現在バッファに溜まっている全ログ（古い→新しい順）のスナップショット。 */
export function getLogEntries(): LogEntry[] {
  return buffer.slice();
}

/** 新規ログを購読する。戻り値の関数で解除。 */
export function subscribeLog(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** バッファを空にする（Log ビューアの Clear）。購読者へは seq=-1 の番兵で通知。 */
export function clearLogEntries(): void {
  buffer.length = 0;
  for (const l of listeners) {
    try {
      l({ seq: -1, ts: Date.now(), level: "info", text: "" });
    } catch {
      // ignore
    }
  }
}

// ── console 捕捉（全ログ収集）───────────────────────────────────

let captureInstalled = false;

/** console.* をラップしてバッファへ記録する（多重適用ガード付き）。 */
function installConsoleCapture(): void {
  if (captureInstalled) return;
  captureInstalled = true;

  const levels: LogLevel[] = ["debug", "info", "warn", "error"];
  const target = console as unknown as Record<string, (...a: unknown[]) => void>;
  for (const level of levels) {
    const orig = target[level] ? target[level].bind(console) : () => {};
    target[level] = (...args: unknown[]) => {
      record(level, args);
      orig(...args);
    };
  }
  // console.log は info 相当として収集（多くのライブラリが log を使う）。
  const origLog = target.log ? target.log.bind(console) : () => {};
  target.log = (...args: unknown[]) => {
    record("info", args);
    origLog(...args);
  };

  if (typeof window !== "undefined") {
    window.addEventListener("error", (e) => {
      const msg = e.message || String((e as ErrorEvent).error ?? "error");
      const at = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
      record("error", [`Uncaught: ${msg}${at}`]);
    });
    window.addEventListener("unhandledrejection", (e) => {
      record("error", ["Unhandled promise rejection:", (e as PromiseRejectionEvent).reason]);
    });
  }
}

installConsoleCapture();

// ── 公開ロガー ────────────────────────────────────────────────
// console はラップ済みなので、以下は console 経由で自動的にバッファへ記録される。

export const log = {
  debug: (...args: unknown[]) => {
    if (debugEnabled()) console.debug(PREFIX, ...args);
  },
  info: (...args: unknown[]) => console.info(PREFIX, ...args),
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
};
