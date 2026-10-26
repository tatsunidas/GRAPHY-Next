/*
 * アシスタントから vis-monai の AI ツール（segment_models / segment_run / segment_undo）を呼ぶ実機検証。
 *
 * 実行:  cd automator && GRAPHY_MONAI_PLUGIN_DIR=<vis-monai の作業コピー> npx tsx src/spike/assistantSegmentCheck.ts
 *   前提: backend jar・fixture ct-basic・jupyter_server と ipykernel の入った Python が PATH 上にあること（「この PC」で動かす）。
 *
 * 本物の Electron ＋ backend ＋ fixture の #2dviewer 窓 ＋ 実在のプラグイン。計算機は「この PC」（既定にしてある）。
 * 確かめること:
 *   1. segment_models が使えるモデルと臓器名を返す（読み取り）
 *   2. 🔴 未知の臓器名は、計算機へ送る前に拒否される（同意の窓が出ない・監査に送信が無い）
 *   3. 🔴 書き込みの確認を断ると何も起きない（同意の窓が出ない）
 *   4. 本物の同意の窓（この PC・コード全文・データ）が出て、取り消すと送信 0 件・Mask は増えない
 *   5. 承認すると本物のジョブが走り、この PC に torch / monai が無ければ environment-missing で止まる（Mask は増えない）
 *   6. segment_undo は出した Mask が無ければ 0 件
 * 未達として残すもの: 実 GPU・実モデルでの推論（Colab）、結果の正しさ、文章から臓器を選ぶ実モデルの精度、実 OS の確認ダイアログ。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-segment-check");
const CFG = path.resolve(AUTOMATOR_ROOT, "..", "desktop", "compute-endpoints.json");
const AUDIT = path.join(DESKTOP_RUN_DATA_DIR, "compute-audit.jsonl");
const PORTS = { http: 19470, scp: 19471, vite: 19473 };
const PLUGIN_ID = "vis-monai";
const P = `plugin__${PLUGIN_ID}__`;
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

type Res = { ok: boolean; error?: string; data?: Record<string, unknown> };
const data = (r: Res) => (r.data ?? {}) as Record<string, unknown>;

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installOfficialPlugin();
  fs.rmSync(AUDIT, { force: true });
  // 既定の計算機を「この PC」にする（Colab のログインを要らなくする）
  const hadCfg = fs.existsSync(CFG) ? fs.readFileSync(CFG, "utf8") : null;
  fs.writeFileSync(CFG, JSON.stringify({ schemaVersion: 2, endpoints: [], defaultId: "local" }, null, 2));
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

    // 書き込みツールの確認ダイアログ（main が出すネイティブ）。応答は切り替える
    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 0 };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
        g.__dlg.n++;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const setConfirm = (response: number) => driver.app.evaluate((_a, r) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = r; }, response);
    const consentOpen = () => driver.app.windows().some((w) => w.url().endsWith("computeConsent.html"));
    const audit = (): Array<{ event: string }> => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    /** 実際に計算機へ送られた回数（同意の要求・拒否は数えない）。 */
    const uploads = () => audit().filter((e) => e.event === "compute-uploaded").length;

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
    check(await win.getByTestId(`assistant-plugintools-toggle-${PLUGIN_ID}`).isChecked(), "前提: vis-monai のツールがオンになった");
    await win.screenshot({ path: path.join(OUT_DIR, "assistant-tools.png") });

    const cmd = (name: string, params: Record<string, unknown> = {}): Promise<Res> =>
      win.evaluate(([n, p]) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<Res> } }).graphyDesktop.assistantViewerCmd("spike", { kind: "pluginTool", name: n, params: p }), [name, params] as [string, Record<string, unknown>]);

    const base = await segIds();

    // --- 1. モデルと臓器名 ---
    console.log("\n[1] segment_models");
    const r1 = await cmd(`${P}segment_models`);
    const models = (data(r1).models ?? []) as Array<{ model: string; organs: string[] }>;
    check(r1.ok === true && models.length === 5 && models.some((m) => m.model === "spleen_ct_segmentation"), "使えるモデル 5 本を返す", r1.ok ? models.map((m) => m.model) : r1);
    check(models.find((m) => m.model === "wholeBody_ct_segmentation")?.organs.includes("spleen") === true, "全身モデルの臓器名に spleen がある");

    // --- 2. 未知の臓器名 ---
    console.log("\n[2] 未知の臓器名は送る前に拒否");
    await setConfirm(0);
    const r2 = await cmd(`${P}segment_run`, { organs: "ほげ" });
    check(r2.ok === true && data(r2).ok === false && data(r2).error === "organ-not-found", "🔴 organ-not-found（候補つき）", r2);
    check(Array.isArray(data(r2).available) && (data(r2).available as string[]).includes("脾臓"), "候補に脾臓がある");
    check(!consentOpen() && audit().length === 0, "🔴 同意の窓が出ず、監査にも何も無い（要求すら出ていない）");

    // --- 3. 書き込みの確認を断る ---
    console.log("\n[3] 書き込みの確認を断る");
    await setConfirm(1);
    const r3 = await cmd(`${P}segment_run`, { organs: "脾臓" });
    check(r3.ok === false && r3.error === "declined", "🔴 declined", r3);
    check(!consentOpen() && audit().length === 0, "🔴 同意の窓が出ず、監査にも何も無い");

    // --- 4. 本物の同意の窓 → 取り消す ---
    console.log("\n[4] 同意の窓（この PC）で取り消す");
    await setConfirm(0);
    const p4 = cmd(`${P}segment_run`, { organs: "脾臓" });
    const c1 = await consentWindow(driver, 240_000);
    const title = (await c1.locator("#title").textContent()) ?? "";
    check(/この PC|this PC/.test(title), "同意の窓が出る（この PC）", title);
    check(((await c1.getByTestId("consent-code").textContent()) ?? "").includes("monai"), "コード全文に monai の Bundle 呼び出しが見える");
    await c1.screenshot({ path: path.join(OUT_DIR, "consent.png") });
    await c1.getByTestId("consent-cancel").click();
    const r4 = await p4;
    check(r4.ok === true && data(r4).ok === false && data(r4).error === "declined", "🔴 取り消すと declined", r4);
    check(audit().some((e) => e.event === "egress-denied") && uploads() === 0, "🔴 取り消しは監査に egress-denied、送信（compute-uploaded）は 0 件", audit().map((e) => e.event));
    check((await segIds()).length === base.length, "Mask は増えない");

    // --- 5. 承認 → この PC に monai が無ければ environment-missing ---
    console.log("\n[5] 承認して実行（この PC の Python の状態で分岐）");
    const p5 = cmd(`${P}segment_run`, { organs: "脾臓" });
    const c2 = await consentWindow(driver, 240_000);
    await c2.getByTestId("consent-ack").check();
    await c2.getByTestId("consent-send").click();
    const r5 = await p5;
    console.log("  結果:", JSON.stringify(r5).slice(0, 300));
    check(uploads() === 1 && audit().some((e) => e.event === "egress-approved"), "承認した送信は 1 件（egress-approved → compute-uploaded）", audit().map((e) => e.event));
    check(r5.ok === true && data(r5).ok === false && data(r5).error === "environment-missing", "🔴 torch / monai が無い PC では environment-missing（導入はしない）", r5);
    check(Array.isArray(data(r5).packages) && (data(r5).packages as string[]).length > 0, "足りないパッケージ名を返す", data(r5).packages);
    check((await segIds()).length === base.length, "Mask は増えない（失敗時は何も表示しない）");

    // --- 6. undo ---
    console.log("\n[6] segment_undo");
    const r6 = await cmd(`${P}segment_undo`);
    check(r6.ok === true && data(r6).ok === true && data(r6).removed === 0, "出した Mask が無ければ 0 件", r6);
    await win.screenshot({ path: path.join(OUT_DIR, "assistant-after.png") });
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
  console.log("  [未達] 実 GPU・実モデルでの推論／結果の正しさ／文章から臓器を選ぶ実モデルの精度／実 OS の確認ダイアログ");
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed, unreached: 4 }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
