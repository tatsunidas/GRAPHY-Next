/*
 * 常駐（閉じてもトレイに残る・ログイン時の起動の窓なし開始）の実アプリ検査。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_HTTP_PORT=19630 GRAPHY_AUTOMATOR_SCP_PORT=19631 GRAPHY_AUTOMATOR_VITE_PORT=19633 \
 *          npx tsx src/spike/trayCheck.ts [--control]
 *        （backend の jar が要る。JDK を PATH に）
 *   --control … 常駐をオンにしない既定の動き。メインの窓を閉じると、アプリが終了すること（今までの動き）を確かめる。
 *
 * 正例（常駐オン）:
 *   - 設定を main に送ると userData/background.json に保存される（メインの窓からだけ受け付ける）
 *   - メインの窓を閉じても、窓は隠れるだけでアプリは終了しない
 *   - 2 つ目の起動（RIS などが実行ファイルを呼ぶ形）で、隠れた窓が前面に戻る
 *   - app.quit()（トレイの［終了］・更新と同じ経路）では隠さずに終了する
 *   - `--hidden` 付きで起動し直すと、メインの窓は出さずに始まる（スプラッシュも残らない）
 * 負例:
 *   - 常駐オフ（既定）で窓を閉じると終了する
 *   - 常駐オフで `--hidden` を付けても窓は出る（戻れなくなるのを防ぐ）
 *   - 不正な設定要求（真偽値でない・未知のキー）は保存されない
 *
 * 範囲外（実際に確かめていない）: トレイのアイコンの表示と［終了］メニューのクリック、OS へのログイン項目の登録
 * （開発版では登録しない）。backend の停止（この検査では backend を外部で動かしている）は、インストール版の起動検査で見る。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { _electron as electron, type ElectronApplication } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const DESKTOP_DIR = path.join(AUTOMATOR_ROOT, "..", "desktop");
const CONTROL = process.argv.includes("--control");
const { check, summary } = createChecker();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface WinInfo { url: string; visible: boolean }

async function windows(app: ElectronApplication): Promise<WinInfo[]> {
  return app.evaluate(({ BrowserWindow }) => {
    const out: { url: string; visible: boolean }[] = [];
    for (const w of BrowserWindow.getAllWindows()) {
      if (w.isDestroyed() || w.webContents.getURL().startsWith("devtools://")) continue;
      out.push({ url: w.webContents.getURL(), visible: w.isVisible() });
    }
    return out;
  });
}

/** メインの窓（Vite のオリジンで、ビューアの #ハッシュ が無いもの）。 */
const isMain = (viteOrigin: string) => (w: WinInfo) => w.url.startsWith(viteOrigin) && !w.url.includes("#");

function exitedWithin(app: ElectronApplication, ms: number): Promise<boolean> {
  const p = app.process();
  if (p.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms);
    p.once("exit", () => { clearTimeout(t); resolve(true); });
  });
}

async function closeMain(app: ElectronApplication, viteOrigin: string): Promise<void> {
  await app.evaluate(({ BrowserWindow }, origin) => {
    for (const w of BrowserWindow.getAllWindows()) {
      const url = w.webContents.getURL();
      if (url.startsWith(origin) && !url.includes("#")) w.close(); // 利用者が窓の × を押したのと同じ（close イベントが出る）
    }
  }, viteOrigin);
}

function secondInstance(userData: string, args: string[], timeoutMs = 25_000): Promise<{ exited: boolean; code: number | null }> {
  const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
  const electronPath = requireFromDesktop("electron") as unknown as string;
  const env: Record<string, string | undefined> = { ...process.env, GRAPHY_DEV: "1", GRAPHY_SINGLE_INSTANCE: "1" };
  delete env.GRAPHY_DEV_DATA_DIR;
  const p = spawn(electronPath, [DESKTOP_DIR, `--user-data-dir=${userData}`, ...args], { env: env as Record<string, string>, stdio: "ignore", detached: true });
  return new Promise((resolve) => {
    const t = setTimeout(() => { try { process.kill(-p.pid!, "SIGKILL"); } catch { /* 既に終わっている */ } resolve({ exited: false, code: null }); }, timeoutMs);
    p.on("exit", (code) => { clearTimeout(t); resolve({ exited: true, code }); });
  });
}

