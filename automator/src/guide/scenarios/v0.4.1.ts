/*
 * v0.4.1 操作ガイド: DB フォルダの切り替えと、検査のコピー・移動。あわせて 2D・MPR の細かな改良。
 *
 * DB フォルダはデスクトップ版だけの機能で、データの置き場（Electron の CWD）に `db-folders.json` を持つ。
 * 撮影では、利用者の開発用データに触れないよう、automator/.results/guide-v0.4.1 を置き場にしてデスクトップ版を起動し、
 * backend も main に起動させる（DB フォルダの引数は main が付けるため）。
 * - データ: HCC_001 の #2 PRE LIVER（他のガイドと同じ。GRAPHY_GUIDE_DATA の下の HCC_001）
 * - 画面に出るパスは、置き場より上を「…」にしてから撮る（公開する資料にマシンのパスを写さない）
 * 本文は docs/release-guides/v0.4.1/guide.html。番号の順はそちらの説明の順と合わせる。
 */
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { _electron as electron, type ElectronApplication, type Page } from "@playwright/test";

import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { Scenario } from "../run.js";

const REPO = path.resolve(AUTOMATOR_ROOT, "..");
const DESKTOP_DIR = path.join(REPO, "desktop");
const FRONTEND_DIR = path.join(REPO, "frontend");
const ROOT = path.join(AUTOMATOR_ROOT, ".results", "guide-v0.4.1");
const APP_DIR = path.join(ROOT, "app");
const OTHER_DB = path.join(ROOT, "DB-研究用");
const DATA_DIR = process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples");
// web の撮影（run.ts）と同時に動くので、ポートを変える
const PORT = 18710;
const VITE_PORT = 18713;
const SCP_PORT = 18711;

async function fit(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

/** 置き場より上のパスを「…」にする（画面の文字だけ。データは変えない）。 */
async function hideRootPath(page: Page): Promise<void> {
  await page.evaluate((root) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.textContent?.includes(root)) n.textContent = n.textContent.split(root).join("…");
    }
  }, ROOT);
}

async function waitHttp(url: string, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* 起動待ち */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`応答がありません: ${url}`);
}

async function findWindow(app: ElectronApplication, pred: (url: string) => boolean, timeoutMs: number): Promise<Page> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const w = app.windows().find((x) => pred(x.url()));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("窓が見つかりません");
}

/** 画像の上をドラッグする（ROI を描く）。座標は canvas の左上から。 */
async function drag(page: Page, from: [number, number], d: [number, number]): Promise<void> {
  await page.evaluate(([f, d]) => {
    const canvas = document.querySelector('[data-testid="viewer2d-canvas-host"] canvas') as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    // tsx が内側の名前付き関数に __name を差し込み、ページ側で落ちるので、関数を作らずに並べて送る
    const seq: [string, number, number, number][] = [["pointermove", f[0], f[1], 0], ["pointerdown", f[0], f[1], 1]];
    for (let i = 1; i <= 12; i++) seq.push(["pointermove", f[0] + (d[0] * i) / 12, f[1] + (d[1] * i) / 12, 1]);
    seq.push(["pointerup", f[0] + d[0], f[1] + d[1], 0]);
    for (const [type, x, y, b] of seq) {
      const c = { bubbles: true, cancelable: true, composed: true, clientX: r.left + x, clientY: r.top + y, button: 0, buttons: b };
      canvas.dispatchEvent(new PointerEvent(type, { ...c, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), c));
    }
  }, [from, d] as const);
  await page.waitForTimeout(600);
}

async function menu(page: Page, top: string, item: string): Promise<void> {
  await page.getByTestId(`viewer2d-menu-${top}`).click();
  await page.getByRole("button", { name: item, exact: true }).first().click();
  await page.waitForTimeout(500);
}

