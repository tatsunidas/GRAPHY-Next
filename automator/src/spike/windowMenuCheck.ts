/*
 * Window メニュー（フルスクリーン・最大化・最小化・元に戻す）と F11 の実機検証（本物の Electron ＋ backend jar）。
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （この作業コピーの jar）
 *        cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *          npx tsx src/spike/windowMenuCheck.ts
 * ⚠ 実画面（WM のある X11/Wayland）で窓を動かす。フルスクリーンの検査は WM が要るので Xvfb 単体では確かめられない。
 *
 * 確かめること（数値は main の BrowserWindow、画面は renderer のスクリーンショット .results/window-menu-check）:
 *   [1] メインの Window メニューが開き、通常の大きさでは「元に戻す」だけ無効（画面）
 *   [2] 最大化 → 元に戻す: bounds が作業領域より小さくなる
 *   [3] メニューのフルスクリーン: bounds が画面全体（作業領域でなくディスプレイ全体）
 *   [4] F11: 抜ける → もう一度で入る（キーを消費して二重に切り替わらない）
 *   [5] 最大化 → フルスクリーン → 元に戻す: 通常の大きさまで戻る
 *   [6] 最小化（isMinimized）→ main から復帰
 *   [7] 2D・3D ビューア窓にも Window メニューがあり、F11 が効く
 *   [8] 状態が window-state.dev.json に保存される（フルスクリーン・最大化・通常）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";

const { check, summary } = createChecker();
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "window-menu-check", `run-${Date.now()}`); // 実行ごとの新しい出力先（古い画像と混ざらない）
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WinInfo {
  found: boolean;
  maximized: boolean;
  fullscreen: boolean;
  minimized: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  display: { width: number; height: number };
  workArea: { width: number; height: number };
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  const origin = `http://localhost:${driver.ports.vite}`;
  try {
    await driver.start();
    const app = driver.app;
    const page = driver.page;
    await page.waitForSelector('[data-testid="mainscreen-menu-window"]', { timeout: 30_000 });

    // hash 付きでない（＝メイン）か、指定の hash を持つ窓の状態を main から読む
    const info = (hash: string | null): Promise<WinInfo> =>
      app.evaluate(
        ({ BrowserWindow, screen }, { origin, hash }) => {
          type W = { webContents: { getURL(): string } };
          const w = BrowserWindow.getAllWindows().find((x: W) => {
            const u = x.webContents.getURL();
            if (!u.startsWith(origin)) return false;
            return hash === null ? !u.includes("#") || u.endsWith("#") : u.includes(`#${hash}`);
          });
          const d = screen.getPrimaryDisplay();
          const empty = { found: false, maximized: false, fullscreen: false, minimized: false, bounds: { x: 0, y: 0, width: 0, height: 0 } };
          const base = { display: { width: d.bounds.width, height: d.bounds.height }, workArea: { width: d.workArea.width, height: d.workArea.height } };
          if (!w) return { ...empty, ...base };
          return { found: true, maximized: w.isMaximized(), fullscreen: w.isFullScreen(), minimized: w.isMinimized(), bounds: w.getBounds(), ...base };
        },
        { origin, hash },
      );
    const until = async (what: string, hash: string | null, pred: (i: WinInfo) => boolean, ms = 6000): Promise<WinInfo> => {
      const end = Date.now() + ms;
      let i = await info(hash);
      while (!pred(i) && Date.now() < end) {
        await sleep(150);
        i = await info(hash);
      }
      if (!pred(i)) console.log(`   (待っても揃わなかった: ${what}) ${JSON.stringify(i)}`);
      return i;
    };
    // F11 は Playwright の合成キー（CDP）でなく、OS の実キー（xdotool）で送る。before-input-event は OS 由来の入力に反応する。
    // 窓を前面にしてから押す（xdotool は今フォーカスのある窓へ送る）。
    const focusWin = (hash: string | null) =>
      app.evaluate(
        ({ BrowserWindow }, { origin, hash }) => {
          type W = { webContents: { getURL(): string }; show(): void; focus(): void };
          const w = BrowserWindow.getAllWindows().find((x: W) => {
            const u = x.webContents.getURL();
            if (!u.startsWith(origin)) return false;
            return hash === null ? !u.includes("#") || u.endsWith("#") : u.includes(`#${hash}`);
          });
          if (w) { w.show(); w.focus(); }
        },
        { origin, hash },
      );
    const pressF11 = async (hash: string | null) => {
      await focusWin(hash);
      await sleep(700);
      execFileSync("xdotool", ["key", "--clearmodifiers", "F11"]);
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    const menu = async (p: Page, menuId: string, itemId: string) => {
      await p.click(`[data-testid="${menuId}"]`);
      await p.click(`[data-testid="${itemId}"]`);
    };
    const MAIN_MENU = "mainscreen-menu-window";

    // 起動直後の状態を揃える。前回の保存（フルスクリーン・最大化・通常）が復元されて始まるので、
    // いったん通常に戻してから最大化する（driver は最大化して起動する想定）。
    await app.evaluate(({ BrowserWindow }, o) => {
      type W = { webContents: { getURL(): string }; isFullScreen(): boolean; setFullScreen(b: boolean): void; maximize(): void };
      const w = BrowserWindow.getAllWindows().find((x: W) => x.webContents.getURL().startsWith(o) && !x.webContents.getURL().includes("#"));
      if (w) { if (w.isFullScreen()) w.setFullScreen(false); w.maximize(); }
    }, origin);
    let i = await until("起動時に最大化", null, (x) => x.maximized && !x.fullscreen, 10_000);
    console.log(`[0] 起動時: ${JSON.stringify(i)}`);
    check(i.found && i.maximized, "[0] 起動時は最大化（driver の既定）。ここから操作する", i);

    // 起動の数秒後に「新しい版があります」が出て、メニューのクリックを遮る（この作業コピーは公開版より古い）。閉じる（更新はしない）
    const dismissUpdate = async (p: Page) => {
      try {
        await p.waitForSelector('[data-testid="update-dialog"]', { timeout: 10_000 });
        await p.click('[data-testid="update-later"]');
        await p.waitForSelector('[data-testid="update-dialog"]', { state: "detached", timeout: 5_000 });
        console.log("   (更新ダイアログを閉じた)");
      } catch {
        /* 出なければそのまま */
      }
    };
    await dismissUpdate(page);
    await shot(page, "00-start");
    // [1] メニュー
    await page.click(`[data-testid="${MAIN_MENU}"]`);
    // tsx（esbuild）が評価する関数に __name を差し込むので、ブラウザ側へは文字列の式で渡す
    const dis = (await page.evaluate(
      `Object.fromEntries(["fullscreen","maximize","minimize","restore"].map(function (id) {
         var b = document.querySelector('[data-testid="menu-item-window-' + id + '"]');
         return [id, b ? b.disabled : null];
       }))`,
    )) as Record<string, boolean | null>;
    await shot(page, "01-window-menu-maximized");
    check(dis.maximize === true && dis.restore === false && dis.fullscreen === false && dis.minimize === false,
      "[1] 最大化中のメニュー: 最大化は無効、元に戻す・フルスクリーン・最小化は有効", dis);
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5); // メニューを閉じる

    // [2] 元に戻す（最大化 → 通常）
    await menu(page, MAIN_MENU, "menu-item-window-restore");
    i = await until("通常の大きさ", null, (x) => !x.maximized && !x.fullscreen);
    console.log(`[2] 元に戻す: ${JSON.stringify(i)}`);
    check(!i.maximized && !i.fullscreen && i.bounds.width < i.workArea.width && i.bounds.height < i.workArea.height,
      "[2] 元に戻す: 最大化が外れ、作業領域より小さい", i);
    await page.click(`[data-testid="${MAIN_MENU}"]`);
    const dis2 = await page.evaluate(() => (document.querySelector('[data-testid="menu-item-window-restore"]') as HTMLButtonElement).disabled);
    await shot(page, "02-window-menu-normal");
    check(dis2 === true, "[2] 通常の大きさでは「元に戻す」が無効", dis2);
    await page.mouse.click(5, 5);

    // [3] フルスクリーン（メニュー）
    await menu(page, MAIN_MENU, "menu-item-window-fullscreen");
    i = await until("フルスクリーン", null, (x) => x.fullscreen);
    await sleep(600);
    i = await info(null);
    console.log(`[3] フルスクリーン: ${JSON.stringify(i)}`);
    check(i.fullscreen && i.bounds.width === i.display.width && i.bounds.height === i.display.height,
      "[3] フルスクリーン: bounds が画面全体（作業領域ではなくディスプレイ全体）", i);
    await shot(page, "03-fullscreen");

    // [4] F11（OS の実キー）: 抜ける → もう一度で入る
    await pressF11(null);
    i = await until("F11 で抜ける", null, (x) => !x.fullscreen);
    check(!i.fullscreen, "[4] F11 でフルスクリーンから抜ける", i);
    await sleep(1200);
    check(!(await info(null)).fullscreen, "[4] 抜けたまま（既定メニューの F11 と二重に切り替わって戻っていない）");
    await pressF11(null);
    i = await until("F11 で入る", null, (x) => x.fullscreen);
    check(i.fullscreen, "[4] もう一度 F11 で入る", i);
    await sleep(1200);
    check((await info(null)).fullscreen, "[4] 入ったまま（二重に切り替わっていない）");
    await pressF11(null);
    await until("F11 で抜ける", null, (x) => !x.fullscreen);

    // [5] 最大化 → フルスクリーン → 元に戻す
    i = await info(null);
    if (i.fullscreen || i.maximized) await menu(page, MAIN_MENU, "menu-item-window-restore"); // [4] のあとは通常のはず
    i = await until("通常へ", null, (x) => !x.fullscreen && !x.maximized);
    await menu(page, MAIN_MENU, "menu-item-window-maximize");
    i = await until("最大化", null, (x) => x.maximized && !x.fullscreen);
    check(i.maximized && !i.fullscreen, "[5] 通常の最大化（フルスクリーンではない）", i);
    await shot(page, "05-maximized");
    await menu(page, MAIN_MENU, "menu-item-window-fullscreen");
    i = await until("最大化からフルスクリーン", null, (x) => x.fullscreen);
    await sleep(500);
    await menu(page, MAIN_MENU, "menu-item-window-restore");
    i = await until("通常へ戻る", null, (x) => !x.fullscreen && !x.maximized, 8000);
    await sleep(500);
    i = await info(null);
    console.log(`[5] 最大化→フルスクリーン→元に戻す: ${JSON.stringify(i)}`);
    check(!i.fullscreen && !i.maximized && i.bounds.width < i.workArea.width,
      "[5] 最大化してからフルスクリーンにしても、元に戻すで通常の大きさまで戻る", i);

    // [6] 最小化
    await menu(page, MAIN_MENU, "menu-item-window-minimize");
    i = await until("最小化", null, (x) => x.minimized);
    check(i.minimized, "[6] 最小化（isMinimized）", i);
    await app.evaluate(({ BrowserWindow }, o) => {
      BrowserWindow.getAllWindows().find((w: { webContents: { getURL(): string } }) => w.webContents.getURL().startsWith(o))?.restore();
    }, origin);
    i = await until("復帰", null, (x) => !x.minimized);
    check(!i.minimized, "[6] 最小化から復帰できる", i);

    // [7] ビューア窓（メニューバーは検査を開いてから出るので、検査を取り込んで本物のボタンから開く）
    const fixtureDir = path.join(os.homedir(), "graphy-workspace", "GRAPHY-Next", "automator", "fixtures", "ct-basic");
    const files = fs.readdirSync(fixtureDir).filter((f) => f.endsWith(".dcm")).map((f) => path.join(fixtureDir, f));
    check(files.length > 10, "[7] 取り込む CT の検査用データがある", files.length);
    const imp = await importPaths(driver.ports.http, files);
    check(imp.imported > 0, "[7] 検査を取り込めた", imp);
    await page.reload();
    await waitForMainScreenReady(page, 60_000);
    await dismissUpdate(page);
    await page.getByTestId("search-allperiod-chip").click();
    await page.getByTestId("search-submit-button").click();
    await page.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
    await page.locator('[data-testid^="series-row-"]').first().click({ timeout: 20_000 });
    for (const [button, hash, menuId] of [["2D Viewer", "2dviewer", "viewer2d-menu-window"], ["3D Viewer", "viewer3d", "viewer3d-menu-window"]] as const) {
      const vp = await driver.waitForNewPage(
        () => page.locator(`button[title="${button}"]`).click(),
        (u) => u.includes(`#${hash}`),
      );
      check(!!vp, `[7] ${button} の窓が開く`);
      let has = false;
      try {
        await vp.waitForSelector(`[data-testid="${menuId}"]`, { timeout: 60_000 });
        has = true;
      } catch {
        /* 下の check で FAIL にする */
      }
      check(has, `[7] ${button} に Window メニューがある`);
      if (!has) { await shot(vp, `07-${hash}-nomenu`); continue; }
      await sleep(2500);
      await vp.click(`[data-testid="${menuId}"]`);
      await shot(vp, `07-${hash}-window-menu`);
      await vp.click('[data-testid="menu-item-window-restore"]'); // 最大化から通常へ（driver が最大化している）
      let v = await until(`${button} 通常へ`, hash, (x) => !x.maximized && !x.fullscreen);
      check(!v.maximized && !v.fullscreen, `[7] ${button}: 元に戻す`, v);
      await vp.click(`[data-testid="${menuId}"]`);
      await vp.click('[data-testid="menu-item-window-fullscreen"]');
      v = await until(`${button} フルスクリーン`, hash, (x) => x.fullscreen);
      await sleep(600);
      v = await info(hash);
      check(v.fullscreen && v.bounds.width === v.display.width && v.bounds.height === v.display.height, `[7] ${button}: メニューからフルスクリーン（画面全体）`, v);
      await shot(vp, `07-${hash}-fullscreen`);
      await pressF11(hash);
      v = await until(`${button} F11 で抜ける`, hash, (x) => !x.fullscreen);
      check(!v.fullscreen, `[7] ${button}: F11 で抜ける`, v);
      const m = await info(null);
      check(m.found && !m.fullscreen, `[7] ${button} の操作でメイン窓は変わらない`, m);
      await vp.close().catch(() => undefined);
      await sleep(800);
    }

    // [8] 保存: メインをフルスクリーンにして、保存ファイルに反映される（読むのは dev 保存先）
    await menu(page, MAIN_MENU, "menu-item-window-fullscreen");
    await until("フルスクリーン", null, (x) => x.fullscreen);
    await sleep(800);
    const stateFile = await app.evaluate(({ app: a }) => a.getPath("userData"));
    const f = path.join(stateFile, "window-state.dev.json");
    const saved = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
    console.log(`[8] ${f}: ${JSON.stringify(saved)?.slice(0, 300)}`);
    check(!!saved, "[8] window-state.dev.json が書かれている", f);
    check(saved?.windows?.main?.isFullScreen === true, "[8] メイン窓のフルスクリーンが保存される", saved?.windows?.main);
    // 後始末を兼ねる: 元に戻して、通常の大きさが保存されること（次の起動をフルスクリーンで始めない）
    await menu(page, MAIN_MENU, "menu-item-window-restore");
    await until("通常へ", null, (x) => !x.fullscreen && !x.maximized, 8000);
    await sleep(1000);
    const saved2 = JSON.parse(fs.readFileSync(f, "utf8"));
    check(saved2?.windows?.main?.isFullScreen === false && saved2?.windows?.main?.isMaximized === false, "[8] 元に戻すと、通常の大きさが保存される", saved2?.windows?.main);
    void DESKTOP_RUN_DATA_DIR;
  } finally {
    await driver.stop().catch(() => undefined);
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
