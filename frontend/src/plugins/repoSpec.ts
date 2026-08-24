/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */

/**
 * プラグイン導入欄の入力を、backend が受ける {@code owner/repo} へ正規化する。
 *
 * <p>backend の {@code HttpGitHubReleaseClient.requireRepo()} は SSRF / パス注入対策として
 * {@code owner/repo} 以外を弾く。この厳しさは backend 側で保つべきものなので、
 * <b>「人が貼るもの」を受け止めるのは UI の責務</b>とし、ここで正規化する。
 *
 * <p>受理するもの: {@code owner/repo} ／ ブラウザのアドレスバーから貼った URL
 * （{@code https://github.com/owner/repo}・末尾の {@code /}・{@code .git}・
 * {@code /tree/main} のような続き・{@code ?query}・{@code #hash} 付きも可）／
 * {@code git@github.com:owner/repo.git} 形式。
 *
 * @param input 利用者が入力した文字列
 * @returns 正規化した {@code owner/repo}。解釈できなければ {@code null}
 */
export function normalizeRepoSpec(input: string): string | null {
  let s = (input ?? "").trim();
  if (!s) return null;

  // git@github.com:owner/repo(.git) → owner/repo(.git)
  const scp = /^git@github\.com:(.+)$/i.exec(s);
  if (scp) {
    s = scp[1];
  } else {
    // スキーム・ホストを落とす（github.com 以外のホストは受けない）。
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    const host = /^(?:www\.)?github\.com\/(.+)$/i.exec(s);
    if (host) s = host[1];
    else if (s.includes("://") || /^[^/]*\./.test(s.split("/")[0] ?? "")) {
      // 別ホストの URL（例 gitlab.com/...）は受けない。ホスト無しの owner/repo は通す。
      return null;
    }
  }

  // ?query / #hash を落とす。
  s = s.split(/[?#]/)[0];

  // owner/repo より後（/tree/main 等）を落とす。
  const parts = s.split("/").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, "");

  const token = /^[A-Za-z0-9._-]+$/;
  if (!token.test(owner) || !token.test(repo)) return null;
  return `${owner}/${repo}`;
}