function prepareDataDir(): void {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(APP_DIR, { recursive: true });
  // もう 1 つの DB フォルダ（例: 研究用）。画面の「新規 DB フォルダ…」で作るものと同じ目印を置く。
  fs.mkdirSync(OTHER_DB, { recursive: true });
  fs.writeFileSync(
    path.join(OTHER_DB, "graphy-db.json"),
    JSON.stringify({ formatVersion: 1, dbId: crypto.randomUUID(), createdAt: new Date().toISOString() }, null, 2),
  );
  fs.writeFileSync(path.join(APP_DIR, "db-folders.json"), JSON.stringify({ current: null, recent: [OTHER_DB] }, null, 2));
  fs.writeFileSync(path.join(APP_DIR, "settings.json"), JSON.stringify({ "dicom.localAePort": String(SCP_PORT) }, null, 2));
}

const scenario: Scenario = async ({ shot }) => {
  prepareDataDir();
  let vite: ChildProcess | null = null;
  let app: ElectronApplication | null = null;
  try {
    vite = spawn("npm", ["run", "dev", "--", "--port", String(VITE_PORT), "--strictPort"], {
      cwd: FRONTEND_DIR,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, VITE_BACKEND_URL: `http://localhost:${PORT}` },
    });
    await waitHttp(`http://localhost:${VITE_PORT}/`, 60_000);

    const electronPath = createRequire(path.join(DESKTOP_DIR, "package.json"))("electron") as unknown as string;
    app = await electron.launch({
      executablePath: electronPath,
      args: [DESKTOP_DIR, "--no-sandbox"],
      cwd: APP_DIR,
      env: {
        ...process.env,
        GRAPHY_DEV: "1",
        GRAPHY_BACKEND_PORT: String(PORT),
        GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE_PORT}`,
      },
    });
    const main = await findWindow(app, (u) => u.startsWith(`http://localhost:${VITE_PORT}`) && !u.includes("#"), 120_000);
    await waitHttp(`http://localhost:${PORT}/api/status`, 180_000);
    await main.evaluate(() => localStorage.setItem("graphy.locale", "ja"));
    await main.reload();
    await main.waitForTimeout(3_000);
    main.on("dialog", (d) => void d.accept());
    const imported = await main.evaluate(async ([port, dir]) => {
      const r = await fetch(`http://localhost:${port}/api/import/paths`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: [dir] }),
      });
      return r.json();
    }, [PORT, path.join(DATA_DIR, "HCC_001")] as const);
    console.log(`desktop 取り込み: ${JSON.stringify(imported)}`);
    await main.reload();
    await main.waitForTimeout(3_000);
    await fit(main);

    // 1. 環境設定 ＞ データ管理 ＞ DB フォルダ
    await main.getByTestId("mainscreen-menu-system").click();
    await main.getByTestId("menu-item-settings").click();
    await main.getByTestId("settings-cat-data").click();
    const panel = main.getByTestId("db-folder-panel");
    await panel.waitFor({ timeout: 20_000 });
    await panel.scrollIntoViewIfNeeded();
    await main.waitForTimeout(800);
    await hideRootPath(main);
    const rows = main.getByTestId("db-folder-row");
    await shot(main, "dbfolders", [
      { at: rows.nth(0), side: "left" },
      { at: rows.nth(1), side: "left" },
      { at: main.getByRole("button", { name: "新規 DB フォルダ…" }), side: "left" },
      main.getByRole("button", { name: "DB フォルダを開く…" }),
    ]);
    await main.getByTestId("dialog-close-button").click();

    // 2. DB テーブル管理 ＞ 検査の「別の DB へ…」
    await main.getByRole("button", { name: /DB テーブル管理/ }).first().click();
    await main.getByTestId("dbadmin-search-input").fill("HCC");
    await main.getByTestId("dbadmin-search-input").press("Enter");
    await main.getByTestId("dbadmin-patient-expand-HCC_001").click();
    await main.waitForTimeout(800);
    const transferBtn = main.getByRole("button", { name: "別の DB へ…" }).first();
    await transferBtn.click();
    const dlg = main.getByTestId("db-transfer-dialog");
    await dlg.waitFor({ timeout: 10_000 });
    await dlg.locator('input[name="db-target"]').first().check();
    await main.waitForTimeout(500);
    await hideRootPath(main);
    await shot(main, "transfer", [
      { at: dlg.locator("label").filter({ has: main.locator('input[name="db-target"]') }).first(), side: "left" },
      { at: dlg.locator("label").filter({ has: main.locator('input[name="db-mode"]') }).first(), side: "left" },
      dlg.getByRole("button", { name: "コピーする" }),
    ]);
    await dlg.getByRole("button", { name: "閉じる" }).click();
    await main.keyboard.press("Escape");
    await main.waitForTimeout(500);
    await main.reload();
    await main.waitForTimeout(3_000);
    await fit(main);

    // 3. 2D ビューア: Cobb 角・ROI のロック・画像のコピー
    await main.getByTestId("search-patientid-input").fill("HCC_001");
    await main.getByTestId("search-allperiod-chip").click();
    await main.getByTestId("search-submit-button").click();
    await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
    await main.locator('[data-testid^="series-row-"]', { hasText: "PRE LIVER" }).first().click({ timeout: 20_000 });
    const viewerWait = app.waitForEvent("window", { timeout: 30_000 });
    await main.getByTestId("viewer2d-toolbar-button").click();
    const viewer = await viewerWait;
    viewer.on("dialog", (d) => void d.accept());
    await viewer.getByTestId("viewer2d-canvas-host").first().waitFor({ timeout: 60_000 });
    await fit(viewer);
    await viewer.waitForTimeout(4_000);
    const box = await viewer.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
    if (!box) throw new Error("2D の画像がありません");
    // 椎体の上下に 2 本の線（Cobb 角）と、肝臓に矩形 ROI
    await menu(viewer, "roi", "Cobb 角");
    await drag(viewer, [box.width * 0.49, box.height * 0.57], [55, -6]);
    await drag(viewer, [box.width * 0.49, box.height * 0.72], [55, 10]);
    await viewer.keyboard.press("Escape");
    await menu(viewer, "roi", "矩形 ROI");
    await drag(viewer, [box.width * 0.37, box.height * 0.3], [40, 40]);
    await viewer.keyboard.press("Escape");
    await menu(viewer, "roiTools", "ROI マネージャ");
    await viewer.waitForTimeout(800);
    const lock = viewer.locator('[data-testid="roi-mgr-row"]').nth(1).getByTestId("roi-mgr-lock");
    await lock.click();
    await viewer.waitForTimeout(800);
    await shot(viewer, "roi", [
      viewer.getByTestId("viewer2d-menu-roi"),
      { at: lock, side: "left" },
      viewer.getByTestId("tile-copy-image").first(),
    ]);

    // 5. ROI 計測結果の「⬇ 画素」（矩形 ROI）
    await viewer.getByTestId("roi-mgr-lock").nth(1).waitFor();
    await viewer.locator('[data-testid="roi-mgr-row"]').nth(1).getByRole("button", { name: "Σ", exact: true }).click();
    const statsDlg = viewer.getByTestId("roi-stats-dialog");
    await statsDlg.waitFor({ timeout: 30_000 });
    await viewer.waitForTimeout(2_500);
    await shot(viewer, "pixeldump", [
      { at: viewer.getByTestId("roi-stats-dump"), side: "top" },
      { at: statsDlg.locator("tbody tr").nth(1), side: "left" },
    ]);
    await statsDlg.getByTitle("閉じる").click();
    await viewer.waitForTimeout(500);

    // 6. 2D Wand: 絶対値のしきい値（範囲）
    // 肝臓が大きく写る Z 32 まで送る（先頭のスライスは骨盤寄りで肝臓が無い）
    await viewer.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let k = 0; k < 31; k++) {
      await viewer.mouse.wheel(0, 100);
      await viewer.waitForTimeout(250);
    }
    await viewer.waitForTimeout(1_000);
    await menu(viewer, "roiTools", "2D Wand（輝度領域成長）");
    // fit() の寸法の上書きで、cornerstone は画面上の位置を 2 倍の大きさの座標として読む（canvas は CSS の 2 倍の画素）。
    // 画面で肝臓が見えている位置（590, 335）を押すには、canvas の左上からの距離を 2 倍にした所を押す。
    const cvBox = await viewer.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
    if (!cvBox) throw new Error("2D の画像がありません");
    await viewer.mouse.click(cvBox.x + 2 * (590 - cvBox.x), cvBox.y + 2 * (335 - cvBox.y));
    await viewer.getByTestId("wand-method-range").waitFor({ timeout: 60_000 });
    await viewer.getByTestId("wand-method-range").click();
    await viewer.waitForTimeout(1_500);
    for (const [id, v] of [["wand-threshold-lower", "40"], ["wand-threshold-upper", "200"]] as const) {
      const f = viewer.getByTestId(id);
      await f.fill(v);
      await f.press("Enter");
      await viewer.waitForTimeout(2_000);
    }
    const count = await viewer.getByTestId("wand-count").innerText();
    console.log(`wand-count: ${count}`);
    await shot(viewer, "wand", [
      { at: viewer.getByTestId("wand-method-range"), side: "left" },
      { at: viewer.getByTestId("wand-threshold-lower"), side: "left" },
      { at: viewer.getByTestId("wand-threshold-upper"), side: "left" },
      { at: viewer.getByTestId("wand-count"), side: "left" },
    ]);
    await viewer.getByTestId("wand-commit").click();
    await viewer.waitForTimeout(2_000);

    // 7. ROI マネージャの 3D 統計（Wand で作ったマスク）
    // ROI マネージャは「roi」の撮影から開いたまま
    const run = viewer.getByTestId("mask-stats-run").first();
    await run.waitFor({ timeout: 20_000 });
    await run.click();
    await viewer.getByTestId("mask-stats").first().waitFor({ timeout: 120_000 });
    await viewer.waitForTimeout(800);
    await shot(viewer, "maskstats", [
      { at: run, side: "left" },
      { at: viewer.getByTestId("mask-stats").first(), side: "left" },
    ]);

    // 8. リサンプル・切り抜き
    await menu(viewer, "image", "リサンプル・切り抜き…");
    await viewer.getByTestId("resample-dialog").waitFor({ timeout: 10_000 });
    await viewer.getByTestId("resample-output").filter({ hasText: "出力" }).waitFor({ timeout: 120_000 });
    await viewer.waitForTimeout(800);
    console.log(`resample-source: ${await viewer.getByTestId("resample-source").innerText()}`);
    console.log(`resample-output: ${await viewer.getByTestId("resample-output").innerText()}`);
    await shot(viewer, "resample", [
      { at: viewer.getByTestId("resample-source"), side: "left" },
      { at: viewer.getByTestId("resample-kind-iso").locator(".."), side: "left" },
      { at: viewer.getByTestId("resample-output"), side: "left" },
    ]);
    await viewer.getByTestId("resample-close").click();

    // 拡大レンズは撮らない: 撮影用に画面の寸法を上書きすると、レンズが押した所からずれて写る
    // （上書き無しの普段の画面では押した所に 4 倍で出ることを確かめている）。本文の表で説明する。
    await viewer.close();

    // 4. MPR の十字線
    const mprWait = app.waitForEvent("window", { timeout: 30_000 });
    await main.locator('button[title="MPR Viewer"]').click();
    const mpr = await mprWait;
    mpr.on("dialog", (d) => void d.accept());
    await mpr.waitForTimeout(15_000);
    await fit(mpr);
    await mpr.waitForTimeout(2_000);
    await shot(mpr, "mpr", []);
    await mpr.close();
  } finally {
    await app?.close().catch(() => undefined);
    if (vite?.pid) {
      try {
        process.kill(-vite.pid, "SIGTERM");
      } catch {
        /* 既に終わっている */
      }
    }
  }
};

export default scenario;
