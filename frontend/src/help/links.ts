/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Help メニューの外部リンク集と外部オープンのヘルパ。
// デスクトップ(Electron)では main プロセス経由で OS 既定アプリ（ブラウザ・メーラ）を開く。
// web/ブラウザでは window.open にフォールバック。

import { desktop } from "../desktopBridge";

export const HELP_LINKS = {
  /** GRAPHY ユーザーコミュニティ（Google グループ）。 */
  usersCommunity: "https://groups.google.com/g/graphy-users",
  /** 開発者への連絡先メール。 */
  contactEmail: "customerservices@vis-ionary.com",
  /** バグ報告（GitHub Issues）。 */
  githubIssues: "https://github.com/tatsunidas/GRAPHY-Next/issues",
  /** スポンサード開発依頼（GitHub Sponsors）。 */
  sponsors: "https://github.com/sponsors/accounts",
} as const;

/** 外部 URL / mailto を OS 既定アプリで開く（デスクトップ）／新規タブ（web）。 */
export function openExternal(url: string): void {
  const d = desktop();
  if (d?.openExternal) {
    d.openExternal(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** ユーザーコミュニティ（Google グループ）を開く。 */
export function openUsersCommunity(): void {
  openExternal(HELP_LINKS.usersCommunity);
}
