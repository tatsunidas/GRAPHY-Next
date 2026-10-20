/*
 * Copyright (c) Visionary Imaging Services, Inc. All rights reserved.
 * Author: Tatsuaki Kobayashi
 */
// モバイル web のアプリ本体（画面・スクリプト）をオフラインで起動するための Service Worker。
// 患者データ（/api/**）は sw-rules.js の許可リストに無いので、ここでは一切扱わない。
importScripts("./sw-rules.js");

const CACHE = "graphy-shell-v1";
const { isShellNavigation, shouldCache } = globalThis.graphySwRules;
const scopePath = new URL(self.registration.scope).pathname;
const shellKey = new URL("./index.html", self.registration.scope).href;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim()),
  );
});

// 画面: ネットワーク優先（デプロイが即反映される）。繋がらないときだけ保存済みの index.html。
async function shellResponse(request) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(request);
    if (res.ok) await cache.put(shellKey, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(shellKey);
    if (hit) return hit;
    throw e;
  }
}

// ハッシュ付きの資産: 保存済みを優先（内容が変われば名前も変わる）。
async function assetResponse(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.mode === "navigate" && isShellNavigation(request.url, scopePath) && request.method === "GET") {
    event.respondWith(shellResponse(request));
  } else if (shouldCache(request.url, request.method, self.location.origin, scopePath)) {
    event.respondWith(assetResponse(request));
  }
  // それ以外（/api/** など）は respondWith しない＝ブラウザの通常の通信のまま。
});
