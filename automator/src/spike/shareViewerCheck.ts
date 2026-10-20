/*
 * 検査共有リンクの受け手の画面（#share）の実機検証。設計: fw/share-design.md。
 *
 * 実行:  cd automator && npx tsx src/spike/shareViewerCheck.ts
 * 前提:  backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、frontend・automator の npm ci、fixture ct-basic。
 *
 * 流れ（本物の jar ＋ Vite ＋ Chromium）:
 *   ① standalone で起動して ct-basic を取り込み、停止  ② 同じデータ置き場で share プロファイルを起動
 *   ③ 管理 API でリンクを発行  ④ ブラウザで /s/<token> を開く
 * 確かめること:
 *   正例: #share に着地 → 検査カードとシリーズ → 画像が描画される／3D・MPR・レポートの導線が無い
 *   負例: 範囲外の検査・設定・一覧は 403/404 のまま／取り消したリンクは「無効」画面で、画像も検査名も出ない／
 *         存在しないリンクをブラウザで開くと読める無効ページ（状態は 404）
 *   監査: 画面操作中に飛んだ全リクエストのうち 403/404 を一覧し、画面に必要な経路が止まっていないか見る
 * 未達: 実機のスマホ、TLS 越しの Secure Cookie、実配備。
 */
import { chromium, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { waitForBackendReady } from "../backend/healthcheck.js";
import { killProcessTree } from "../common/processUtils.js";
import { waitForHttp } from "../common/waitForHttp.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const PORTS = { http: 19590, scp: 19591, vite: 19593 };
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "share-viewer-check");
const DATA_DIR = path.join(OUT_DIR, "data");
const JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");
const FRONTEND_DIR = path.join(AUTOMATOR_ROOT, "..", "frontend");
const ADMIN_KEY = crypto.randomBytes(24).toString("hex");
const SESSION_SECRET = crypto.randomBytes(24).toString("hex");
const BASE = `http://127.0.0.1:${PORTS.http}`;
const VITE = `http://localhost:${PORTS.vite}`;

const { check, summary } = createChecker();
const procs: ChildProcess[] = [];

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("error", () => resolve(false));
  });
}

