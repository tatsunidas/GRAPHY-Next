/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// 更新確認（レベル0: 通知のみ）のロジック。
//   - GitHub Releases の最新版取得は main プロセス経由（desktopBridge.checkForUpdate）。
//     レンダラは CSP（connect-src が localhost のみ）で api.github.com を直接叩けないため。
//   - ここではバージョン比較と「スキップ済み」判定だけを行う。UI は UpdateNotice.tsx。

import { desktop } from "../desktopBridge";

export interface ReleaseInfo {
  tagName: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
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
