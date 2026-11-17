/*
 * 安全な終了（File ＞ 終了・メイン窓の ×）の実機検証。本物の Electron が**自分で backend を起動して**、終わるときに止める。
 * （DesktopDriver は backend を外部扱いで別起動するので使えない。外部の backend は終了の流れが触らない設計）
 *
 * 実行:  cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package   （この作業コピーの jar）
 *        cd automator && npx tsx src/spike/safeExitCheck.ts
 * 専用ポート: backend 18190 / DICOM SCP 18191 / Vite 18193 / 実行中ジョブ用の遅い HTTP サーバ 18194。
 * ⚠ 実画面で窓を開閉する。確認ダイアログ（ネイティブ）は main の dialog.showMessageBox を差し替えて、渡された引数を記録し、
 *    指定の答え（0=終了しない / 1=中止して終了）を返す。ダイアログの文言は quitMessages の単体テストと、渡された引数で確かめる。
 *
 *   [1] 何も走っていないとき: Exit → 確認なしで終わる。Electron・backend（java）のプロセスが消え、ポートが空く
 *   [2] 実行中（URL 取り込みが遅い HTTP サーバから受信中）: Exit → 確認が出て、items に urlImport が 1 件。
 *       ［終了しない］なら何も止まらない（窓・backend・ジョブ・接続が生きている）
 *   [3] メイン窓の ×: 同じ確認が出て、［終了しない］なら窓が残る
 *   [3b] app.quit()（Cmd+Q・OS からの終了と同じ経路）でも同じ確認。［終了しない］なら、他の終了処理が走って backend を止めない
 *   [4] 続けて ［中止して終了］: ジョブが中止され（サーバ側の接続が切れる）、全窓が閉じ、backend が止まり、アプリが終わる
 *   [5] ビューア窓が開いていても、× で全部閉じて終わる（何も走っていないとき）
 */
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";

import { createChecker } from "./computeSpikeShared.js";

const { check, summary } = createChecker();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DESKTOP_DIR = path.join(ROOT, "desktop");
const FRONTEND_DIR = path.join(ROOT, "frontend");
const OUT_DIR = path.join(ROOT, "automator", ".results", "safe-exit-check", `run-${Date.now()}`);
const DATA_DIR = path.join(OUT_DIR, "data");
const HTTP = 18190, SCP = 18191, VITE = 18193, SLOW = 18194;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── 遅い HTTP サーバ（URL 取り込みを「実行中」のままにする）
let slowServer: http.Server | null = null;
let slowOpen = 0; // 開いている接続（ソケット）の数
let slowBytes = 0;
function startSlowServer(): Promise<void> {
  return new Promise((resolve) => {
    slowServer = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(50_000_000) });
      const t = setInterval(() => { res.write(Buffer.alloc(1024, 65)); slowBytes += 1024; }, 100);
      res.on("close", () => clearInterval(t));
      req.on("error", () => undefined);
    });
    slowServer.on("connection", (sock) => {
      slowOpen++;
      sock.on("close", () => { slowOpen = Math.max(0, slowOpen - 1); });
      sock.on("error", () => undefined);
    });
    slowServer.listen(SLOW, "127.0.0.1", () => resolve());
  });
}

const portOpen = (port: number, host = "127.0.0.1") => new Promise<boolean>((resolve) => {
  const s = net.connect({ port, host });
  s.once("connect", () => { s.destroy(); resolve(true); });
  s.once("error", () => resolve(false));
});
const pidOnPort = (port: number): number | null => {
  try {
    const out = execFileSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" });
    const m = out.match(/pid=(\d+)/);
    return m ? Number(m[1]) : null;
  } catch { return null; }
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// ── Vite
let vite: ChildProcess | null = null;
async function startVite(): Promise<void> {
  vite = spawn("npm", ["run", "dev", "--", "--port", String(VITE), "--strictPort"], { cwd: FRONTEND_DIR, stdio: "ignore", detached: true });
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    if (await portOpen(VITE, "localhost")) return;
    await sleep(500);
  }
  throw new Error("vite did not start");
}

