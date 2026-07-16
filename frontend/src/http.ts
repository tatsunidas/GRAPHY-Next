/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// API 共通の fetch ラッパ。backend の構造化エラー({status,error,message,path})を解析し、
// 失敗は必ずログに残す。各 api モジュールはこれを使う。
import { apiBase } from "./apiBase";
import { log } from "./log";

// バックエンド側（web モードの PACS 中継等）が応答なしのままハングすると、タイムアウトが無い fetch は
// 無期限に pending になり、呼び出し元の busy/loading フラグが finally まで永久に到達できず、
// 関連ボタンが恒久的にグレーアウトしたままになる（実機報告: 3D wand マスク編集後の SEG↓ で発生）。
// それを避けるため、明示的な上限時間で必ず reject させる。
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000; // SEG 等の大きいペイロード転送も許容する余裕を持たせる。

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${apiBase()}${path}`;
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: timeoutController.signal });
  } catch (e) {
    // ネットワーク到達不可、またはタイムアウト（AbortError）。
    log.error("network error", init?.method ?? "GET", url, e);
    const timedOut = e instanceof DOMException && e.name === "AbortError";
    throw new Error(timedOut ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s: ${url}` : `network error: ${String(e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const message = await extractErrorMessage(res);
    log.warn("api error", init?.method ?? "GET", url, res.status, message);
    throw new Error(message);
  }
  // 204 No Content、および Spring の void ハンドラ（200 だが本文が空）の両方に対応する。
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** backend の {message} を優先し、無ければ HTTP ステータスを返す。 */
async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) {
      const body = await res.json();
      if (body && typeof body.message === "string" && body.message) return body.message;
      if (body && typeof body.error === "string" && body.error) return body.error;
    }
  } catch {
    // パース失敗時はステータスへフォールバック
  }
  return `HTTP ${res.status}`;
}

export const httpGet = <T>(path: string): Promise<T> => request<T>(path);

export const httpSend = <T = void>(path: string, method: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
