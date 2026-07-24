/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグインマネージャ REST（/api/plugin-manager/*）のクライアント。
// backend: com.vis.graphynext.plugin.manager.PluginManagerController。設計: fw/plugin-manager-design.md。
// 実行レイヤの /api/plugins（pluginRegistry.ts・起動時キャッシュ）とは別系統で、常にライブ取得する。
import { apiBase } from "../apiBase";
import { httpGet, httpSend } from "../http";

/** 取得元。 */
export interface PluginSource {
  type: string; // github | file | index
  ref: string; // github: owner/repo, file: アップロード時のファイル名
}

/** 導入済みプラグイン（installed.json 台帳の 1 エントリ）。 */
export interface InstalledPlugin {
  id: string;
  name: string;
  version: string;
  source: PluginSource | null;
  sha256: string | null;
  enabled: boolean;
  pinned: boolean;
  installedAt: string | null;
  trust: string; // verified | community | local
}

/** 導入操作の可否（フロントが導入 UI を出すか判断する）。 */
export interface ManagerStatus {
  canManage: boolean;
  standalone: boolean;
  managerEnabled: boolean;
  hasGithubToken: boolean;
}

/** 取得可能なリリース（互換情報は導入時に判定）。 */
export interface AvailableVersion {
  tag: string;
  publishedAt: string | null;
  prerelease: boolean;
  zipAsset: string | null;
}

export const fetchManagerStatus = () => httpGet<ManagerStatus>("/api/plugin-manager/status");

export const fetchInstalledPlugins = () => httpGet<InstalledPlugin[]>("/api/plugin-manager/installed");

export const fetchPluginVersions = (repo: string) =>
  httpGet<AvailableVersion[]>(`/api/plugin-manager/versions?repo=${encodeURIComponent(repo)}`);

export const installPluginFromGitHub = (repo: string, version?: string) =>
  httpSend<InstalledPlugin>("/api/plugin-manager/install/github", "POST", { repo, version });

export const reinstallPlugin = (id: string) =>
  httpSend<InstalledPlugin>(`/api/plugin-manager/${encodeURIComponent(id)}/reinstall`, "POST");

export const enablePlugin = (id: string) =>
  httpSend<{ id: string; enabled: boolean }>(`/api/plugin-manager/${encodeURIComponent(id)}/enable`, "POST");

export const disablePlugin = (id: string) =>
  httpSend<{ id: string; enabled: boolean }>(`/api/plugin-manager/${encodeURIComponent(id)}/disable`, "POST");

export const uninstallPlugin = (id: string) =>
  httpSend<{ id: string; removed: boolean }>(`/api/plugin-manager/${encodeURIComponent(id)}`, "DELETE");

/**
 * ローカル zip を導入（オフライン/エアギャップ）。http.ts は JSON 専用のため multipart は raw fetch。
 * 失敗時は backend の {error} を優先してメッセージ化する。
 */
export async function installPluginFromFile(file: File): Promise<InstalledPlugin> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`${apiBase()}/api/plugin-manager/install/file`, { method: "POST", body: form });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      message = body.error || body.message || message;
    } catch {
      // JSON でなければステータスのまま
    }
    throw new Error(message);
  }
  return (await res.json()) as InstalledPlugin;
}