/** アプリの標準出力（backend の行を含む）を保存し、終了の内訳（backend 停止の最初と最後の時刻）を出す。 */
function dumpLog(l: Launched, name: string, clickedAt: number): void {
  fs.writeFileSync(path.join(OUT_DIR, `${name}.log`), l.log.join("\n"));
  const shut = l.log.filter((x) => /graphy-shutdown|Graceful shutdown|Commencing graceful|Shutting down|Closing JPA|Stopped/i.test(x));
  const ts = (x: string) => x.match(/(\d{4}-\d\d-\d\dT[\d:.]+\+\d\d:\d\d)/)?.[1];
  const first = shut.find((x) => ts(x)), last = [...shut].reverse().find((x) => ts(x));
  const rel = (x?: string) => (x && ts(x) ? `${((Date.parse(ts(x)!) - clickedAt) / 1000).toFixed(1)}s` : "?");
  console.log(`   内訳[${name}]: 終了ボタン→backend 停止の最初の行 ${rel(first)}、→最後の行 ${rel(last)}（行数 ${shut.length}）`);
}

interface Launched { app: ElectronApplication; page: Page; log: string[]; exited: Promise<number | null>; }

async function launch(): Promise<Launched> {
  const requireFromDesktop = createRequire(path.join(DESKTOP_DIR, "package.json"));
  const electronPath = requireFromDesktop("electron") as unknown as string;
  const env: Record<string, string | undefined> = {
    ...process.env,
    GRAPHY_DEV: "1",
    GRAPHY_BACKEND_PORT: String(HTTP),
    GRAPHY_DICOM_SCP_PORT: String(SCP), // Spring の緩い束縛: graphy.dicom.scp.port
    GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE}`,
    GRAPHY_DEV_DATA_DIR: DATA_DIR,
  };
  delete env.GRAPHY_BACKEND_EXTERNAL;
  const app = await electron.launch({ executablePath: electronPath, args: [DESKTOP_DIR], cwd: DESKTOP_DIR, env: env as Record<string, string> });
  const log: string[] = [];
  const proc = app.process();
  proc.stdout?.on("data", (b: Buffer) => log.push(...b.toString().split("\n")));
  proc.stderr?.on("data", (b: Buffer) => log.push(...b.toString().split("\n")));
  const exited = new Promise<number | null>((resolve) => proc.once("exit", (c) => resolve(c)));
  const origin = `http://localhost:${VITE}`;
  let page: Page | null = null;
  const end = Date.now() + 120_000;
  while (!page && Date.now() < end) {
    page = app.windows().find((w) => w.url().startsWith(origin) && !w.url().includes("#")) ?? null;
    if (!page) await sleep(500);
  }
  if (!page) throw new Error("main window not found");
  await page.waitForSelector('[data-testid="mainscreen-menu-file"]', { timeout: 120_000 });
  await dismissUpdate(page);
  return { app, page, log, exited };
}

/**
 * 起動直後のダイアログを閉じる。
 *  - 「利用条件の確認」: 新しいデータフォルダの初回に出る。この検証用の使い捨てデータフォルダ（自分が立てたローカル環境）に限り
 *    「同意して使う」を選ぶ（ユーザーの 2026-10-25 の指示。他のサイトの規約・Cookie・OAuth には使わない）
 *  - 「新しい版があります」: この作業コピーは公開版より古いので出る。メニューのクリックを遮る。［あとで］で閉じる（更新はしない）
 */
async function dismissUpdate(page: Page): Promise<void> {
  try {
    const agree = page.getByRole("button", { name: /^(Agree and continue|同意して使う)$/ });
    await agree.waitFor({ state: "visible", timeout: 8_000 });
    await agree.click();
    await agree.waitFor({ state: "detached", timeout: 5_000 });
  } catch { /* 出なければそのまま */ }
  try {
    await page.waitForSelector('[data-testid="update-dialog"]', { timeout: 15_000 });
    await page.click('[data-testid="update-later"]');
    await page.waitForSelector('[data-testid="update-dialog"]', { state: "detached", timeout: 5_000 });
  } catch { /* 出なければそのまま */ }
}

