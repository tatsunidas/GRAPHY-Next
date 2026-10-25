/*
 * プラグイン AI ツールの `effect`（read / display / write）の強制の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantPluginEffectCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ 検証用プラグイン（ai-tools-liar）。
 * アシスタント窓から main の中継（assistantViewerCmd）で pluginTool を送る＝モデルが呼ぶのと同じ口。
 * 確かめること:
 *   1. 正例: 宣言どおりの read / display / write は動く（write は確認 1 回）
 *   2. 🔴 read 宣言で createRoi・display 宣言で setRoiMeta を呼ぶツールは effect-violation で止まり、ROI もタグも変わらない・確認も出ない
 *   3. 🔴 プラグインが例外を握りつぶして成功を装っても、結果は effect-violation になる
 * 未達として残すもの: host を経由しない越権（fetch・本体モジュールの直接 import）／実機確認／実在プラグインが宣言どおりか。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-plugin-effect-check");
const PORTS = { http: 19440, scp: 19441, vite: 19443 };
const PLUGIN_ID = "ai-tools-liar";
const P = `plugin__${PLUGIN_ID}__`;
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function installPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
}

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

type Liar = { calls: string[]; reached: string[] } | undefined;
type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ app }) => ({ userData: app.getPath("userData") }));
    const toggleFile = path.join(info.userData, "assistant-plugin-tools.json");
    if (fs.existsSync(toggleFile)) fs.rmSync(toggleFile);
    const main: Page = driver.page;
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await dismissUpdate(main);
    await openFirstSeriesInViewer(main, createStepRecorder());
    await dismissUpdate(main);
    const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);
    const liar = () => viewer.evaluate(() => (window as unknown as { __aiLiar?: Liar }).__aiLiar) as Promise<Liar>;
    const callsOf = async (tool: string) => ((await liar())?.calls ?? []).filter((c) => c === tool).length;
    const reached = async () => (await liar())?.reached ?? [];
    const annCount = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().length; })()`) as Promise<number>;

    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 0 };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
        g.__dlg.n++;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const dlgCount = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { n: number } }).__dlg.n);

    // 前提: 対象になる ROI を 1 件描く
    check((await annCount()) === 0, "前提: ROI が 0 件から始まる");
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ }).first().click();
    await viewer.waitForTimeout(250);
    const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (!box) throw new Error("viewer box");
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.5, { steps: 10 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1500);
    check((await annCount()) === 1, "前提: 楕円 ROI が 1 件描けた", await annCount());

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 560, height: 800 });
    await sleep(800);
    await win.getByTestId("assistant-plugintools-toggle").click();
    await win.getByTestId("assistant-plugintools-panel").waitFor({ state: "visible", timeout: 10_000 });
    await win.getByTestId(`assistant-plugintools-toggle-${PLUGIN_ID}`).click();
    await sleep(1200);
    check(await win.getByTestId(`assistant-plugintools-toggle-${PLUGIN_ID}`).isChecked(), "前提: ツールがオンになった");

    const cmd = (name: string): Promise<Res> =>
      win.evaluate(([n]) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<Res> } }).graphyDesktop.assistantViewerCmd("spike", { kind: "pluginTool", name: n, params: {} }), [name]);

    // --- 1. 正例 ---
    console.log("\n[1] 宣言どおり（正例）");
    const r1 = await cmd(`${P}honest_read`);
    check(r1.ok === true && (r1.data as { rois?: number } | undefined)?.rois === 1, "read 宣言で読み取りだけ → 動く（ROI 1 件が見える）", r1);
    const r2 = await cmd(`${P}honest_display`);
    check(r2.ok === true && (r2.data as { hasActions?: boolean } | undefined)?.hasActions === true, "display 宣言で表示系（actions）に触れる → 動く", r2);
    const d1 = await dlgCount();
    const r3 = await cmd(`${P}honest_write`);
    check(r3.ok === true && (await dlgCount()) === d1 + 1, "write 宣言は確認が 1 回出て、承認すれば書ける（従来どおり）", { r3, dlg: (await dlgCount()) - d1 });

    // --- 2. 偽りの宣言 ---
    console.log("\n[2] 偽りの宣言（read で createRoi / display で setRoiMeta）");
    const roiBefore = await annCount();
    const d2 = await dlgCount();
    const r4 = await cmd(`${P}liar_read`);
    check(r4.ok === false && r4.error === "effect-violation", "🔴 read 宣言で createRoi を呼ぶツール → effect-violation", r4);
    const r5 = await cmd(`${P}liar_display`);
    check(r5.ok === false && r5.error === "effect-violation", "🔴 display 宣言で setRoiMeta を呼ぶツール → effect-violation", r5);
    check((await callsOf("liar_read")) === 1 && (await callsOf("liar_display")) === 1, "前提: 偽りのツールの関数は実際に実行された（呼ばれていないのではない）", await liar());
    check(!(await reached()).includes("createRoi") && !(await reached()).includes("setRoiMeta"), "🔴 越権の host 関数には到達していない（触れた時点で止まる）", await reached());
    check((await annCount()) === roiBefore, "🔴 ROI の件数が増えない（対象は実在する）", { before: roiBefore, after: await annCount() });
    check((await dlgCount()) === d2, "確認ダイアログも出ない（承認の経路に乗せない）");

    // --- 3. 握りつぶし ---
    console.log("\n[3] プラグインが例外を握りつぶす");
    const r6 = await cmd(`${P}liar_swallow`);
    check((await callsOf("liar_swallow")) === 1, "前提: 握りつぶすツールは実行された");
    check(r6.ok === false && r6.error === "effect-violation", "🔴 握りつぶして ok を返しても結果は effect-violation", r6);
    check((await annCount()) === roiBefore && !(await reached()).includes("createRoi"), "ROI は増えず、到達の記録もない");

    // --- 4. 対照: 偽りのあとも正例が動く ---
    console.log("\n[4] 対照");
    const r7 = await cmd(`${P}honest_read`);
    check(r7.ok === true, "偽りのツールを止めたあとも、正しいツールは動く（ガードが固まっていない）", r7);
    await win.screenshot({ path: path.join(OUT_DIR, "assistant.png") });
  } finally {
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID), { recursive: true, force: true });
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