async function main(): Promise<void> {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "graphy-tray-"));
  const driver = new DesktopDriver(undefined, {
    extraEnv: { GRAPHY_SINGLE_INSTANCE: "1" },
    extraElectronArgs: [`--user-data-dir=${userData}`],
  });
  const viteOrigin = `http://localhost:${driver.ports.vite}`;
  const prefsFile = path.join(userData, "background.json");
  const main_ = isMain(viteOrigin);
  let app2: ElectronApplication | null = null;

  try {
    await driver.start();
    const app = driver.app;
    const page = driver.page;
    const get = () => page.evaluate(() => (window as any).graphyDesktop.getBackground());
    const set = (patch: unknown) => page.evaluate((p) => (window as any).graphyDesktop.setBackground(p), patch);

    console.log(`\n[0] 前提${CONTROL ? "（対照: 常駐をオンにしない既定の動き）" : ""}`);
    const st0 = await get();
    check(st0 && st0.keepInTray === false && st0.launchAtLogin === false, "既定は、どちらもオフ", st0);
    check(st0 && st0.loginSupported === false, "開発版では、ログイン時の起動は使えない（OS の起動項目に入れない）", st0);
    check((await windows(app)).some(main_), "メインの窓がある");

    if (CONTROL) {
      console.log("\n[C] 常駐オフ: メインの窓を閉じると、アプリが終了する（今までの動き）");
      await closeMain(app, viteOrigin);
      check(await exitedWithin(app, 20_000), "窓を閉じたら Electron が終了した");
      return;
    }

    console.log("\n[1] 設定を main に送る（負例を先に）");
    const bad1 = await set({ keepInTray: "true" });
    const bad2 = await set({ somethingElse: true });
    check(bad1.ok === false && bad2.ok === false, "真偽値でない値・未知のキーは受け付けない", [bad1, bad2]);
    check(!fs.existsSync(prefsFile), "不正な要求では、何も保存されない");
    const ok = await set({ keepInTray: true });
    check(ok.ok === true && ok.state.keepInTray === true, "keepInTray=true を受け付けた", ok);
    const saved = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
    check(saved.keepInTray === true && saved.launchAtLogin === false, "userData/background.json に保存された", saved);

    console.log("\n[2] メインの窓を閉じても、窓が隠れるだけでアプリは終了しない");
    await closeMain(app, viteOrigin);
    await sleep(3000);
    const w2 = await windows(app);
    check(w2.some(main_), "メインの窓は壊れずに残っている", w2);
    check(w2.find(main_)?.visible === false, "メインの窓は隠れている", w2);
    check(app.process().exitCode === null, "Electron は動き続けている");

    console.log("\n[3] 2 つ目の起動で、隠れた窓が前面に戻る");
    const s = await secondInstance(userData, []);
    check(s.exited && s.code === 0, "2 つ目の起動は終了する", s);
    await sleep(1500);
    check(!!(await windows(app)).find(main_)?.visible, "メインの窓が再び表示された", await windows(app));

    console.log("\n[4] app.quit()（トレイの［終了］・更新と同じ経路）では、隠さずに終了する");
    await closeMain(app, viteOrigin);
    await sleep(1500);
    check((await windows(app)).find(main_)?.visible === false, "いったん隠した");
    await app.evaluate(({ app: a }) => a.quit());
    check(await exitedWithin(app, 20_000), "app.quit() で終了した（窓の close に止められない）");

    console.log("\n[5] --hidden 付きで起動し直すと、メインの窓を出さずに始まる");
    const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
    const electronPath = requireFromDesktop("electron") as unknown as string;
    const launchHidden = async (extra: string[]): Promise<ElectronApplication> => {
      const env: Record<string, string | undefined> = {
        ...process.env,
        GRAPHY_DEV: "1",
        GRAPHY_SINGLE_INSTANCE: "1",
        GRAPHY_BACKEND_EXTERNAL: "1",
        GRAPHY_BACKEND_PORT: String(driver.ports.http),
        GRAPHY_DEV_SERVER_URL: viteOrigin,
      };
      delete env.GRAPHY_DEV_DATA_DIR;
      return electron.launch({ executablePath: electronPath, args: [DESKTOP_DIR, `--user-data-dir=${userData}`, ...extra], cwd: DESKTOP_DIR, env: env as Record<string, string> });
    };
    app2 = await launchHidden(["--hidden"]);
    const t0 = Date.now();
    let w5: WinInfo[] = [];
    while (Date.now() - t0 < 60_000) {
      w5 = await windows(app2);
      if (w5.some(main_)) break;
      await sleep(500);
    }
    await sleep(6000); // 読み込み完了（ready-to-show）まで待つ
    w5 = await windows(app2);
    check(w5.some(main_), "メインの窓は作られている", w5);
    check(w5.find(main_)?.visible === false, "メインの窓は出ていない（トレイから始まる）", w5);
    check(!w5.some((w) => w.url.includes("splash")), "スプラッシュが残っていない", w5);
    const s5 = await secondInstance(userData, []);
    check(s5.exited && s5.code === 0, "2 つ目の起動は終了する", s5);
    await sleep(2000);
    const shown = await app2.evaluate(({ BrowserWindow }, origin) => {
      for (const w of BrowserWindow.getAllWindows()) {
        const url = w.webContents.getURL();
        if (url.startsWith(origin) && !url.includes("#")) return { visible: w.isVisible(), maximized: w.isMaximized() };
      }
      return null;
    }, viteOrigin);
    check(shown?.visible === true, "2 つ目の起動で、隠れていた窓が表示された", shown);
    check(shown?.maximized === true, "前回の最大化の状態が、表示するときに復元された", shown);
    await app2.evaluate(({ app: a }) => a.quit());
    check(await exitedWithin(app2, 20_000), "終了した");
    app2 = null;

    console.log("\n[6] 常駐オフに戻して --hidden を付けても、窓は出る（トレイが無いと戻れないため）");
    fs.writeFileSync(prefsFile, JSON.stringify({ keepInTray: false, launchAtLogin: false }));
    app2 = await launchHidden(["--hidden"]);
    const t1 = Date.now();
    let w6: WinInfo[] = [];
    while (Date.now() - t1 < 60_000) {
      w6 = await windows(app2);
      if (w6.find(main_)?.visible) break;
      await sleep(500);
    }
    check(!!w6.find(main_)?.visible, "窓が表示された", w6);
    await closeMain(app2, viteOrigin);
    check(await exitedWithin(app2, 20_000), "常駐オフなので、窓を閉じると終了する");
    app2 = null;
  } finally {
    if (app2) await app2.close().catch(() => undefined);
    await driver.stop();
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main()
  .then(() => { process.exitCode = summary() === 0 ? 0 : 1; })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
