/*
 * 画面の「荷物を取り込む」を実機で通す（DB 管理 → 取り込み元の選択 → 内容の確認 → 結果）。
 * 起動済みの backend（DI_HTTP。空の DB）と Vite（DI_VITE）に Electron をつなぐ。
 *   DI_DRIVE=<荷物のあるフォルダ> DI_OUT=<出力先> DI_SECRET=<backend の GRAPHY_MAIN_SECRET> DI_USERDATA=<専用の userData>
 * フォルダの選択と確認のダイアログは main の dialog を差し替えて代行する（本番では利用者が選ぶ）。
 * 確かめること: ①確認で取り消すと何も入らない ②了承すると取り込まれ、結果とプラグインの注記が読める
 * ③もう一度取り込んでも増えない ④画面側（レンダラ）から内部の口は呼べない。
 * 🔴 専用の使い捨ての DB で走らせる。新しい DB の初回に出る利用条件は、この開発検証では了承して進める。
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { _electron as electron } from "@playwright/test";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const HTTP = Number(process.env.DI_HTTP ?? 28760), VITE = Number(process.env.DI_VITE ?? 28752);
const DRIVE = process.env.DI_DRIVE!, OUT = process.env.DI_OUT!, SECRET = process.env.DI_SECRET!, USERDATA = process.env.DI_USERDATA!;
const DESKTOP = path.join(path.resolve(AUTOMATOR_ROOT, ".."), "desktop");
fs.mkdirSync(OUT, { recursive: true });
const base = `http://127.0.0.1:${HTTP}`;
const electronPath = createRequire(path.join(DESKTOP, "package.json"))("electron") as unknown as string;
const env = { ...process.env, GRAPHY_DEV: "1", GRAPHY_BACKEND_EXTERNAL: "1", GRAPHY_BACKEND_PORT: String(HTTP), GRAPHY_DEV_SERVER_URL: `http://localhost:${VITE}`, GRAPHY_MAIN_SECRET: SECRET } as Record<string, string>;
delete env.GRAPHY_DEV_DATA_DIR;

let exit = 0;
const check = (ok: boolean, name: string, detail?: unknown) => {
  console.log(`  [${ok ? "ok  " : "NG  "}] ${name}${ok || detail === undefined ? "" : " " + JSON.stringify(detail).slice(0, 800)}`);
  if (!ok) exit = 1;
};
const studies = async () => ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; numberOfInstances: number }[]);

const app = await electron.launch({ executablePath: electronPath, args: [DESKTOP, `--user-data-dir=${USERDATA}`], cwd: DESKTOP, env });
try {
  let page = app.windows().find((w) => w.url().startsWith(`http://localhost:${VITE}`));
  for (const end = Date.now() + 60_000; !page && Date.now() < end;) { await new Promise((r) => setTimeout(r, 300)); page = app.windows().find((w) => w.url().startsWith(`http://localhost:${VITE}`)); }
  if (!page) throw new Error("メインウィンドウが見つかりません");
  await app.evaluate(({ BrowserWindow }) => { for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.getURL().startsWith("devtools://")) w.maximize(); });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  const agree = page.getByRole("button", { name: /Agree and continue|同意して使う/ });
  await agree.waitFor({ state: "visible", timeout: 8000 }).then(() => agree.click()).catch(() => undefined);
  // 更新の通知などは応答のあとに出るので、少し待ってから閉じる
  await page.waitForTimeout(3000);
  await dismissStartupDialogs(page);
  await app.evaluate(({ dialog }, drive) => {
    const g = globalThis as unknown as { __shown: string[]; __answer: number };
    g.__shown = []; g.__answer = 1;
    (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [drive] });
    (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async (...args: unknown[]) => {
      const o = args[args.length - 1] as { message?: string; detail?: string };
      g.__shown.push(`${o.message}\n${o.detail}`);
      return { response: g.__answer };
    };
  }, DRIVE);
  const shown = () => app.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown);

  check((await studies()).length === 0, "始める前の DB は空");
  // 内部の口は main だけが使える。画面側からは読めず、鍵が無い要求と、鍵があっても Origin の付く要求（ブラウザの形）は 404。
  const url = `${base}/api/internal/db-transfer/import/scan`;
  const control = await page.evaluate(async (u) => (await fetch(u)).status, `${base}/api/studies`);
  check(control === 200, "対照: 画面側から普通の API は読める", control);
  const readable = await page.evaluate(async ({ url: u, folder }) => {
    try { return (await fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ folder }) })).status; } catch { return "blocked"; }
  }, { url, folder: DRIVE });
  check(readable === 404 || readable === "blocked", "画面側から内部の口は使えない", readable);
  const direct = async (headers: Record<string, string>) => (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ folder: DRIVE }) })).status;
  const st = { noKey: await direct({}), withOrigin: await direct({ Authorization: `Bearer ${SECRET}`, Origin: `http://localhost:${VITE}` }), main: await direct({ Authorization: `Bearer ${SECRET}` }) };
  check(st.noKey === 404 && st.withOrigin === 404 && st.main === 200, "鍵なし・Origin ありは 404、main の形は 200", st);

  await page.getByRole("button", { name: /Database tables|DB テーブル|データベース/ }).first().click();
  await page.getByTestId("dbadmin-import-button").click();
  const dlg = page.getByTestId("db-import-dialog");
  await page.screenshot({ path: path.join(OUT, "1-dialog.png") });

  // ① 確認で取り消す
  await page.getByTestId("db-import-run").click();
  for (let t = 0; t < 60 && (await shown()).length === 0; t++) await page.waitForTimeout(500);
  await page.waitForTimeout(1500);
  const first = (await shown())[0] ?? "";
  console.log("確認の文面:\n" + first);
  check(/検査 1 件|1 study/.test(first), "確認に件数が出る", first);
  check((await studies()).length === 0, "取り消すと何も入らない");
  check((await page.getByTestId("db-import-result").count()) === 0 && (await page.getByTestId("db-import-error").count()) === 0, "取り消しはエラーを出さない");

  // ② 了承する
  await app.evaluate(() => { (globalThis as unknown as { __answer: number }).__answer = 0; });
  await page.getByTestId("db-import-run").click();
  await page.getByTestId("db-import-result").waitFor({ state: "visible", timeout: 600_000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(OUT, "2-result.png") });
  const text = await dlg.innerText();
  console.log("結果:\n" + text);
  const after = await studies();
  check(after.length === 1 && after[0].numberOfInstances > 0, "検査が 1 件入る", after);
  check(!text.includes("dbImport.") && !text.includes("dbTransfer."), "訳の抜けが無い");
  check(!text.includes(DRIVE), "画面に取り込み元の場所を出さない");
  console.log("注記の数:", await page.getByTestId("db-import-plugin-note").count());

  // ③ もう一度
  await page.getByTestId("db-import-close").click();
  await page.getByTestId("dbadmin-import-button").click();
  await page.getByTestId("db-import-run").click();
  await page.getByTestId("db-import-result").waitFor({ state: "visible", timeout: 600_000 });
  const again = await page.getByTestId("db-import-dialog").innerText();
  console.log("2 回目:\n" + again);
  check(/取り込み 0・|imported 0,/.test(again), "2 回目は画像が増えない", again);
  const twice = await studies();
  check(twice.length === 1 && twice[0].numberOfInstances === after[0].numberOfInstances, "検査と枚数は変わらない", twice);
  await page.screenshot({ path: path.join(OUT, "3-again.png") });
  console.log(exit === 0 ? "ALL OK" : "FAILED CHECKS");
} catch (e) {
  console.error("FAILED", e); exit = 1;
  for (const [i, w] of app.windows().entries()) await w.screenshot({ path: path.join(OUT, `failed-${i}.png`) }).catch(() => undefined);
} finally { await app.close().catch(() => undefined); }
process.exit(exit);
