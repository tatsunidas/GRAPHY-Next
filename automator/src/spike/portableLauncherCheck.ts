/*
 * Export 媒体のポータブル 2D ビューア: 起動スクリプト（ローカルサーバ）→ 自動認識の実機検証。
 *
 * 実行（通し・推奨）: backend の完全ビルド（cd backend && mvn -DskipTests package）のあと
 *        cd automator && PORTABLE_E2E=1 [PORTABLE_FIXTURE=<DICOM のフォルダ。複数は ; 区切り（Windows）。既定は fixtures/ct-basic>] npx tsx src/spike/portableLauncherCheck.ts
 *   → backend を起動し、フィクスチャ（ct-basic）を取り込み、**本物の Export（ZIP）**を展開した媒体で試す
 *     （媒体の VIEWER/・START-VIEWER.* は Export が書いたもの）。
 * 実行（媒体を指定）: cd frontend && npm run build:portable のあと
 *        PORTABLE_MEDIA=<Export した媒体のルート> npx tsx src/spike/portableLauncherCheck.ts
 *   → 媒体を .results/portable-launcher/media へコピーし、portable-dist と起動スクリプトを入れて試す。
 *
 * **実際の利用と同じ手順**で試す:
 *   正例: START-VIEWER を実行 → 表示された URL を実 Google Chrome（フラグなし）で開く → 操作なしで患者・シリーズが一覧され、
 *         最初のシリーズが描画される（画像の矩形の画素・オーバレイの値で判定）／ハートビートで生き続ける／
 *         ブラウザを閉じると一定時間で自動終了する
 *   負例: file:// で index.html を直接開く → スクリプトもスタイルも読めない（CORS）が、案内が出る／
 *         トークン無し・別トークン・`..`・バックスラッシュ・ドライブ指定・ディレクトリ・別 Host・POST は拒否／
 *         ルートの外のファイルは読めない
 * 未達: macOS（Perl・Gatekeeper）、Edge、SmartScreen の警告（この機械では確かめられない）。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "portable-launcher");
const MEDIA = path.join(OUT_DIR, "media");
const DIST = path.join(AUTOMATOR_ROOT, "..", "frontend", "portable-dist");
const LAUNCHER = path.join(AUTOMATOR_ROOT, "..", "backend", "src", "main", "resources", "portable-launcher");
const IS_WIN = process.platform === "win32";
const IDLE_SECONDS = 30;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const BACKEND_JAR = path.join(AUTOMATOR_ROOT, "..", "backend", "target", "graphy-next-backend.jar");

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });
}

/** backend を起動し、ct-basic を取り込んで Export（ZIP）→ 展開した媒体を MEDIA に作る（Export が書いた VIEWER/・起動ファイルがそのまま入る）。 */
async function exportMedia(): Promise<void> {
  if (!fs.existsSync(BACKEND_JAR)) throw new Error("backend の完全ビルドがありません: " + BACKEND_JAR);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(MEDIA, { recursive: true });
  const dataDir = path.join(OUT_DIR, "backend-data");
  fs.mkdirSync(dataDir, { recursive: true });
  const http_ = await freePort();
  const scp = await freePort();
  const proc = spawn(
    "java",
    [
      "--add-opens", "java.base/java.io=ALL-UNNAMED",
      "--add-opens", "java.desktop/javax.imageio.stream=ALL-UNNAMED",
      "-jar", BACKEND_JAR,
      "--spring.profiles.active=standalone",
      `--server.port=${http_}`,
      `--graphy.dicom.scp.port=${scp}`,
    ],
    { cwd: dataDir, stdio: "ignore" },
  );
  try {
    const base = `http://127.0.0.1:${http_}`;
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch(`${base}/api/studies`)).ok) break;
      } catch {
        /* まだ */
      }
      await sleep(500);
    }
    const imp = await fetch(`${base}/api/import/paths`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paths: (process.env.PORTABLE_FIXTURE ?? path.join(AUTOMATOR_ROOT, "fixtures", "ct-basic"))
          .split(path.delimiter)
          .map((x) => x.replace(/\\/g, "/")),
      }),
    });
    const impBody = (await imp.json()) as { imported: number };
    check(imp.ok && impBody.imported > 0, "（前提）フィクスチャを取り込めた", impBody);
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const selections: { studyUid: string; seriesUids: string[] }[] = [];
    for (const st of studies) {
      const series = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
      selections.push({ studyUid: st.studyInstanceUid, seriesUids: series.map((x) => x.seriesInstanceUid) });
    }
    const res = await fetch(`${base}/api/export/zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selections, includeDicomDir: true, includePortableViewer: true, includeReadme: true }),
    });
    check(res.status === 200, "（前提）Export（ポータブルビューア同梱）が成功する", res.status);
    const zip = path.join(OUT_DIR, "export.zip");
    fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
    if (IS_WIN) {
      execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${MEDIA}' -Force`]);
    } else {
      execFileSync("unzip", ["-q", "-o", zip, "-d", MEDIA]);
    }
    for (const f of ["START-VIEWER.bat", "START-VIEWER.sh", "START-VIEWER.command", "VIEWER/serve.ps1", "VIEWER/serve.pl", "VIEWER/index.html", "DICOMDIR"]) {
      check(fs.existsSync(path.join(MEDIA, f)), `Export した媒体に ${f} がある`);
    }
    fs.writeFileSync(path.join(OUT_DIR, "secret.txt"), "outside-of-media");
  } finally {
    proc.kill();
  }
}