function startJar(profile: string, extraEnv: Record<string, string> = {}): ChildProcess {
  const p = spawn("java", [
    "--add-opens", "java.base/java.io=ALL-UNNAMED",
    "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
    "-jar", JAR, `--spring.profiles.active=${profile}`,
    `--server.port=${PORTS.http}`, `--graphy.dicom.scp.port=${PORTS.scp}`,
    ...(profile === "share" ? ["--graphy.dicom.scp.enabled=false"] : []),
  ], { cwd: DATA_DIR, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
  p.stdout?.on("data", () => {});
  p.stderr?.on("data", () => {});
  procs.push(p);
  return p;
}

async function stopAndWait(p: ChildProcess, port: number): Promise<void> {
  killProcessTree(p);
  for (let i = 0; i < 40 && (await portInUse(port)); i++) await new Promise((r) => setTimeout(r, 250));
}

async function admin(method: string, p: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${p}`, {
    method,
    headers: { Authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** 描画された画像があるか: 領域の輝度の分散が十分ある（真っ黒・単色ではない）。判定の補助で、最後は目で見る。 */
async function looksRendered(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (b64) => {
    const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
    const bmp = await createImageBitmap(blob);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0, sum2 = 0, n = 0;
    for (let i = 0; i < d.length; i += 16) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; sum2 += l * l; n++; }
    const mean = sum / n;
    return Math.sqrt(sum2 / n - mean * mean);
  }, png);
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [name, port] of Object.entries(PORTS)) {
    if (await portInUse(port)) throw new Error(`ポート ${port}（${name}）が使用中です。孤児プロセスが居ないか確かめてください。`);
  }
  if (!fs.existsSync(JAR)) throw new Error(`backend jar がありません: ${JAR}`);
  console.log(`jar: ${JAR}（更新 ${fs.statSync(JAR).mtime.toISOString()}）`);

  // ① 取り込み（standalone）
  const seedProc = startJar("standalone");
  await waitForBackendReady(PORTS.http);
  await importFixtureCategory(PORTS.http, "ct-basic");
  const studies = (await (await fetch(`${BASE}/api/studies`)).json()) as { studyInstanceUid: string }[];
  const studyUid = studies[0]?.studyInstanceUid;
  check(!!studyUid, "取り込み: ct-basic のスタディが実在する", studies.length);
  await stopAndWait(seedProc, PORTS.http);

  // ② share プロファイル ＋ Vite
  startJar("share", { GRAPHY_SHARE_ADMIN_KEY: ADMIN_KEY, GRAPHY_SHARE_SESSION_SECRET: SESSION_SECRET });
  await waitForHttp({ host: "127.0.0.1", port: PORTS.http, path: "/actuator/health", timeoutMs: 90_000 });
  const vite = spawn(process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--", "--port", String(PORTS.vite), "--strictPort"],
    { cwd: FRONTEND_DIR, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
      env: { ...process.env, VITE_BACKEND_URL: `http://localhost:${PORTS.http}` } });
  vite.stdout?.on("data", () => {});
  vite.stderr?.on("data", () => {});
  procs.push(vite);
  await waitForHttp({ host: "localhost", port: PORTS.vite, path: "/", timeoutMs: 90_000 });

  // ③ 発行
  const issuedRes = await admin("POST", "/api/share/grants", { studyUids: [studyUid], ttlDays: 1 });
  check(issuedRes.status === 201, "発行できる", issuedRes.status);
  const issued = (await issuedRes.json()) as { id: string; path: string };

  // ④ ブラウザ
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 420, height: 860 }, locale: "ja-JP" });
  const page = await context.newPage();
  const seen: { status: number; method: string; path: string }[] = [];
  const consoleErrors: string[] = [];
  page.on("response", (r) => {
    const u = new URL(r.url());
    if (u.origin === VITE && (u.pathname.startsWith("/api/") || u.pathname.startsWith("/s/"))) {
      seen.push({ status: r.status(), method: r.request().method(), path: u.pathname.replace(/\/s\/.+/, "/s/<token>") });
    }
  });
  page.on("response", (r) => { if (r.status() >= 400) consoleErrors.push(`HTTP ${r.status()} ${r.url()}`); });
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  try {
    await page.goto(`${VITE}${issued.path}`);
    await page.waitForURL(/#share$/, { timeout: 30_000 }).catch(() => {});
    check(page.url().endsWith("#share"), "入口から #share に着地する", page.url());
    await page.getByTestId("share-study").waitFor({ timeout: 30_000 }).catch(() => {});
    check((await page.getByTestId("share-study").count()) === 1, "検査カードが出る");
    check((await page.getByTestId("share-notice").count()) === 1, "注意書きが常設される");
    await page.screenshot({ path: path.join(OUT_DIR, "1-study.png") });

    const seriesBtn = page.locator('[data-testid^="mobile-series-"]').first();
    await seriesBtn.waitFor({ timeout: 20_000 }).catch(() => {});
    check((await seriesBtn.count()) === 1, "シリーズ一覧が出る");
    await seriesBtn.click();
    await page.locator("canvas").first().waitFor({ timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await page.screenshot({ path: path.join(OUT_DIR, "2-viewer.png") });
    const box = await page.locator("canvas").first().boundingBox();
    check(!!box, "ビューアの canvas が出る");
    if (box) {
      const sd = await looksRendered(page, { x: box.x, y: box.y, width: box.width, height: box.height });
      check(sd > 8, "画像が描画されている（輝度の分散が単色でない。目視でも確認）", { sd });
    }
    check((await page.getByTestId("mobile-reset-all").count()) === 1, "ツールバーが出る（対照）");
    for (const id of ["mobile-open-mpr", "mobile-open-3d", "mobile-attach-report"]) {
      check((await page.getByTestId(id).count()) === 0, `読み取り専用: ${id} が無い`);
    }

    // 負例（同じセッションの Cookie で）
    const probe = (p: string, init?: RequestInit) =>
      page.evaluate(async ([u, i]) => (await fetch(u as string, i as RequestInit)).status, [p, init ?? {}] as const);
    check((await probe("/api/studies/9.9.9/series")) === 403, "範囲外の検査は 403");
    check((await probe("/api/studies")) === 404, "検査の一覧は 404");
    check((await probe("/api/settings")) === 404, "設定は 404");
    check((await probe("/api/settings", { method: "PUT", body: "{}", headers: { "content-type": "application/json" } })) === 404, "設定の書き込みは 404");
    check((await probe("/api/status")) === 404, "状態 API は 404（App を通していない根拠）");

    // 取り消し → 開き直し
    const del = await admin("DELETE", `/api/share/grants/${issued.id}`);
    check(del.status === 204, "取り消せる", del.status);
    await page.reload();
    await page.getByTestId("share-invalid").waitFor({ timeout: 20_000 }).catch(() => {});
    check((await page.getByTestId("share-invalid").count()) === 1, "取り消し後は「無効」画面");
    check((await page.getByTestId("share-study").count()) === 0 && (await page.locator("canvas").count()) === 0,
      "取り消し後は検査カードも画像も出ない");
    await page.screenshot({ path: path.join(OUT_DIR, "3-invalid.png") });

    // 存在しないリンクをブラウザで開く
    const ctx2 = await browser.newContext({ locale: "ja-JP" });
    const p2 = await ctx2.newPage();
    const resp = await p2.goto(`${VITE}/s/${"C".repeat(43)}`);
    check(resp?.status() === 404, "存在しないリンクは 404", resp?.status());
    check((await p2.locator("body").innerText()).includes("無効か、期限が切れています"), "ブラウザには読める無効ページ");
    await p2.screenshot({ path: path.join(OUT_DIR, "4-bad-link.png") });
    await ctx2.close();
  } finally {
    console.log(`\n  [診断] body: ${(await page.locator("body").innerHTML().catch(() => "?")).slice(0, 400)}`);
    if (consoleErrors.length) console.log(`\n  [診断] コンソールエラー ${consoleErrors.length} 件:\n    ${consoleErrors.slice(0, 8).map((e) => e.slice(0, 200)).join("\n    ")}`);
    await browser.close().catch(() => {});
  }

  // 監査: 止められた要求の一覧
  const blocked = seen.filter((s) => s.status === 403 || s.status === 404);
  const groups = new Map<string, number>();
  for (const b of blocked) groups.set(`${b.status} ${b.method} ${b.path.replace(/[0-9.]{10,}/g, "<uid>")}`, (groups.get(`${b.status} ${b.method} ${b.path.replace(/[0-9.]{10,}/g, "<uid>")}`) ?? 0) + 1);
  console.log("\n  止められた要求（画面操作中。プローブの分を含む）:");
  for (const [k, n] of groups) console.log(`    ${n} × ${k}`);
  console.log(`  コンソールエラー ${consoleErrors.length} 件`);
  for (const e of consoleErrors.slice(0, 12)) console.log(`    ${e.slice(0, 160)}`);
  fs.writeFileSync(path.join(OUT_DIR, "requests.json"), JSON.stringify({ seen, consoleErrors }, null, 1));
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  for (const p of procs) killProcessTree(p);
}
process.exitCode = process.exitCode || (summary() > 0 ? 1 : 0);
