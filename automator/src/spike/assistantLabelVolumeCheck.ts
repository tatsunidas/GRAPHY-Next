/*
 * `host.removeLabelVolume`（プラグインが showLabelVolume で出した Mask を、その本人だけが消せる）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantLabelVolumeCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ 検証用プラグイン 2 本（ai-tools-mask / ai-tools-mask-other）。
 * 確かめること:
 *   1. 出した Mask が実在する（segmentation が増える）
 *   2. 🔴 別プラグイン ID・未知の id・read 宣言のツールからの remove は拒否され、Mask が残る
 *   3. 本人の remove で消える。消した後の再 remove は false（二重に消えない）
 *   4. ツール別の待ち時間: timeoutSec=60 を宣言した 35 秒のツールは成功、宣言なしの同じツールは約 30 秒で timeout
 * 未達として残すもの: 実 GPU の推論／vis-monai 側／実機確認。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-label-volume-check");
const PORTS = { http: 19460, scp: 19461, vite: 19463 };
const PLUGIN_ID = "ai-tools-mask";
const OTHER_ID = "ai-tools-mask-other";
const P = `plugin__${PLUGIN_ID}__`;
const PO = `plugin__${OTHER_ID}__`;
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function installPlugin(PLUGIN_ID: string): void {
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

type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin(PLUGIN_ID);
  installPlugin(OTHER_ID);
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
    const segIds = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getSegmentationIds(); })()`) as Promise<string[]>;
    const mine = () => viewer.evaluate(`(function(){ var m = window.__aiMask; return m && m.ids[m.ids.length-1]; })()`) as Promise<string | undefined>;

    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 0 };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
        g.__dlg.n++;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 560, height: 800 });
    await sleep(800);
    await win.getByTestId("assistant-plugintools-toggle").click();
    await win.getByTestId("assistant-plugintools-panel").waitFor({ state: "visible", timeout: 10_000 });
    for (const id of [PLUGIN_ID, OTHER_ID]) {
      await win.getByTestId(`assistant-plugintools-toggle-${id}`).click();
      await sleep(1200);
      check(await win.getByTestId(`assistant-plugintools-toggle-${id}`).isChecked(), `前提: ${id} のツールがオンになった`);
    }
    const cmd = (name: string, params: Record<string, unknown> = {}): Promise<Res> =>
      win.evaluate(([n, p]) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<Res> } }).graphyDesktop.assistantViewerCmd("spike", { kind: "pluginTool", name: n, params: p }), [name, params] as [string, Record<string, unknown>]);

    // --- 1. 出す ---
    console.log("\n[1] Mask を出す");
    const base = await segIds();
    const r1 = await cmd(`${P}show_mask`);
    const id1 = await mine();
    check(r1.ok === true && !!id1, "show_mask → ok で segmentationId が返る", r1);
    const after1 = await segIds();
    check(!!id1 && after1.includes(id1) && !base.includes(id1), "🔴 segmentation が実在する（出す前には無かった）", { base, after1 });
    await viewer.waitForTimeout(500);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-shown.png") });

    // --- 2. 拒否される側 ---
    console.log("\n[2] 拒否（別プラグイン・未知の id・read 宣言）");
    const r2 = await cmd(`${PO}remove_foreign`, { id: id1 });
    check(r2.ok === true && (r2.data as { ok?: boolean } | undefined)?.ok === false, "🔴 別プラグインの remove は false", r2);
    check(!!id1 && (await segIds()).includes(id1), "別プラグインの remove のあとも Mask が残る");
    const r3 = await cmd(`${P}remove_foreign`, { id: "no-such-segmentation" });
    check(r3.ok === true && (r3.data as { ok?: boolean } | undefined)?.ok === false, "未知の id は false", r3);
    check((await segIds()).length === after1.length, "未知の id のあとも segmentation の数が変わらない");
    const r4 = await cmd(`${P}liar_remove`);
    check(r4.ok === false && r4.error === "effect-violation", "🔴 read 宣言のツールからの remove は effect-violation", r4);
    check(!!id1 && (await segIds()).includes(id1), "effect-violation のあとも Mask が残る");

    // --- 3. 本人 ---
    console.log("\n[3] 本人の remove");
    const r5 = await cmd(`${P}remove_mine`);
    check(r5.ok === true && (r5.data as { ok?: boolean } | undefined)?.ok === true, "本人の remove は true", r5);
    check(!!id1 && !(await segIds()).includes(id1), "🔴 Mask が消えた");
    const r6 = await cmd(`${P}remove_mine`);
    check(r6.ok === true && (r6.data as { ok?: boolean } | undefined)?.ok === false, "消した後の再 remove は false（二重に消えない）", r6);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer-removed.png") });

    // --- 4. 対照: 消した後にまた出せる ---
    const r7 = await cmd(`${P}show_mask`);
    const id2 = await mine();
    check(r7.ok === true && !!id2 && id2 !== id1 && (await segIds()).includes(id2!), "消したあと、もう一度出せる（別の id）", r7);

    // --- 5. ツール別の待ち時間（aiTools[].timeoutSec） ---
    console.log("\n[5] ツール別の待ち時間（35 秒かかるツール）");
    const t0 = Date.now();
    const r8 = await cmd(`${P}slow_long`);
    const s8 = Math.round((Date.now() - t0) / 1000);
    check(r8.ok === true && (r8.data as { done?: boolean } | undefined)?.done === true && s8 >= 34, "timeoutSec=60 を宣言したツールは 35 秒かかっても成功する", { r8, s8 });
    const t1 = Date.now();
    const r9 = await cmd(`${P}slow_default`);
    const s9 = Math.round((Date.now() - t1) / 1000);
    check(r9.ok === false && r9.error === "timeout" && s9 >= 29 && s9 <= 36, "🔴 宣言なしの同じツールは従来どおり約 30 秒で timeout（待ちが全体に延びていない）", { r9, s9 });
  } finally {
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    for (const id of [PLUGIN_ID, OTHER_ID]) fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", id), { recursive: true, force: true });
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
