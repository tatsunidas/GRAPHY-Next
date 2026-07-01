/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグインの読み込み（両モード共通）。
// 起動時に GET /api/plugins でマニフェストを取得し、クリック時に UI バンドルを
// 動的 import して activate(host) を呼ぶ。設計: fw/plugin-architecture.md。
import { useEffect, useState } from "react";
import { httpGet, httpSend } from "../http";
import { apiBase } from "../apiBase";
import { log } from "../log";
import type { PluginHost, PluginManifest, PluginModule, PluginSurface } from "./pluginTypes";
import { DEMO_MODULES, MOCK_ENABLED, MOCK_MANIFESTS } from "./mockPlugins";

let manifestsCache: Promise<PluginManifest[]> | null = null;

/** 起動時に一度だけ /api/plugins を取得し以後キャッシュ（両モード共通）。 */
export function loadPluginManifests(): Promise<PluginManifest[]> {
  if (!manifestsCache) manifestsCache = fetchManifests();
  return manifestsCache;
}

async function fetchManifests(): Promise<PluginManifest[]> {
  try {
    const list = await httpGet<PluginManifest[]>("/api/plugins");
    return Array.isArray(list) ? list : [];
  } catch (e) {
    // backend 未実装 or 到達不可。デモが有効ならフォールバック表示。
    log.warn("plugins: /api/plugins unavailable", e);
    return MOCK_ENABLED ? MOCK_MANIFESTS : [];
  }
}

const moduleCache = new Map<string, Promise<PluginModule>>();

function resolveModule(m: PluginManifest): Promise<PluginModule> {
  const cached = moduleCache.get(m.id);
  if (cached) return cached;
  const p = importModule(m);
  moduleCache.set(m.id, p);
  return p;
}

async function importModule(m: PluginManifest): Promise<PluginModule> {
  const url = m.frontend?.bundleUrl ?? "";
  if (!url) {
    // bundleUrl 未指定 = デモ用インラインモジュール。
    const demo = DEMO_MODULES[m.id];
    if (demo) return demo;
    throw new Error(`plugin '${m.id}': frontend.bundleUrl が未指定です`);
  }
  const abs = /^https?:\/\//.test(url) ? url : `${apiBase()}${url}`;
  const mod = await import(/* @vite-ignore */ abs);
  const resolved = (mod.default ?? mod) as PluginModule;
  if (typeof resolved.activate !== "function") {
    throw new Error(`plugin '${m.id}': activate() を公開していません`);
  }
  return resolved;
}

/** メニュー項目クリック時: UI バンドルを動的 import して activate(host) を呼ぶ。 */
export async function launchPlugin(m: PluginManifest, host: PluginHost): Promise<void> {
  const mod = await resolveModule(m);
  await mod.activate(host);
}

/** backend 面の実行: POST /api/plugins/{id}/run。 */
export const runPluginBackend = (id: string, payload?: unknown): Promise<unknown> =>
  httpSend<unknown>(`/api/plugins/${encodeURIComponent(id)}/run`, "POST", payload);

/** 指定サーフェスに寄与するマニフェスト一覧（起動時取得をキャッシュ）。 */
export function usePluginManifests(surface: PluginSurface): PluginManifest[] {
  const [list, setList] = useState<PluginManifest[]>([]);
  useEffect(() => {
    let alive = true;
    loadPluginManifests().then((all) => {
      if (!alive) return;
      setList(all.filter((m) => m.frontend?.contributes?.includes(surface)));
    });
    return () => {
      alive = false;
    };
  }, [surface]);
  return list;
}

/** メニューへ流し込むための中立な項目形（両メニューバーが label/onClick を利用）。 */
export interface PluginMenuItem {
  id: string;
  label: string;
  onClick: () => void;
}

/**
 * サーフェスのプラグインをメニュー項目に変換する。
 * makeHost はクリック対象マニフェストからその画面のホスト（コンテキスト）を組み立てる。
 */
export function usePluginMenu(
  surface: PluginSurface,
  makeHost: (m: PluginManifest) => PluginHost,
): PluginMenuItem[] {
  const manifests = usePluginManifests(surface);
  return manifests.map((m) => ({
    id: m.id,
    label: m.name,
    onClick: () => {
      launchPlugin(m, makeHost(m)).catch((e) => log.error("plugin launch failed", m.id, e));
    },
  }));
}
