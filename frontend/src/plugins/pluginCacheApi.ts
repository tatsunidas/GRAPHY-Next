/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
/**
 * H68: **消えてもよい**派生データの置き場（再構成結果・特徴量・長い計算の途中経過など、作り直せるが高いもの）。
 *
 * <p>🔴 いつでも消える（上限・再起動・アプリの更新・利用者の操作）。**唯一のコピーを置かないこと**。
 * 永続させたいものは `saveStore`（H8）へ。新しい権限・同意は要らない（ローカルの `.cache` だけで外へは出ない）。
 *
 * <p>呼び出しはプラグインの id に固定する（他のプラグインの項目は見えない。これは誤接触の防止で、
 * 信頼境界ではない — host API は直接叩ける）。**例外は投げず値で返す**（`error` は理由コード:
 * `invalid-key`・`invalid-index`・`too-large`・`write-failed`・`desktop-only`・`network`）。
 * 鍵は URL に載せずヘッダで送り、ディスク上の名前にも出ない。
 */
import { apiBase } from "../apiBase";

const MAX_KEY_CHARS = 256;
const MAX_INDEX = 999_999;
const KEY_HEADER = "X-Plugin-Cache-Key";
/**
 * 画面から 1 回の fetch で送れる大きさの上限。実アプリで 40 MiB 以上を送るとウィンドウごと落ちることを確認した
 * （32 MiB までは正常）。backend の上限（既定 16 MiB）を上げた環境でも画面を守るための固定値で、超えたら送らずに `too-large`。
 */
const MAX_SEND_BYTES = 32 * 1024 * 1024;

export type CachePutOutcome = { ok: true } | { ok: false; error: string };

export interface PluginCacheCheckpoint {
  /** `index` 番目の部分を保存する（上書き）。 */
  save: (index: number, data: Uint8Array | ArrayBuffer) => Promise<CachePutOutcome>;
  /** `index` 番目の部分。無い・消えた・壊れているときは null。 */
  load: (index: number) => Promise<Uint8Array | null>;
  /** この `jobKey` の途中結果をすべて消す（完了したときに呼ぶ）。 */
  clear: () => Promise<void>;
}

export interface PluginCache {
  /** 保存した値。無い・消えたときは null。 */
  get: (key: string) => Promise<Uint8Array | null>;
  put: (key: string, data: Uint8Array | ArrayBuffer) => Promise<CachePutOutcome>;
  has: (key: string) => Promise<boolean>;
  remove: (key: string) => Promise<void>;
  /** 長い計算の途中結果。同じ `jobKey` で再実行したとき、済んだ部分を読んで続きから計算する。 */
  checkpoint: (jobKey: string) => PluginCacheCheckpoint;
}

/** 鍵の形（backend も同じ検査をする）。 */
export function validCacheKey(key: unknown): key is string {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_CHARS) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f-\u009f]/.test(key);
}

const validIndex = (i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) <= MAX_INDEX;

async function call(pluginId: string, path: string, method: string, key: string, body?: Uint8Array | ArrayBuffer): Promise<Response | null> {
  try {
    return await fetch(`${apiBase()}/api/plugins/${encodeURIComponent(pluginId)}/cache/${path}`, {
      method,
      headers: {
        [KEY_HEADER]: encodeURIComponent(key),
        ...(body ? { "Content-Type": "application/octet-stream" } : {}),
      },
      body: body as BodyInit | undefined,
    });
  } catch {
    return null;
  }
}

async function errorCode(res: Response | null): Promise<string> {
  if (!res) return "network";
  try {
    const j = await res.json();
    if (j && typeof j.error === "string") return j.error;
  } catch {
    // 本文が JSON でない
  }
  return `http-${res.status}`;
}

async function putBytes(pluginId: string, path: string, key: string, data: Uint8Array | ArrayBuffer): Promise<CachePutOutcome> {
  if (data.byteLength > MAX_SEND_BYTES) return { ok: false, error: "too-large" };
  const res = await call(pluginId, path, "PUT", key, data);
  return res?.ok ? { ok: true } : { ok: false, error: await errorCode(res) };
}

async function getBytes(pluginId: string, path: string, key: string): Promise<Uint8Array | null> {
  const res = await call(pluginId, path, "GET", key);
  if (!res?.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export function createPluginCache(pluginId: string): PluginCache {
  const item = "item";
  return {
    async get(key) {
      if (!validCacheKey(key)) return null;
      return getBytes(pluginId, item, key);
    },
    async put(key, data) {
      if (!validCacheKey(key)) return { ok: false, error: "invalid-key" };
      return putBytes(pluginId, item, key, data);
    },
    async has(key) {
      if (!validCacheKey(key)) return false;
      const res = await call(pluginId, item, "HEAD", key);
      return res?.ok === true;
    },
    async remove(key) {
      if (!validCacheKey(key)) return;
      await call(pluginId, item, "DELETE", key);
    },
    checkpoint(jobKey) {
      return {
        async save(index, data) {
          if (!validCacheKey(jobKey)) return { ok: false, error: "invalid-key" };
          if (!validIndex(index)) return { ok: false, error: "invalid-index" };
          return putBytes(pluginId, `checkpoint/${index}`, jobKey, data);
        },
        async load(index) {
          if (!validCacheKey(jobKey) || !validIndex(index)) return null;
          return getBytes(pluginId, `checkpoint/${index}`, jobKey);
        },
        async clear() {
          if (!validCacheKey(jobKey)) return;
          await call(pluginId, "checkpoint", "DELETE", jobKey);
        },
      };
    },
  };
}
