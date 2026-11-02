/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * `src/http.ts` の Node 用の代役（コマンドラインの束ねで、この 1 モジュールだけを差し替える）。
 * 本物は `window`（`apiBase`）・`log`（localStorage・console のラップ）・`DOMException` に依存し、Node では動かない。
 * API の形（`httpGet`・`httpSend`・`HttpError`）は本物と同じ。ベース URL は `setApiBase` で設定する。
 */
export class HttpError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

let base = "";

export const setApiBase = (url: string): void => {
  base = url.replace(/\/+$/, "");
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${base}${path}`, init);
  if (!res.ok) throw new HttpError((await res.text()) || res.statusText, res.status);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const httpGet = <T>(path: string): Promise<T> => request<T>(path);

export const httpSend = <T = void>(path: string, method: string, body?: unknown): Promise<T> =>
  request<T>(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
