/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// バックエンド（Spring Boot）のログを差分ポーリングして、フロントの Log ビューア（log.ts の
// リングバッファ）へ取り込む。DIMSE（C-FIND/C-MOVE/C-STORE 等）や DICOMweb のサーバ側
// エラーが、System＞ログ の画面から参照できるようになる。
//
// ポーリングは Log ビューアを開いている間だけ動かす（startBackendLogPolling の参照カウント）。
// lastSeq はモジュールに保持し、開閉をまたいでも重複取得しない。取得失敗（バックエンド未到達等）は
// 黙って無視し、log.ts を汚さない（httpGet は失敗を warn するため、ここでは素の fetch を使う）。

import { apiBase } from "../apiBase";
import { ingestExternal, type LogLevel } from "../log";

interface ServerEntry {
  seq: number;
  ts: number;
  level: string;
  logger: string;
  message: string;
}
interface LogsResp {
  entries: ServerEntry[];
  lastSeq: number;
}

let lastSeq = -1; // 既取得の最大 seq（open/close をまたいで保持）
let timer: number | null = null;
let refCount = 0;

function mapLevel(level: string): LogLevel {
  switch (level.toUpperCase()) {
    case "ERROR":
      return "error";
    case "WARN":
      return "warn";
    case "TRACE":
    case "DEBUG":
      return "debug";
    default:
      return "info"; // INFO ほか
  }
}

async function poll(): Promise<void> {
  try {
    const res = await fetch(`${apiBase()}/api/system/logs?afterSeq=${lastSeq}&limit=1000`);
    if (!res.ok) return;
    const data = (await res.json()) as LogsResp;
    for (const e of data.entries) {
      // «server» 接頭辞＋短縮ロガー名で、フロント由来ログと出所を区別できるようにする。
      ingestExternal(mapLevel(e.level), e.ts, `«server» ${e.logger}: ${e.message}`);
    }
    if (typeof data.lastSeq === "number" && data.lastSeq > lastSeq) {
      lastSeq = data.lastSeq;
    }
  } catch {
    // バックエンド未到達などは無視（次回ポーリングで復帰）
  }
}

/**
 * サーバログのポーリングを開始する（多重呼び出しは参照カウントで集約）。戻り値の関数で停止。
 * 開始直後に 1 回即時取得して、開いた時点までの履歴をバックフィルする。
 */
export function startBackendLogPolling(): () => void {
  refCount++;
  if (timer == null) {
    void poll();
    timer = window.setInterval(() => void poll(), 2000);
  }
  return () => {
    refCount = Math.max(0, refCount - 1);
    if (refCount === 0 && timer != null) {
      window.clearInterval(timer);
      timer = null;
    }
  };
}