/** main の dialog.showMessageBox を差し替え、渡された引数をファイルへ記録して、指定の答えを返す。 */
async function mockDialog(app: ElectronApplication, file: string, response: number): Promise<void> {
  await app.evaluate(({ dialog }, o) => {
    // Playwright の evaluate では process.mainModule が無い。require → process.getBuiltinModule の順に試す
    const g = globalThis as unknown as { require?: (m: string) => typeof import("node:fs") };
    const proc = process as unknown as { getBuiltinModule?: (m: string) => typeof import("node:fs") };
    const fsMod = typeof require === "function" ? (require as unknown as (m: string) => typeof import("node:fs"))("node:fs") : g.require ? g.require("node:fs") : proc.getBuiltinModule!("node:fs");
    const impl = new Function("fs", "o", "return async function () { var a = Array.prototype.slice.call(arguments); var opts = a.length > 1 ? a[1] : a[0]; fs.appendFileSync(o.file, JSON.stringify(opts) + String.fromCharCode(10)); return { response: o.response, checkboxChecked: false }; }")(fsMod, o);
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = impl;
  }, { file, response });
}
const dialogs = (file: string): Array<{ detail: string; buttons: string[]; defaultId: number; cancelId: number }> =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];

async function backendReady(): Promise<void> {
  const end = Date.now() + 120_000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${HTTP}/api/status`)).ok) return; } catch { /* まだ */ }
    await sleep(500);
  }
  throw new Error("backend not ready");
}
/** File ＞ 終了を押して、押した時刻を返す（終了までの時間はここから測る。ダイアログを閉じる待ちを含めない）。 */
const clickExit = async (page: Page): Promise<number> => {
  await dismissUpdate(page);
  try {
    await page.click('[data-testid="mainscreen-menu-file"]', { timeout: 10_000 });
    await page.click('[data-testid="menu-item-exit"]', { timeout: 10_000 });
    return Date.now();
  } catch (e) {
    await page.screenshot({ path: path.join(OUT_DIR, "clickExit-failed.png") }).catch(() => undefined);
    throw e;
  }
};
const cleanupApp = async (l: Launched | null) => { if (l) await l.app.close().catch(() => undefined); };

async function main(): Promise<void> {
  fs.mkdirSync(DATA_DIR, { recursive: true }); // OUT_DIR も作られる
  await startSlowServer();
  await startVite();
  let l: Launched | null = null;
  try {
    // ── [1] 何も走っていない: Exit
    console.log("\n[1] 何も走っていない: File ＞ 終了");
    l = await launch();
    await backendReady();
    const pid1 = pidOnPort(HTTP);
    check(pid1 !== null && alive(pid1), "[1] 起動中の backend（java）が居る", pid1);
    const dlg1 = path.join(OUT_DIR, "dialogs-1.jsonl");
    await mockDialog(l.app, dlg1, 1);
    const t1 = await clickExit(l.page);
    const code1 = await Promise.race([l.exited, sleep(40_000).then(() => "timeout" as const)]);
    check(code1 !== "timeout", "[1] アプリが終わる（40 秒以内）", { code1, ms: Date.now() - t1 });
    check(dialogs(dlg1).length === 0, "[1] 何も走っていないので、確認は出ない（負例: 確認が出てしまうなら失敗）", dialogs(dlg1));
    await sleep(500);
    check(pid1 !== null && !alive(pid1), "[1] backend のプロセスが消えた", pid1);
    check(!(await portOpen(HTTP)) && !(await portOpen(SCP)), "[1] backend と SCP のポートが空いた");
    console.log("   終了までの時間(ms):", Date.now() - t1);
    dumpLog(l, "app-1", t1);
    console.log("   ログ(終了関連):", l.log.filter((x) => /\[quit\]|graceful|Graceful|shutdown|Shutdown/.test(x)).slice(0, 6).join(" | ") || "(該当なし)");
    l = null;

    // ── [2][3][4] 実行中のジョブ
    console.log("\n[2] 実行中（URL 取り込み）: Exit → 終了しない");
    l = await launch();
    await backendReady();
    const pid2 = pidOnPort(HTTP);
    const submit = await fetch(`http://127.0.0.1:${HTTP}/api/import/url`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: `http://127.0.0.1:${SLOW}/slow.bin` }) });
    const job = (await submit.json()) as { jobId: string; state: string };
    check(submit.ok && !!job.jobId, "[2] 遅い URL の取り込みを開始できた", job);
    const jobState = async () => ((await (await fetch(`http://127.0.0.1:${HTTP}/api/import/url/${job.jobId}`)).json()) as { state: string }).state;
    const endDl = Date.now() + 15_000;
    while (Date.now() < endDl && (await jobState()) !== "DOWNLOADING") await sleep(300);
    const b0 = slowBytes;
    await sleep(1500);
    check((await jobState()) === "DOWNLOADING" && slowOpen >= 1 && slowBytes > b0, "[2] 受信中（DOWNLOADING・接続あり・バイト数が増えている）", { state: await jobState(), slowOpen, grew: slowBytes - b0 });
    const dlg2 = path.join(OUT_DIR, "dialogs-2.jsonl");
    await mockDialog(l.app, dlg2, 0); // 終了しない
    await clickExit(l.page);
    await sleep(2500);
    const d2 = dialogs(dlg2);
    check(d2.length === 1, "[2] 確認が 1 回出る", d2.length);
    check(d2[0]?.detail.includes("URL からの取り込み: 1") === true || d2[0]?.detail.includes("Import from URL: 1") === true, "[2] 実行中の処理（URL 取り込み 1 件）が一覧に出る", d2[0]?.detail);
    check(/^(終了しない|Don't quit)$/.test(d2[0]?.buttons[0] ?? "") && d2[0]?.defaultId === 0 && d2[0]?.cancelId === 0, "[2] 既定は［終了しない］", d2[0]);
    await l.page.screenshot({ path: path.join(OUT_DIR, "02-after-stay.png") });
    check(l.app.windows().length > 0 && !l.page.isClosed(), "[2] ［終了しない］で窓が残っている");
    check(pid2 !== null && alive(pid2) && (await portOpen(HTTP)), "[2] backend が生きている（終了しないのに止まっていない）");
    const b1 = slowBytes;
    await sleep(1500);
    check((await jobState()) === "DOWNLOADING" && slowOpen >= 1 && slowBytes > b1, "[2] ジョブは続いている（接続も切れず、バイト数が増え続ける）", { state: await jobState(), slowOpen, grew: slowBytes - b1 });

    console.log("\n[3] メイン窓の ×: 確認 → 終了しない");
    await l.app.evaluate(({ BrowserWindow }, o) => {
      BrowserWindow.getAllWindows().find((w: { webContents: { getURL(): string } }) => w.webContents.getURL().startsWith(o) && !w.webContents.getURL().includes("#"))?.close();
    }, `http://localhost:${VITE}`);
    await sleep(2500);
    check(dialogs(dlg2).length === 2, "[3] × でも同じ確認が出る（2 回目）", dialogs(dlg2).length);
    check(!l.page.isClosed() && l.app.windows().length > 0, "[3] ［終了しない］で窓は閉じない（負例: 閉じてしまうなら失敗）");
    check((await jobState()) === "DOWNLOADING", "[3] ジョブは続いている");

    console.log("\n[3b] app.quit()（Cmd+Q・OS からの終了と同じ経路）: 確認 → 終了しない");
    await l.app.evaluate(({ app }) => { app.quit(); });
    await sleep(2500);
    check(dialogs(dlg2).length === 3, "[3b] app.quit() でも同じ確認が出る（3 回目）", dialogs(dlg2).length);
    check(!l.page.isClosed() && l.app.windows().length > 0, "[3b] ［終了しない］で窓は残る");
    check(pid2 !== null && alive(pid2) && (await portOpen(HTTP)), "[3b] backend が生きている（終了しないのに他の終了処理が走って止めていない。負例: ガードを外すと失敗）");
    check((await jobState()) === "DOWNLOADING", "[3b] ジョブは続いている");

    console.log("\n[4] 中止して終了");
    await mockDialog(l.app, dlg2, 1);
    const t4 = await clickExit(l.page);
    const code4 = await Promise.race([l.exited, sleep(60_000).then(() => "timeout" as const)]);
    check(code4 !== "timeout", "[4] アプリが終わる（60 秒以内）", { code4, ms: Date.now() - t4 });
    check(dialogs(dlg2).length === 4, "[4] 確認が 1 回出た（4 回目）", dialogs(dlg2).length);
    await sleep(500);
    const b4 = slowBytes;
    await sleep(1500);
    check(slowOpen === 0 && slowBytes === b4, "[4] ジョブが中止され、受信の接続が切れ、バイト数も増えない", { slowOpen, grew: slowBytes - b4 });
    check(pid2 !== null && !alive(pid2), "[4] backend のプロセスが消えた", pid2);
    check(!(await portOpen(HTTP)) && !(await portOpen(SCP)), "[4] ポートが空いた");
    const leftovers = fs.readdirSync(DATA_DIR, { recursive: true }).map(String).filter((f) => /url-import|\.part$|\.tmp$/i.test(f));
    console.log("   終了までの時間(ms):", Date.now() - t4, " 書きかけ/一時ファイル:", JSON.stringify(leftovers));
    dumpLog(l, "app-4", t4);
    check(leftovers.length === 0, "[4] 書きかけのファイルが残っていない", leftovers);
    console.log("   ログ(終了関連):", l.log.filter((x) => /\[quit\]|graceful|Graceful|shutdown|Shutdown/.test(x)).slice(0, 8).join(" | ") || "(該当なし)");
    l = null;

    // ── [5] ビューア窓が開いている状態で、メイン窓の ×（何も走っていない）
    console.log("\n[5] ビューア窓を開いたまま、メイン窓の ×（何も走っていない）");
    l = await launch();
    await backendReady();
    const pid5 = pidOnPort(HTTP);
    await l.page.evaluate("window.graphyDesktop.openViewer('2dviewer')");
    const endV = Date.now() + 20_000;
    while (Date.now() < endV && !l.app.windows().some((w) => w.url().includes("#2dviewer"))) await sleep(300);
    check(l.app.windows().some((w) => w.url().includes("#2dviewer")), "[5] ビューア窓が開いた");
    const dlg5 = path.join(OUT_DIR, "dialogs-5.jsonl");
    await mockDialog(l.app, dlg5, 1);
    await l.app.evaluate(({ BrowserWindow }, o) => {
      BrowserWindow.getAllWindows().find((w: { webContents: { getURL(): string } }) => w.webContents.getURL().startsWith(o) && !w.webContents.getURL().includes("#"))?.close();
    }, `http://localhost:${VITE}`);
    const code5 = await Promise.race([l.exited, sleep(40_000).then(() => "timeout" as const)]);
    check(code5 !== "timeout", "[5] ビューア窓が残っていてもアプリが終わる", { code5 });
    check(dialogs(dlg5).length === 0, "[5] 何も走っていないので確認は出ない", dialogs(dlg5));
    await sleep(500);
    check(pid5 !== null && !alive(pid5) && !(await portOpen(HTTP)), "[5] backend が消え、ポートが空いた", pid5);
    l = null;
  } finally {
    await cleanupApp(l);
    slowServer?.close();
    if (vite?.pid) { try { process.kill(-vite.pid); } catch { /* 既に終了 */ } }
  }
  if (summary() > 0) process.exitCode = 1;
}

// Vite の子や遅いサーバがハンドルを握っていても、検査が終わったら確実に終える（残骸のプロセスを作らない）
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => process.exit(process.exitCode ?? 0));
