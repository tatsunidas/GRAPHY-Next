/*
 * モバイル web の PWA 化（Service Worker によるアプリ本体のオフライン起動）の検証。
 *
 * 実行:  cd frontend && npm run build && cd ../automator && npx tsx src/spike/pwaOfflineCheck.ts
 * 前提:  frontend/dist（ビルド済み）、automator の npm ci、Playwright の Chromium。
 *
 * frontend/dist を静的サーバーで配信し、/api/** は呼出しを数えるスタブで答える（backend は使わない）。
 *   正例: SW が登録され制御する／機内モード相当（offline）の再読み込みでアプリ本体が起動し「オフライン」が出る／
 *         検査一覧は出ず「サーバーに繋がっていません」／オンライン復帰で表示が戻る
 *   負例: Cache Storage に /api/** のレスポンスが 1 件も無い／オフライン中に SW が /api/** を代理応答していない
 * 未達: iOS Safari・iPadOS・Android Chrome の実機（ホーム画面に追加・全面表示・機内モード）、Electron（file://）。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const DIST = path.join(AUTOMATOR_ROOT, "..", "frontend", "dist");
const PORT = 19620;
const BASE = `http://localhost:${PORT}`;
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "pwa-offline-check");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".wasm": "application/wasm",
};

const { check, summary } = createChecker();
const apiHits: string[] = [];

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname.startsWith("/api/")) {
    apiHits.push(url.pathname);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/api/status") {
      res.end(JSON.stringify({ app: "GRAPHY-Next", version: "0.0.0", mode: "web", activeProfiles: ["web"], javaVersion: "21" }));
    } else {
      res.end("[]");
    }
    return;
  }
  const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("Content-Type", MIME[path.extname(file)] ?? "application/octet-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(file));
});

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error("frontend/dist がありません。先に npm run build");
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await new Promise<void>((r) => server.listen(PORT, "localhost", r));

  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      serviceWorkers: "allow",
    });
    const page = await ctx.newPage();
    const swErrors: string[] = [];
    page.on("pageerror", (e) => swErrors.push(String(e)));

    const consent = async () => {
      const agree = page.getByRole("button", { name: "同意して使う" });
      if (await agree.isVisible({ timeout: 2000 }).catch(() => false)) await agree.click();
    };

    console.log("== オンラインで開く");
    await page.goto(`${BASE}/#mobile`);
    await consent();
    await page.getByTestId("mobile-shell").waitFor({ timeout: 20_000 });
    check(true, "モバイルシェルが描画される");
    check(await page.getByTestId("mobile-search-input").isVisible(), "（前提）オンラインでは検査の検索欄が出ている");
    await page.screenshot({ path: path.join(OUT_DIR, "01-online.png") });

    console.log("== Service Worker");
    const reg = await page.evaluate(async () => {
      const r = await navigator.serviceWorker.ready;
      return { scope: r.scope, active: !!r.active };
    });
    check(reg.active && reg.scope === `${BASE}/`, "SW が登録され有効になる", reg);

    const manifestRes = await page.request.get(`${BASE}/manifest.webmanifest`);
    const manifest = (await manifestRes.json()) as { display?: string; icons?: { src: string }[] };
    check(manifestRes.ok() && manifest.display === "standalone" && (manifest.icons?.length ?? 0) >= 2, "manifest が standalone でアイコンを持つ");
    const iconOk = await Promise.all((manifest.icons ?? []).map((i) => page.request.get(new URL(i.src, `${BASE}/`).href).then((r) => r.ok())));
    check(iconOk.length > 0 && iconOk.every(Boolean), "manifest のアイコンが全部取得できる");

    // SW が制御する（clients.claim）まで再読み込みして、制御下の状態でアセットをキャッシュさせる。
    await page.reload();
    await consent();
    await page.getByTestId("mobile-shell").waitFor({ timeout: 20_000 });
    check(await page.evaluate(() => !!navigator.serviceWorker.controller), "再読み込み後は SW が画面を制御している");

    console.log("== Cache Storage");
    const cached = await page.evaluate(async () => {
      const out: string[] = [];
      for (const name of await caches.keys()) {
        for (const req of await (await caches.open(name)).keys()) out.push(new URL(req.url).pathname);
      }
      return out;
    });
    check(cached.some((p) => p === "/index.html" || p === "/"), "index.html が保存されている", cached.slice(0, 5));
    check(cached.some((p) => p.startsWith("/assets/") && p.endsWith(".js")), "ハッシュ付きの JS が保存されている");
    check(cached.length > 0 && cached.every((p) => !p.startsWith("/api/")), "負例: /api/** は 1 件も保存されていない", cached.filter((p) => p.startsWith("/api/")));
    check(apiHits.length > 0, "（前提）オンライン中は /api/** にサーバーへ届いている（スタブが呼ばれた）", apiHits.length);

    console.log("== オフライン（機内モード相当）で再読み込み");
    await ctx.setOffline(true);
    const hitsBefore = apiHits.length;
    await page.reload();
    await consent();
    await page.getByTestId("mobile-shell").waitFor({ timeout: 20_000 });
    check(true, "正例: オフラインでもアプリ本体が起動する");
    await page.getByTestId("mobile-offline-badge").waitFor({ timeout: 5000 });
    check(true, "ヘッダに「オフライン」が出る");
    check(await page.getByTestId("mobile-offline-panel").isVisible(), "検査一覧は出ず「サーバーに繋がっていません」の表示");
    check((await page.getByTestId("mobile-search-input").count()) === 0, "負例: 検査の検索欄・一覧が出ていない");
    check(apiHits.length === hitsBefore, "負例: オフライン中にスタブの /api/** へ届いた要求が無い（SW が代理応答していない）", apiHits.length - hitsBefore);
    await page.screenshot({ path: path.join(OUT_DIR, "02-offline.png") });

    console.log("== オンライン復帰");
    await ctx.setOffline(false);
    await page.getByTestId("mobile-offline-panel").waitFor({ state: "detached", timeout: 5000 });
    check((await page.getByTestId("mobile-offline-badge").count()) === 0, "オンライン復帰で「オフライン」の表示が消える");
    await page.screenshot({ path: path.join(OUT_DIR, "03-back-online.png") });
    check(swErrors.length === 0, "ページの例外が無い", swErrors);
  } finally {
    await browser.close();
    server.close();
  }
}

main()
  .then(() => process.exit(summary() === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    server.close();
    process.exit(2);
  });
