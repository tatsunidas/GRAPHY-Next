/*
 * P5（§7 Portable Viewer での動画）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/portableVideoCheck.ts
 *
 * 何を確かめるか: Export した媒体（ZIP）だけで、**GRAPHY 非インストールの相手が動画を再生できる**こと。
 *   1. Export の ZIP に `VIDEO/{sop}.mp4` が入る（portable viewer 同梱時）＋ 中身が MP4（ftyp）
 *   2. DICOMDIR に動画インスタンスが載っており、portable viewer が**動画シリーズとして認識**する
 *   3. portable viewer が同梱 MP4 を `<video>` で読み、**メタデータ取得とシーク（デコード）まで通る**
 *   4. 動画 → 画像シリーズへ戻せる（タイル表示に復帰する）
 *
 * 方法: ネイティブのフォルダ選択は自動化できないため、portable viewer の自己検証モード
 * （`index.html?selfTest=<baseUrl>`）を使う。媒体ルートに `manifest.json`（相対パス一覧）を置き、
 * ローカル HTTP で配って読ませる（`file://` は fetch が使えないため）。
 *
 * ⚠ ブラウザは **実 Google Chrome**（`channel: "chrome"`）で開く。理由が 2 つある:
 *   - Electron のアプリウィンドウは `will-navigate` / `setWindowOpenHandler` で外部 URL への遷移を
 *     禁止しているので、アプリの窓では媒体を開けない（アプリ側を検証のために緩めたくない）。
 *   - **Playwright 同梱の Chromium は H.264 等のプロプライエタリコーデックを持たない**ため、
 *     同梱 MP4 が再生できず偽の失敗になる。portable viewer の想定環境（Chrome/Edge）で測る。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, type Browser, type Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory, importNonDicomPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "portable-video");
const FIXTURE_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "video-mp4-avi");
const MEDIA_DIR = path.join(OUT_DIR, "media");

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/** 動画フィクスチャ（無ければ ffmpeg で合成）。 */
function ensureVideoFixture(): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const existing = fs
    .readdirSync(FIXTURE_DIR)
    .filter((f) => /\.(mp4|avi)$/i.test(f))
    .map((f) => path.join(FIXTURE_DIR, f));
  if (existing.length > 0) {
    return existing[0];
  }
  const out = path.join(FIXTURE_DIR, "tic-ramp.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=320x240:r=15:d=2",
      "-vf", "geq=lum='clip(20 + (X/W)*100 + T*60, 0, 255)':cb=128:cr=128,format=yuv420p",
      "-c:v", "libx264", "-profile:v", "high", "-level:v", "4.1", "-g", "1", "-pix_fmt", "yuv420p",
      out,
    ],
    { stdio: "inherit" },
  );
  return out;
}

/** ZIP を展開する（unzip コマンド）。 */
function unzip(zip: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync("unzip", ["-q", zip, "-d", dest], { stdio: "inherit" });
}

/** 媒体ルートからの相対パス一覧（portable viewer の selfTest が読む manifest）。 */
function writeManifest(root: string): string[] {
  const rel: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
      } else {
        const r = path.relative(root, p).split(path.sep).join("/");
        // VIEWER/ 自身（ランタイム）は媒体データではないので manifest には入れない。
        if (!r.startsWith("VIEWER/") && r !== "manifest.json") {
          rel.push(r);
        }
      }
    }
  };
  walk(root);
  fs.writeFileSync(path.join(root, "manifest.json"), JSON.stringify(rel, null, 1));
  return rel;
}

/** 媒体を配る静的 HTTP サーバ（file:// では fetch できないため）。 */
function serve(root: string, port: number): http.Server {
  const types: Record<string, string> = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".mp4": "video/mp4", ".wasm": "application/wasm",
  };
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const file = path.join(root, urlPath);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": types[path.extname(file).toLowerCase()] ?? "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  server.listen(port, "127.0.0.1");
  return server;
}

