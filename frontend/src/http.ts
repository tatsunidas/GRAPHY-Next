/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// API 共通の fetch ラッパ。backend の構造化エラー({status,error,message,path})を解析し、
// 失敗は必ずログに残す。各 api モジュールはこれを使う。
import { apiBase } from "./apiBase";
import { log } from "./log";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${apiBase()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (e) {
    // ネットワーク到達不可など（バックエンド未起動が疑われる）。
    log.error("network error", init?.method ?? "GET", url, e);
    throw new Error(`network error: ${String(e)}`);
  }
  if (!res.ok) {
    const message = await extractErrorMessage(res);
    log.warn("api error", init?.method ?? "GET", url, res.status, message);
    throw new Error(message);
  }
  // 204 No Content
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
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
