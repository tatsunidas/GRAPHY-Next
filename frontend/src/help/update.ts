/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 更新確認（レベル0: 通知のみ）のロジック。
//   - GitHub Releases の最新版取得は main プロセス経由（desktopBridge.checkForUpdate）。
//     レンダラは CSP（connect-src が localhost のみ）で api.github.com を直接叩けないため。
//   - ここではバージョン比較と「スキップ済み」判定だけを行う。UI は UpdateNotice.tsx。

import { desktop } from "../desktopBridge";

/** アプリ内の自動更新の可否（main が資産・署名・OS から判定。URL は渡ってこない）。 */
export interface AutoUpdateInfo {
  supported: boolean;
  reason?: string;
  kind?: string;
  version?: string;
  assetName?: string;
  size?: number;
}

export interface ReleaseInfo {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
  auto?: AutoUpdateInfo;
}

export type UpdateResult =
  | { kind: "update"; current: string; latest: string; info: ReleaseInfo }
  | { kind: "latest"; current: string; latest: string }
  | { kind: "unavailable" } // デスクトップでない等、確認不可
  | { kind: "error" }; // 取得失敗（ネットワーク等）

const SKIP_KEY = "graphy.update.skipVersion";

/** 先頭の "v" を除いた素のバージョン文字列。 */
export function normalizeVersion(v: string): string {
  return (v || "").trim().replace(/^v/i, "");
}

/** ドット区切りの数値比較（プレリリース接尾辞は簡易に無視）。a>b→1, a<b→-1, 等しい→0。 */
export function compareVersions(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.+-]/).map((x) => parseInt(x, 10));
  const pb = normalizeVersion(b).split(/[.+-]/).map((x) => parseInt(x, 10));
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 現在バージョンと最新リリースを比較して結果を返す。 */
export async function checkForUpdate(current: string): Promise<UpdateResult> {
  const d = desktop();
  if (!d?.checkForUpdate) return { kind: "unavailable" };
  const info = await d.checkForUpdate();
  if (!info || !info.tagName) return { kind: "error" };
  const latest = normalizeVersion(info.tagName);
  const cur = normalizeVersion(current);
  if (compareVersions(latest, cur) > 0) return { kind: "update", current: cur, latest, info };
  return { kind: "latest", current: cur, latest };
}

/** そのバージョンを「スキップ」済みか（自動通知の抑止用。手動確認では無視する）。 */
export function isSkipped(version: string): boolean {
  try {
    return localStorage.getItem(SKIP_KEY) === normalizeVersion(version);
  } catch {
    return false;
  }
}

/** そのバージョンを今後は自動通知しないよう記録する。 */
export function skipVersion(version: string): void {
  try {
    localStorage.setItem(SKIP_KEY, normalizeVersion(version));
  } catch {
    /* localStorage 不可の環境では単に無視 */
  }
}

// ── 自動更新の進行の表示（純ロジック）─────────────────────────────────────────

/** 失敗の理由コード（main の UpdateError.code）を、利用者に見せる種類へ分ける。 */
export type UpdateFailureKind = "network" | "verify" | "server" | "other";

export function updateFailureKind(reason: string | undefined): UpdateFailureKind {
  const r = reason ?? "";
  if (r === "network" || r === "stall") return "network";
  if (r === "digest-mismatch" || r === "size-mismatch" || r.startsWith("signature-")) return "verify";
  if (/^http-\d+$/.test(r) || r === "bad-host" || r === "bad-url" || r === "too-many-redirects" || r === "too-large") return "server";
  return "other";
}

/** 進捗（0〜100 の整数）。総量が分からない・0 以下なら null。 */
export function updateProgressPercent(bytes: number | undefined, total: number | undefined): number | null {
  if (typeof bytes !== "number" || typeof total !== "number" || !(total > 0)) return null;
  return Math.max(0, Math.min(100, Math.floor((bytes / total) * 100)));
}

/** バイト数を「123.4 MB」の形に。 */
export function formatMegabytes(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "—";
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** 進行中（取得・検証・適用）か。ダイアログを閉じても続く。 */
export function isUpdateActive(phase: string | undefined): boolean {
  return phase === "downloading" || phase === "verifying" || phase === "applying";
}
