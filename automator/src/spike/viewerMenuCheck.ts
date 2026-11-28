/*
 * 別窓（アシスタントなど）のメニューの実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/viewerMenuCheck.ts   （Linux・X11。xdotool と ffmpeg が要る）
 *
 * 別窓に Electron の既定メニューが付いていると、［File］→［Quit］（Ctrl+Q）で本体ごと終了する。
 * メニューのショートカットは OS のキー入力でしか動かないので、xdotool で実際のキーを送る。
 *   1. アシスタントの窓に Ctrl+Q → 何も起きない（本体もアシスタントも残る）
 *   2. アシスタントの窓に Ctrl+W → その窓だけ閉じる（本体は残る）
 *   3. メインの窓に Ctrl+Q → 本体が終了する（キーが効いていることの確認。メインの窓は既定メニューのまま）
 * 途中でアシスタントの窓のメニューバーを撮る（.results/viewer-menu-check/。既定メニューにある Help が無いことを目で見る）。
 * ［File］を開いた中身は撮れていない（キーで開いた画面が写らなかった）。中身は Ctrl+Q・Ctrl+W の動きで確かめる。
 * 🔴 キーを送る間、対象の窓を前面に出す。実行中はキーボードに触らない。
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "viewer-menu-check");
const PORTS = { http: 19340, scp: 19341, vite: 19343 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WinInfo { xid: string; bounds: { x: number; y: number; width: number; height: number } }

async function main() {
  if (process.platform !== "linux" || process.env.XDG_SESSION_TYPE !== "x11") {
    console.log("Linux の X11 でだけ実行できます（xdotool で実際のキーを送るため）");
    process.exit(2);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver(PORTS);
  let closed = false;
  try {
    await driver.start();
    driver.app.on("close", () => { closed = true; });
    const mainPage = driver.page;

    /** url に needle を含む窓（DevTools は除く）の X11 の窓 ID と位置。無ければ null。 */
    const winInfo = (needle: string): Promise<WinInfo | null> =>
      driver.app.evaluate(({ BrowserWindow }, n) => {
        for (const w of BrowserWindow.getAllWindows()) {
          if (w.isDestroyed()) continue;
          const url = w.webContents.getURL();
          if (url.startsWith("devtools://")) continue;
          if (n === "" ? url.includes("#") : !url.includes(n)) continue;
          return { xid: w.getMediaSourceId().split(":")[1], bounds: w.getContentBounds() };
        }
        return null;
      }, needle);
    const sendKey = (xid: string, key: string) => {
      execFileSync("xdotool", ["windowactivate", "--sync", xid]);
      execFileSync("xdotool", ["key", "--clearmodifiers", key]);
    };

    const win = await driver.waitForNewPage(async () => {
      await mainPage.getByTestId("mainscreen-menu-system").evaluate((el) => (el as HTMLElement).click());
      await mainPage.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-input").waitFor({ state: "visible", timeout: 20_000 });
    const assistant = await winInfo("#assistant");
    const mainWin = await winInfo("");
    check(!!assistant && !!mainWin, "アシスタントの窓とメインの窓がある", { assistant, mainWin });
    if (!assistant || !mainWin) throw new Error("窓が見つからない");

    // メニューバーの画面（窓の範囲だけを撮る。メニューバーはコンテンツの上にあるので上へ 40 px 広げる）
    execFileSync("xdotool", ["windowactivate", "--sync", assistant.xid]);
    await sleep(500);
    const b = assistant.bounds;
    const top = Math.max(0, b.y - 40);
    const shot = path.join(OUT_DIR, "assistant-menubar.png");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", `${Math.min(b.width, 600)}x${Math.min(b.height + 40, 300)}`, "-i", `${process.env.DISPLAY}+${b.x},${top}`, "-frames:v", "1", shot]);

    sendKey(assistant.xid, "ctrl+q");
    await sleep(4000);
    check(!closed, "🔴 アシスタントの窓で Ctrl+Q を押しても本体は終了しない");
    if (closed) throw new Error("本体が終了した");
    check((await winInfo("#assistant")) !== null, "アシスタントの窓も残る（Quit の項目が無い）");

    sendKey(assistant.xid, "ctrl+w");
    await sleep(2500);
    check(!closed && (await winInfo("#assistant")) === null, "Ctrl+W でアシスタントの窓だけ閉じる");
    check(!closed && (await winInfo("")) !== null, "メインの窓は残る");

    sendKey(mainWin.xid, "ctrl+q");
    for (let i = 0; i < 40 && !closed; i++) await sleep(500);
    check(closed, "メインの窓の Ctrl+Q は本体を終了する（キーが効いていることの確認）");
  } catch (e) {
    console.log(`  [info] 中断: ${(e as Error).message}`);
  } finally {
    await driver.stop().catch(() => undefined);
  }
  process.exit(summary() > 0 ? 1 : 0);
}

void main();