function prepareMedia(src: string): void {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(MEDIA, "VIEWER"), { recursive: true });
  for (const name of ["DICOMDIR", "DICOM", "VIDEO"]) {
    const from = path.join(src, name);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(MEDIA, name), { recursive: true });
  }
  fs.cpSync(DIST, path.join(MEDIA, "VIEWER"), { recursive: true });
  for (const f of ["serve.ps1", "serve.pl"]) fs.copyFileSync(path.join(LAUNCHER, f), path.join(MEDIA, "VIEWER", f));
  for (const f of ["START-VIEWER.bat", "START-VIEWER.sh", "START-VIEWER.command"]) {
    fs.copyFileSync(path.join(LAUNCHER, f), path.join(MEDIA, f));
  }
  // 媒体の外にある「読まれてはいけない」ファイル（パストラバーサルの負例用）
  fs.writeFileSync(path.join(OUT_DIR, "secret.txt"), "outside-of-media");
}

interface Server {
  proc: ChildProcess;
  url: string;
  base: string;
  exited: () => boolean;
  stop: () => void;
}

async function startLauncher(): Promise<Server> {
  const env = { ...process.env, GRAPHY_VIEWER_NO_BROWSER: "1", GRAPHY_VIEWER_IDLE_SECONDS: String(IDLE_SECONDS) };
  const proc = IS_WIN
    ? spawn("cmd", ["/c", ".\\START-VIEWER.bat"], { cwd: MEDIA, env, stdio: ["ignore", "pipe", "pipe"] })
    : spawn("sh", ["START-VIEWER.sh"], { cwd: MEDIA, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let done = false;
  proc.stdout?.on("data", (d: Buffer) => (out += d.toString("utf8")));
  proc.on("exit", () => (done = true));
  const deadline = Date.now() + 60_000;
  let url = "";
  while (Date.now() < deadline && !url) {
    const m = out.match(/VIEWER_URL=(\S+)/);
    if (m) url = m[1];
    else await sleep(200);
  }
  if (!url) throw new Error("起動スクリプトが URL を出さなかった: " + out.slice(0, 400));
  const base = url.replace(/VIEWER\/index\.html$/, "");
  return {
    proc,
    url,
    base,
    exited: () => done,
    stop: () => {
      if (done) return;
      if (IS_WIN && proc.pid) spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      else proc.kill();
    },
  };
}

async function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    s.on("connect", () => (s.destroy(), resolve(true)));
    s.on("error", () => resolve(false));
  });
}

