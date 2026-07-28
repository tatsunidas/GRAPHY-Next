/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// プラグインマネージャ REST（/api/plugin-manager/*）のクライアント。
// backend: com.vis.graphynext.plugin.manager.PluginManagerController。設計: fw/plugin-manager-design.md。
// 実行レイヤの /api/plugins（pluginRegistry.ts・起動時キャッシュ）とは別系統で、常にライブ取得する。
import { apiBase } from "../apiBase";
import { httpGet, httpSend } from "../http";
import { saveSettings } from "../settings/settingsApi";

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

/** 導入操作の可否（フロントが導入 UI とオプトイン トグルを出すか判断する）。 */
export interface ManagerStatus {
  /** 導入系を実行できるか（standalone＋管理者ゲート＋ユーザーのオプトイン）。 */
  canManage: boolean;
  standalone: boolean;
  /** 管理者ゲート（graphy.plugins.manager-enabled）。 */
  managerEnabled: boolean;
  /** ユーザーのオプトイン現在値（設定キー plugins.installEnabled）。 */
  installEnabled: boolean;
  /** オプトイン トグルを操作できるか（＝トグルを表示するか）。 */
  canOptIn: boolean;
  hasGithubToken: boolean;
}

/** オプトイン トグルの設定キー（backend: SettingsService.PLUGIN_INSTALL_ENABLED_KEY）。 */
export const PLUGIN_INSTALL_ENABLED_KEY = "plugins.installEnabled";

/**
 * 導入前の検査結果（同意画面に出す内容）。この時点では展開も保存もされていない。
 * backend: PluginManagerService.PluginPreview。
 */
export interface PluginPreview {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  homepage: string | null;
  license: string | null;
  sourceType: string;
  sourceRef: string;
  trust: string;
  /** 取得した zip の実測ハッシュ。同意後の install にそのまま渡す（TOCTOU 対策）。 */
  sha256: string;
  /** リリースの <zip>.sha256 資産で照合できたか。 */
  integrityVerified: boolean;
  hasUi: boolean;
  /** 同梱 JAR。存在する＝アプリと同じ権限の JVM で動くコードを含む。 */
  jars: string[];
  files: string[];
  totalBytes: number;
  /** 宣言された要求権限（現状は情報のみで強制されない）。 */
  permissions: string[];
  graphyOk: boolean;
  graphyRange: string | null;
  coreVersion: string;
  /** 実行中の OS に対応しているか（engines.os との突き合わせ）。 */
  osOk: boolean;
  /** 宣言された対応 OS（空＝OS 非依存）。 */
  declaredOs: string[];
  /** 実行中の OS トークン（win32 / darwin / linux）。 */
  currentOs: string;
  alreadyInstalled: boolean;
  installable: boolean;
  /**
   * 署名の状態。
   * - `trusted`   … 本体が信頼する鍵（公式配布）で検証できた
   * - `pinned`    … 前回導入時と同じ鍵で検証できた（更新・TOFU）
   * - `first-use` … 署名はあるが鍵は未知（第三者の初回導入）
   * - `unsigned`  … 署名なし
   * - `invalid`   … 署名が壊れている／鍵が変わった（導入は拒否される）
   */
  signature: "trusted" | "pinned" | "first-use" | "unsigned" | "invalid";
  signerKeyId: string | null;
  /** minisign の trusted comment（署名で保護された注記）。 */
  signatureComment: string | null;
  signatureProblem: string | null;
  /** 既知の鍵で署名が通り互換性も OK＝同意画面を出さずに導入してよい。 */
  autoInstallable: boolean;
}

/** 取得可能なリリース（互換情報は導入時に判定）。 */
export interface AvailableVersion {
  tag: string;
  publishedAt: string | null;
  prerelease: boolean;
  zipAsset: string | null;
}

export const fetchManagerStatus = () => httpGet<ManagerStatus>("/api/plugin-manager/status");

/**
 * 導入オプトインの切替。専用 API は設けず、汎用の設定ストアに保存する
 * （backend の SettingsInstallOptIn が同じキーを読む）。
 */
export const setPluginInstallEnabled = (enabled: boolean) =>
  saveSettings({ [PLUGIN_INSTALL_ENABLED_KEY]: String(enabled) });

export const fetchInstalledPlugins = () => httpGet<InstalledPlugin[]>("/api/plugin-manager/installed");

export const fetchPluginVersions = (repo: string) =>
  httpGet<AvailableVersion[]>(`/api/plugin-manager/versions?repo=${encodeURIComponent(repo)}`);

/** 取得して中身を検査するだけ（展開・保存はしない）。同意画面の材料を得る。 */
export const inspectPluginFromGitHub = (repo: string, version?: string) =>
  httpSend<PluginPreview>("/api/plugin-manager/inspect/github", "POST", { repo, version });

/**
 * 同意後の導入。`confirmedSha256` には検査で提示された sha256 をそのまま渡す
 * （同意した成果物と実際に入るものが一致することを backend が保証する）。
 */
export const installPluginFromGitHub = (
  repo: string,
  version: string | undefined,
  confirmedSha256: string,
  acknowledgeUnverified: boolean,
) =>
  httpSend<InstalledPlugin>("/api/plugin-manager/install/github", "POST", {
    repo,
    version,
    confirmedSha256,
    acknowledgeUnverified,
  });

export const reinstallPlugin = (id: string) =>
  httpSend<InstalledPlugin>(`/api/plugin-manager/${encodeURIComponent(id)}/reinstall`, "POST");

export const enablePlugin = (id: string) =>
  httpSend<{ id: string; enabled: boolean }>(`/api/plugin-manager/${encodeURIComponent(id)}/enable`, "POST");

export const disablePlugin = (id: string) =>
  httpSend<{ id: string; enabled: boolean }>(`/api/plugin-manager/${encodeURIComponent(id)}/disable`, "POST");

export const uninstallPlugin = (id: string) =>
  httpSend<{ id: string; removed: boolean }>(`/api/plugin-manager/${encodeURIComponent(id)}`, "DELETE");

/** ローカル zip の検査（オフライン導入の同意画面用）。展開・保存はしない。 */
export const inspectPluginFromFile = (file: File) =>
  postZip<PluginPreview>("/api/plugin-manager/inspect/file", file);

/**
 * ローカル zip を導入（オフライン/エアギャップ）。`confirmedSha256` は検査で提示された値。
 */
export const installPluginFromFile = (file: File, confirmedSha256: string) =>
  postZip<InstalledPlugin>("/api/plugin-manager/install/file", file, { confirmedSha256 });

/**
 * zip の multipart POST。http.ts は JSON 専用のため raw fetch を使う。
 * 失敗時は backend の {error} を優先してメッセージ化する。
 */
async function postZip<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${apiBase()}${path}`, { method: "POST", body: form });
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
  return (await res.json()) as T;
}
