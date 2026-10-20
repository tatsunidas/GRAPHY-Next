/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// Service Worker がキャッシュしてよい要求の判定（純関数）。sw.js が importScripts で読み、
// 単体テスト（src/mobile/swRules.test.ts）も同じファイルを読む。
//
// 許可リスト方式: アプリ本体（画面・スクリプト・アイコン）だけを入れる。/api/**（患者データ）・
// /s/**（共有リンク）・/rendered/** などは、ここに無いので一切触らない。
(function (root) {
  // scopePath: SW のスコープのパス名（"/" など。末尾 "/"）。サブパス配備でも相対で判定する。
  function relative(url, scopePath) {
    const p = new URL(url).pathname;
    return p.startsWith(scopePath) ? p.slice(scopePath.length) : null;
  }

  // 画面遷移の要求が指す index.html（ルートまたは index.html そのもの）。
  function isShellNavigation(url, scopePath) {
    const rel = relative(url, scopePath);
    return rel === "" || rel === "index.html";
  }

  // 同一オリジンの GET で、アプリ本体の資産だけ。
  function shouldCache(url, method, origin, scopePath) {
    if (method !== "GET") return false;
    const u = new URL(url);
    if (u.origin !== origin) return false;
    const rel = relative(url, scopePath);
    if (rel === null) return false;
    return (
      rel === "" ||
      rel === "index.html" ||
      rel === "manifest.webmanifest" ||
      rel.startsWith("assets/") ||
      rel.startsWith("icons/")
    );
  }

  root.graphySwRules = { isShellNavigation, shouldCache };
})(globalThis);