/** スクリーンショット（PNG）の画素を、空白ページで数える。 */
async function pixelStats(helper: Page, png: Buffer): Promise<{ lit: number; max: number; w: number; h: number }> {
  return helper.evaluate(async (b64) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let lit = 0;
    let max = 0;
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      if (y > 40) lit++;
      if (y > max) max = y;
    }
    return { lit: lit / (d.length / 4), max, w: img.width, h: img.height };
  }, png.toString("base64"));
}

async function main(): Promise<void> {
  if (process.env.PORTABLE_E2E === "1") {
    console.log("[0] 本物の Export で媒体を作る");
    await exportMedia();
  } else {
    const src = process.env.PORTABLE_MEDIA;
    if (!src || !fs.existsSync(path.join(src, "DICOMDIR"))) throw new Error("PORTABLE_E2E=1 か、PORTABLE_MEDIA（Export した媒体のルート）を指定してください");
    if (!fs.existsSync(path.join(DIST, "index.html"))) throw new Error("frontend の npm run build:portable を先に実行してください");
    prepareMedia(src);
  }

  let server: Server | null = null;
  let browser: Browser | null = null;
  try {
    console.log("[1] 起動スクリプト");
    server = await startLauncher();
    const port = Number(new URL(server.url).port);
    check(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/VIEWER\/index\.html$/.test(server.url), "URL は 127.0.0.1・乱数ポート・32 桁のトークン付き", server.url);
    check(await portOpen(port), "ポートが開いている", port);

    browser = await chromium.launch({ channel: "chrome", headless: true });
    const helper = await browser.newPage();
    console.log(`  （Chrome ${browser.version()}・フラグなし）`);

    console.log("\n[2] 正例: 操作なしで自動認識・表示（実 Chrome）");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const logs: string[] = [];
    page.on("console", (m) => m.type() === "error" && logs.push(m.text().slice(0, 160)));
    page.on("pageerror", (e) => logs.push("pageerror " + String(e).slice(0, 160)));
    await page.goto(server.url);
    await page.waitForSelector(".pv-card", { timeout: 60_000 });
    check((await page.locator("#boot-guide").count()) === 0, "アプリが起動し、file:// 用の案内が消えている");
    const seriesCards = await page.locator(".pv-card").count();
    check(seriesCards >= 1, "シリーズが一覧に出ている（フォルダ選択なし）", seriesCards);
    await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector(".pv-pos")?.textContent ?? ""), null, { timeout: 60_000 });
    check((await page.locator(".pv-card[aria-current=true]").count()) === 1, "最初のシリーズが自動で開いている");
    await sleep(2000);
    const png = await page.locator('[data-pv-tile="0"]').screenshot();
    await fs.promises.writeFile(path.join(OUT_DIR, "auto-open.png"), png);
    const st = await pixelStats(helper, png);
    check(st.lit > 0.002 && st.max > 100, "画像の矩形に画像が描かれている（黒一色ではない）", st);
    const overlay = await page.locator('[data-pv-tile="0"]').innerText();
    check(/Image\s*1\s*\/\s*\d+/i.test(overlay) || /\d+\s*\/\s*\d+/.test(await page.locator(".pv-pos").innerText()), "枚数（N / M）が出ている", overlay.slice(0, 120));
    await page.screenshot({ path: path.join(OUT_DIR, "auto-open-full.png") });
    check(logs.filter((l) => !/favicon|404/.test(l)).length === 0, "コンソールにエラーが出ていない", logs);

    console.log("\n[3] 生存: ページを開いている間はサーバが止まらない");
    await sleep((IDLE_SECONDS + 10) * 1000);
    check(!server.exited() && (await portOpen(port)), `ページを開いたまま ${IDLE_SECONDS + 10} 秒たってもサーバは動いている（ハートビート）`);

    console.log("\n[4] 負例: 直接開く（file://）");
    const filePage = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const fileErrors: string[] = [];
    filePage.on("console", (m) => m.type() === "error" && fileErrors.push(m.text()));
    await filePage.goto("file:///" + path.join(MEDIA, "VIEWER", "index.html").replace(/\\/g, "/"));
    await sleep(2000);
    const guide = filePage.locator("#boot-guide");
    check(await guide.isVisible(), "案内が全面に出ている");
    check(/START-VIEWER/.test(await guide.innerText()), "案内に START-VIEWER が書かれている");
    check(fileErrors.some((e) => /CORS|blocked/i.test(e)), "（前提）file:// ではスクリプトが CORS で遮断される（案内が必要な理由）", fileErrors.slice(0, 2));
    await filePage.screenshot({ path: path.join(OUT_DIR, "file-guide.png") });
    await filePage.close();

    console.log("\n[5] 負例: サーバの拒否");
    const get = async (url: string, init?: RequestInit & { host?: string }) => {
      try {
        // 生のパスを保つため node:http を使う（fetch は ../ を正規化してしまう）
        return await new Promise<number>((resolve, reject) => {
          const u = new URL(url);
          const req = http.request(
            { host: "127.0.0.1", port: Number(u.port), path: url.replace(/^https?:\/\/[^/]+/, ""), method: init?.method ?? "GET", headers: init?.host ? { Host: init.host } : {} },
            (res) => (res.resume(), resolve(res.statusCode ?? -1)),
          );
          req.on("error", reject);
          req.end();
        });
      } catch {
        return -1;
      }
    };
    const B = server.base;
    check((await get(`${B}DICOMDIR`)) === 200, "（前提）正しいトークンの DICOMDIR は 200");
    check((await get(`http://127.0.0.1:${port}/DICOMDIR`)) === 404, "トークン無し → 404");
    check((await get(`http://127.0.0.1:${port}/${"0".repeat(32)}/DICOMDIR`)) === 404, "別のトークン → 404");
    for (const [label, p] of [
      ["../", "../secret.txt"],
      ["%2e%2e/", "%2e%2e/secret.txt"],
      ["DICOM/../../", "DICOM/../../secret.txt"],
      ["%5c（バックスラッシュ）", "DICOM%5c..%5c..%5csecret.txt"],
      ["%2f の連続", "DICOM%2f..%2f..%2fsecret.txt"],
      ["二重エンコード", "%252e%252e/secret.txt"],
      ["ドライブ指定", "C:/Windows/win.ini"],
    ] as const) {
      const code = await get(`${B}${p}`);
      check(code >= 400, `ルートの外を指す ${label} → 拒否（${code}）`, code);
    }
    check((await get(`${B}DICOM/`)) >= 400, "ディレクトリ → 拒否（一覧を出さない）");
    check((await get(`${B}nope.dcm`)) === 404, "存在しないファイル → 404");
    check((await get(`${B}DICOMDIR`, { host: `evil.example:${port}` })) === 400, "別の Host ヘッダ（DNS rebinding）→ 400");
    check((await get(`${B}DICOMDIR`, { method: "POST" })) >= 400, "POST → 拒否");
    check((await get(`${B}__ping`)) === 204, "ping は 204");

    console.log("\n[6] ブラウザを閉じるとサーバが自動で終了する");
    await page.close();
    const t0 = Date.now();
    while (!server.exited() && Date.now() - t0 < (IDLE_SECONDS + 30) * 1000) await sleep(1000);
    check(server.exited(), `ブラウザを閉じて ${Math.round((Date.now() - t0) / 1000)} 秒でサーバが終了した（上限 ${IDLE_SECONDS + 30} 秒）`);
    check(!(await portOpen(port)), "終了後はポートに接続できない");
  } finally {
    await browser?.close();
    server?.stop();
  }
}

main()
  .then(() => process.exit(summary() === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    summary();
    process.exit(1);
  });