interface SelfTestResult {
  status: string;
  patients?: number;
  thumbnails?: number;
  video?: {
    count: number;
    bundledFiles?: number;
    stageVisible?: boolean;
    gridHidden?: boolean;
    ready?: boolean;
    duration?: number | null;
    videoWidth?: number;
    videoHeight?: number;
    advanced?: boolean;
    backToImage?: boolean;
    note?: string;
  };
  error?: string;
}

async function runSelfTest(page: Page, url: string): Promise<SelfTestResult> {
  await page.goto(url);
  for (let i = 0; i < 120; i++) {
    const r = (await page.evaluate(() => (window as unknown as { __selfTest?: SelfTestResult }).__selfTest)) as
      | SelfTestResult
      | undefined;
    if (r && r.status !== "loading") {
      return r;
    }
    await page.waitForTimeout(500);
  }
  return { status: "timeout" };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const video = ensureVideoFixture();

  const driver = new DesktopDriver();
  await driver.start();
  let server: http.Server | null = null;
  let browser: Browser | null = null;
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    // 画像シリーズ（CT）と動画を 1 つずつ入れる（動画 → 画像の切替まで見るため）。
    await importFixtureCategory(driver.ports.http, "ct-basic");
    const imp = await importNonDicomPaths(driver.ports.http, [video], {
      patientId: "PORTABLE-VIDEO",
      patientName: "PORTABLE^VIDEO",
      seriesDescription: "portable video",
    });
    check(imp.imported === 1, "動画を取り込める", imp);

    const base = `http://127.0.0.1:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[];
    const selections: { studyUid: string; seriesUids: string[] }[] = [];
    for (const st of studies) {
      const series = (await (
        await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)
      ).json()) as { seriesInstanceUid: string }[];
      selections.push({ studyUid: st.studyInstanceUid, seriesUids: series.map((s) => s.seriesInstanceUid) });
    }
    console.log(`Export 対象: ${selections.length} スタディ`);

    // ── 1. Export（portable viewer 同梱）
    const res = await fetch(`${base}/api/export/zip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selections,
        includeDicomDir: true,
        includePortableViewer: true,
        includeReadme: true,
      }),
    });
    check(res.status === 200, "Export が成功する", res.status);
    const zipPath = path.join(OUT_DIR, "export.zip");
    fs.writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    unzip(zipPath, MEDIA_DIR);

    const all: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else all.push(path.relative(MEDIA_DIR, p).split(path.sep).join("/"));
      }
    };
    walk(MEDIA_DIR);
    const videoEntries = all.filter((f) => f.startsWith("VIDEO/") && f.endsWith(".mp4"));
    console.log(`媒体の中身: ${all.length} ファイル（VIDEO/ = ${videoEntries.length}）`);
    check(videoEntries.length === 1, "VIDEO/{sop}.mp4 が 1 本入っている", videoEntries);
    check(all.includes("DICOMDIR"), "DICOMDIR がある");
    check(all.some((f) => f.startsWith("VIEWER/")), "VIEWER/ が同梱されている");
    if (videoEntries.length === 1) {
      const head = fs.readFileSync(path.join(MEDIA_DIR, videoEntries[0])).subarray(0, 12);
      check(head.subarray(4, 8).toString("ascii") === "ftyp", "同梱動画が MP4（ftyp）", head.toString("hex"));
    }
    const readme = fs.existsSync(path.join(MEDIA_DIR, "README.txt"))
      ? fs.readFileSync(path.join(MEDIA_DIR, "README.txt"), "utf8")
      : "";
    check(/VIDEO\//.test(readme), "README に VIDEO/ の説明がある");

    // ── 2〜4. portable viewer の自己検証モードで媒体を読ませる
    writeManifest(MEDIA_DIR);
    const port = 18195;
    server = serve(MEDIA_DIR, port);
    const url = `http://127.0.0.1:${port}/VIEWER/index.html?selfTest=../`;
    console.log(`portable viewer: ${url}`);
    browser = await chromium.launch({ channel: "chrome" });
    viewerPage = await browser.newPage();
    const consoleErrors: string[] = [];
    const notFound: string[] = [];
    viewerPage.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });
    // 404 は「どの URL か」が分からないと判断できない（コンソール文言に URL が出ない）。
    viewerPage.on("response", (r) => {
      if (r.status() === 404) notFound.push(r.url());
    });
    viewerPage.on("pageerror", (e) => consoleErrors.push(String(e)));
    const result = await runSelfTest(viewerPage, url);
    console.log(`selfTest: ${JSON.stringify(result)}`);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "1-portable-video.png") }).catch(() => {});

    check(result.status === "ok", "portable viewer が媒体を読み込める", result.error ?? result.status);
    const v = result.video;
    check((v?.count ?? 0) === 1, "動画シリーズとして認識される", v);
    check((v?.bundledFiles ?? 0) === 1, "同梱 MP4 を引き当てられる", v);
    check(v?.stageVisible === true && v?.gridHidden === true, "動画は <video> 表示に切り替わる", v);
    check(v?.ready === true, "動画のメタデータを読める（再生可能なコンテナ/コーデック）", v);
    check((v?.videoWidth ?? 0) === 320 && (v?.videoHeight ?? 0) === 240, "解像度が元動画と一致する", v);
    check(Math.abs((v?.duration ?? 0) - 2) < 0.2, "長さが約 2 秒", v?.duration);
    check(v?.advanced === true, "シーク（デコード）できる", v);
    check(v?.backToImage === true, "画像シリーズへ戻せる（タイル表示に復帰）", v);

    // 自己検証は最後に画像シリーズへ戻すので、**利用者と同じ操作**（ツリーの動画シリーズをクリック）で
    // もう一度開いて、実際に再生されている画を残す。
    const videoNode = viewerPage.locator(".node.series", { hasText: "🎞" }).first();
    if ((await videoNode.count()) > 0) {
      await videoNode.click();
      await viewerPage.waitForTimeout(800);
      const playing = await viewerPage.evaluate(`
        (function () {
          var v = document.querySelector("#video-player");
          var grid = document.querySelector("#grid");
          if (!v) return { ok: false };
          v.play();
          return new Promise(function (res) {
            setTimeout(function () {
              // ⚠ hidden 属性ではなく**見えている大きさ**で判定する（display 指定は hidden を上書きする）。
              var vr = v.getBoundingClientRect();
              var gr = grid.getBoundingClientRect();
              res({
                ok: true, currentTime: v.currentTime, paused: v.paused, readyState: v.readyState,
                videoBox: Math.round(vr.width) + "x" + Math.round(vr.height),
                gridVisible: gr.height > 1,
              });
            }, 1200);
          });
        })()
      `) as { ok: boolean; currentTime?: number; paused?: boolean; readyState?: number; videoBox?: string; gridVisible?: boolean };
      console.log(`クリックで開いた動画: ${JSON.stringify(playing)}`);
      check(
        playing.ok && (playing.currentTime ?? 0) > 0 && (playing.readyState ?? 0) >= 2,
        "ツリーから選んで実際に再生が進む",
        playing,
      );
      check(
        playing.gridVisible === false && !/^0x|x0$/.test(playing.videoBox ?? "0x0"),
        "動画が画面に出ている（画像タイルは消えている）",
        playing,
      );
      await viewerPage.screenshot({ path: path.join(OUT_DIR, "2-video-playing.png") }).catch(() => {});
    }

    console.log(`404: ${JSON.stringify(notFound)}`);
    // favicon の 404 は媒体に favicon を置いていないだけで、動作に影響しない。
    const missing = notFound.filter((u) => !/favicon/i.test(u));
    check(missing.length === 0, "存在しないリソースを要求していない（favicon 除く）", missing.slice(0, 3));
    const bad = consoleErrors.filter(
      (m) => !/DevTools|Autofill|favicon/i.test(m) && !(missing.length === 0 && /404 \(Not Found\)/.test(m)),
    );
    check(bad.length === 0, "コンソールに未処理エラーが出ない", bad.slice(0, 3));
  } finally {
    await viewerPage?.close().catch(() => {});
    await browser?.close().catch(() => {});
    server?.close();
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。媒体: ${MEDIA_DIR}`);
  } else {
    console.log(`${passed} 項目 OK / FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
