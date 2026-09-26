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
import type { PluginHost, PluginHostSeed, PluginManifest, PluginModule, PluginSurface } from "./pluginTypes";
import { DEMO_MODULES, MOCK_ENABLED, MOCK_MANIFESTS } from "./mockPlugins";
import { requestAiGeneration, type AiGenerationOptions } from "./pluginAiApi";
import { saveFileAs } from "./pluginFileApi";
import { notifyDbChanged, pickFiles, runBackendJob, searchPatients } from "./pluginCommonApi";
import { importVideoAsDicom, probeVideo, readVideoFrameValues, requestVideoImportConsent } from "./pluginVideoApi";

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
  // 🔴 失敗した promise をキャッシュに残さない。残すと、原因が解消したあとも
  // 同じ拒否済み promise を返し続け、**画面を再読込するまで永久に起動できない**
  // （CSP で import が落ちた 2026-08-24 の調査で、症状が居座る理由がこれだった）。
  const p = importModule(m).catch((e) => {
    moduleCache.delete(m.id);
    throw e;
  });
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
  // 🔴 ここが落ちるとブラウザは "Failed to fetch dynamically imported module" としか言わず、
  // HTTP ステータスもサーバ側の理由も出ない。実際に 2 度（CSP の script-src / backend の CORS が
  // Origin: file:// を 403）ここで詰まっているので、次に同じ画面を見る人向けに手掛かりを足す。
  // 切り分けの型は fw/security.md §CORS。
  const mod = await import(/* @vite-ignore */ abs).catch((e) => {
    const why =
      "UI バンドルを読み込めませんでした。CSP(script-src) か backend の CORS(Origin) で" +
      "止められている可能性があります。詳細: fw/security.md §CORS";
    throw new Error(`plugin '${m.id}': ${why} [${abs}] ${e instanceof Error ? e.message : String(e)}`);
  });
  const resolved = (mod.default ?? mod) as PluginModule;
  if (typeof resolved.activate !== "function") {
    throw new Error(`plugin '${m.id}': activate() を公開していません`);
  }
  return resolved;
}

/**
 * マニフェストに紐づくホスト API を注入する。
 *
 * <p>`ai` / `file` を各画面の `makeHost` に書かせない理由: **どちらもマニフェスト
 * （＝権限宣言）と結び付いていなければ意味が無い**。呼び出し側に組み立てさせると、
 * マニフェストの渡し忘れが権限チェックの素通りになる。ここで一度だけ束ねる。
 */
function withHostApis(m: PluginManifest, host: PluginHostSeed): PluginHost {
  // seed はユニオンなので、展開結果を TS が 1 つの枝へ絞れない。足しているのは
  // 欠けている 2 プロパティだけなので、ここだけ明示的に据える。
  return {
    ...host,
    // H50: 本体の REST の基点（ViewerTarget.apiBase と同じ）
    apiBase: apiBase(),
    ai: {
      generate: (req: Omit<AiGenerationOptions, "manifest">) =>
        requestAiGeneration({ ...req, manifest: m }),
    },
    file: { saveAs: saveFileAs, pickFiles },
    // H45: ジョブの投入先はマニフェストの id に固定する（他のプラグインの JAR は走らせられない）
    runBackendJob: (payload, opts) => runBackendJob(m.id, payload, opts),
    db: {
      searchPatients,
      notifyChanged: (detail) => notifyDbChanged(m.id, detail),
    },
    // H47〜H49: 出所（id・名前）はマニフェストから本体が入れる。プラグインに名乗らせない
    video: {
      probe: (path) => probeVideo(m.id, path),
      requestImportConsent: (req) => requestVideoImportConsent({ id: m.id, name: m.name }, req),
      importAsDicom: (req, opts) => importVideoAsDicom(m.id, req, opts),
      readFrameValues: (sop) => readVideoFrameValues(m.id, sop),
    },
  } as PluginHost;
}

/** メニュー項目クリック時: UI バンドルを動的 import して activate(host) を呼ぶ。 */
export async function launchPlugin(m: PluginManifest, host: PluginHostSeed): Promise<void> {
  const mod = await resolveModule(m);
  await mod.activate(withHostApis(m, host));
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
  makeHost: (m: PluginManifest) => PluginHostSeed,
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
