/*
 * 実在の vis-monai が宣言するスキル（臓器の分割と体積 / 分割結果の取り消し）の実機検証。
 *
 * 実行:  cd automator && GRAPHY_MONAI_PLUGIN_DIR=<vis-monai の作業コピー> npx tsx src/spike/assistantSegmentSkillCheck.ts
 *   前提: backend jar・fixture ct-basic・jupyter_server と ipykernel の入った Python（「この PC」で動かす）。
 *
 * 確かめること:
 *   1. 🔴 vis-monai の 2 つのスキルが「プラグイン: …」つきで一覧に出る。ツールがオフの間は［実行］が止まっている
 *   2. 未知の臓器名 → 同意の窓が出ず、計算機へ送られず、スキルがそこで止まる（確認の手順に進まない）
 *   3. 🔴 書き込みの確認を断ると、スキルがそこで止まる
 *   4. 🔴 本物の同意の窓が出て、取り消すと送信 0 件・Mask は増えず、スキルは止まる
 *   5. 取り消しのスキル: 確認 → segment_undo（出した Mask が無いので 0 件）
 * 未達として残すもの: 実 GPU・実モデルでの推論（Colab）と体積の値、実モデルの選択精度、実 OS の確認ダイアログ。
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
import { consentWindow, createChecker } from "./computeSpikeShared.js";
import { installOfficialPlugin } from "./computeMonaiShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-segment-skill-check");
const CFG = path.resolve(AUTOMATOR_ROOT, "..", "desktop", "compute-endpoints.json");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const PORTS = { http: 19530, scp: 19531, vite: 19533 };
const PLUGIN_ID = "vis-monai";
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installOfficialPlugin();
  fs.rmSync(AUDIT, { force: true });
  const hadCfg = fs.existsSync(CFG) ? fs.readFileSync(CFG, "utf8") : null;
  fs.writeFileSync(CFG, JSON.stringify({ schemaVersion: 2, endpoints: [], defaultId: "local" }, null, 2));
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ app }) => ({ userData: app.getPath("userData") }));
    fs.rmSync(path.join(info.userData, "assistant-plugin-tools.json"), { force: true });
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

    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 0 };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => { g.__dlg.n++; return { response: g.__dlg.response, checkboxChecked: false }; };
    });
    const setConfirm = (response: number) => driver.app.evaluate((_a, r) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = r; }, response);
    const consentOpen = () => driver.app.windows().some((w) => w.url().endsWith("computeConsent.html"));
    const audit = (): Array<{ event: string }> => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    const uploads = () => audit().filter((e) => e.event === "compute-uploaded").length;

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 640, height: 900 });
    await sleep(800);
    const item = (id: string) => win.locator(`[data-testid="assistant-skill-item"][data-skill-id="${id}"]`);
    const VOL = `${PLUGIN_ID}--organ-volume`;
    const UNDO = `${PLUGIN_ID}--organ-undo`;
    const msg = async () => (await win.getByTestId("assistant-skill-msg").textContent()) ?? "";

    // --- 1. 一覧・オフ ---
    console.log("\n[1] 一覧");
    await win.getByTestId("assistant-skill-toggle").click();
    await item(VOL).waitFor({ state: "visible", timeout: 15_000 });
    check((await item(UNDO).count()) === 1, "vis-monai の 2 つのスキルが一覧に出る");
    check((await item(VOL).textContent() ?? "").match(/プラグイン: |Plugin: /) !== null, "出所に『プラグイン: …』が出る");
    check(await item(VOL).getByTestId("assistant-skill-run").isDisabled() && (await item(VOL).getByTestId("assistant-skill-blocked").count()) === 1, "🔴 ツールがオフの間は理由が出て［実行］が止まっている");
    await win.screenshot({ path: path.join(OUT_DIR, "1-list.png") });
    await win.getByTestId("assistant-plugintools-toggle").click();
    await win.getByTestId("assistant-plugintools-panel").waitFor({ state: "visible", timeout: 10_000 });
    await win.getByTestId(`assistant-plugintools-toggle-${PLUGIN_ID}`).click();
    await sleep(1200);
    await win.getByTestId("assistant-plugintools-toggle").click();
    check(await item(VOL).getByTestId("assistant-skill-run").isEnabled(), "ツールをオンにすると［実行］が押せる");
    const base = await segIds();
    const runAndAsk = async (organs: string) => {
      await item(VOL).getByTestId("assistant-skill-run").click();
      await win.getByTestId("assistant-skill-ask").waitFor({ state: "visible", timeout: 15_000 });
      check((await win.getByTestId("assistant-skill-ask-input").inputValue()) !== "", "尋ねる入力に既定値が入っている");
      await win.getByTestId("assistant-skill-ask-input").fill(organs);
      await win.getByTestId("assistant-skill-ask-ok").click();
    };

    // --- 2. 未知の臓器名 ---
    console.log("\n[2] 未知の臓器名");
    await setConfirm(0);
    await runAndAsk("ほげ");
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /tool-error:organ-not-found/ }).waitFor({ state: "visible", timeout: 20_000 });
    check((await win.getByTestId("assistant-skill-confirm").count()) === 0, "🔴 確認の手順に進まずに止まる");
    check(!consentOpen() && audit().length === 0, "🔴 同意の窓が出ず、監査にも何も無い（送られていない）");

    // --- 3. 書き込みの確認を断る ---
    console.log("\n[3] 書き込みの確認を断る");
    await setConfirm(1);
    await runAndAsk("脾臓");
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /declined/ }).waitFor({ state: "visible", timeout: 20_000 });
    check((await win.getByTestId("assistant-skill-confirm").count()) === 0 && !consentOpen() && audit().length === 0, "🔴 そこで止まり、同意の窓も監査も無い", await msg());

    // --- 4. 本物の同意の窓 → 取り消す ---
    console.log("\n[4] 同意の窓で取り消す");
    await setConfirm(0);
    await runAndAsk("脾臓");
    const c1 = await consentWindow(driver, 240_000);
    check(((await c1.getByTestId("consent-code").textContent()) ?? "").includes("monai"), "本物の同意の窓（コード全文に monai）が出る");
    await c1.screenshot({ path: path.join(OUT_DIR, "4-consent.png") });
    await c1.getByTestId("consent-cancel").click();
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /declined/ }).waitFor({ state: "visible", timeout: 60_000 });
    await sleep(500);
    check(audit().some((e) => e.event === "egress-denied") && uploads() === 0, "🔴 取り消しは egress-denied、送信（compute-uploaded）は 0 件", audit().map((e) => e.event));
    check((await segIds()).length === base.length, "Mask は増えない");
    check((await win.getByTestId("assistant-skill-confirm").count()) === 0, "🔴 スキルは確認の手順に進まず止まる");
    await win.screenshot({ path: path.join(OUT_DIR, "4-stopped.png") });

    // --- 5. 取り消しのスキル ---
    console.log("\n[5] 取り消しのスキル");
    await setConfirm(0);
    await item(UNDO).getByTestId("assistant-skill-run").click();
    await win.getByTestId("assistant-skill-confirm").waitFor({ state: "visible", timeout: 15_000 });
    await win.getByTestId("assistant-skill-confirm-yes").click();
    await win.getByTestId("assistant-skill-msg").filter({ hasText: /最後まで|Ran to the end/ }).waitFor({ state: "visible", timeout: 20_000 });
    const res = await win.getByTestId("assistant-skill-result").allTextContents();
    check(res.length === 1 && res[0].includes('"removed":0'), "segment_undo の結果（出した Mask が無いので 0 件）がパネルに出る", res);
  } finally {
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID), { recursive: true, force: true });
    if (hadCfg !== null) fs.writeFileSync(CFG, hadCfg);
    else fs.rmSync(CFG, { force: true });
  }
  const failed = summary();
  console.log("  [未達] 実 GPU・実モデルでの推論と体積の値／実モデルの選択精度／実 OS の確認ダイアログ");
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed, unreached: 3 }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
