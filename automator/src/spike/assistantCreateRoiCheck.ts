/*
 * プラグインが ROI を作る host API（host.createRoi / removeCreatedRoi）を、AI の write ツール経由で実機検証する。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantCreateRoiCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ 検証用プラグイン（ai-tools-roi）。アシスタント窓から
 * plugin ツールを中継し（main の確認は stub して応答を制御）、結果は実際の画面と getMeasurements（既存の計測値の読み取り）で確かめる。
 *   1. 前提: 手で楕円 ROI を 1 件描く（ROI が実在し、基準の位置になる）
 *   2. 🔴 拒否: write ツールは確認が出て、拒否すると ROI が増えない
 *   3. 🔴 承認: 半径 20×10 mm の楕円 → 面積が解析値 π·20·10 ≈ 628.3 mm² に近い。矩形は (2·20)(2·10)=800 mm²
 *   4. 🔴 画面に出る（スクリーンショット）。ROI マネージャで見分けられるラベルが付く
 *   5. 🔴 負例: 面外（dz）は off-slice で ROI が増えない。半径 0・画像より大きい半径も拒否
 *   6. 🔴 消去: 作った ROI だけ消え、手で描いた ROI は残る（他の ROI を消そうとしても false）
 *   7. 🔴 保存: 作った ROI は再読み込みしても残る（保存予約が効く）
 * 未達として残すもの: 実 OS のネイティブ確認の見た目／回転・反転表示での実機確認（純関数のテストのみ）／ThickSlab 中の拒否（単体のみ）。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-create-roi-check");
const PORTS = { http: 19400, scp: 19401, vite: 19403 };
const PLUGIN_ID = "ai-tools-roi";
const P = `plugin__${PLUGIN_ID}__`;
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function installPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
}
const removePlugin = () => fs.rmSync(path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID), { recursive: true, force: true });

async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}

type Res = { ok: boolean; error?: string; data?: { ok?: boolean; roiUid?: string; reason?: string; uids?: string[]; centerLps?: number[] }; measurements?: { rois: Record<string, unknown>[] } };

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();
  let dataDir = "";
  const driver = new DesktopDriver(PORTS);
  try {
    await driver.start();
    const info = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return { cwd: process.cwd() };
    });
    dataDir = info.cwd;
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(dataDir, f), { force: true });
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

    // 宛先をローカル（ループバック・鍵なし）にする。未設定だと main は外部宛てとみなし、読み取りの結果にも確認が出る。
    const prov = await main.evaluate(
      (cfg) => (window as unknown as { graphyDesktop: { aiProvidersSet: (c: unknown) => Promise<{ ok: boolean }> } }).graphyDesktop.aiProvidersSet(cfg),
      { providers: [{ id: "local", label: "ローカル", kind: "openai", endpoint: "http://127.0.0.1:9", auth: "none", models: { "text-to-text": "tiny" } }], defaults: { "text-to-text": "local" } },
    );
    check(prov.ok === true, "ローカル提供元を保存できる（読み取りは確認なし、write だけ確認）", prov);

    // 確認のスタブ（0=実行 / 1=取り消し）。終わりで元に戻す。
    await driver.app.evaluate(({ dialog }) => {
      const g = globalThis as unknown as { __dlg: { n: number; orig: unknown; response: number } };
      g.__dlg = { n: 0, orig: dialog.showMessageBox, response: 1 };
      (dialog as unknown as { showMessageBox: unknown }).showMessageBox = async () => {
        g.__dlg.n++;
        return { response: g.__dlg.response, checkboxChecked: false };
      };
    });
    const dlgCount = () => driver.app.evaluate(() => (globalThis as unknown as { __dlg: { n: number } }).__dlg.n);
    const setResponse = (r: number) => driver.app.evaluate((_a, v) => { (globalThis as unknown as { __dlg: { response: number } }).__dlg.response = v; }, r);

    const win = await driver.waitForNewPage(async () => {
      await main.getByTestId("mainscreen-menu-system").click();
      await main.getByTestId("menu-item-assistant").click();
    }, (u) => u.includes("#assistant"));
    await win.getByTestId("assistant-root").waitFor({ state: "visible", timeout: 20_000 });
    await win.setViewportSize({ width: 560, height: 800 });
    await sleep(800);
    const bridge = <T>(fn: string, args: unknown[]) => win.evaluate(({ fn, args }) => (window as unknown as { graphyDesktop: Record<string, (...a: unknown[]) => Promise<T>> }).graphyDesktop[fn](...args), { fn, args });
    const enable = await bridge<{ ok: boolean }>("assistantPluginToolsSet", [PLUGIN_ID, true]);
    check(enable.ok === true, "プラグインのツールをオンにできる", enable);
    const tool = (name: string, params: unknown) => bridge<Res>("assistantViewerCmd", ["roi-spike", { kind: "pluginTool", name: `${P}${name}`, params }]);
    const measure = async () => ((await bridge<Res>("assistantViewerCmd", ["roi-spike", { kind: "getMeasurements" }])).measurements?.rois ?? []);
    const annCount = () => viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().length; })()`) as Promise<number>;

    // --- 1. 手で ROI を描く ---
    console.log("\n[1] 手で楕円 ROI を描く（基準）");
    check((await annCount()) === 0, "前提: ROI が 0 件から始まる");
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ }).first().click();
    await viewer.waitForTimeout(250);
    const box = await viewer.getByTestId("series-viewer-root").first().boundingBox();
    if (!box) throw new Error("viewer box");
    await viewer.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35);
    await viewer.mouse.down();
    await viewer.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5, { steps: 10 });
    await viewer.mouse.up();
    await viewer.waitForTimeout(1500);
    check((await annCount()) === 1, "前提: 手描きの楕円 ROI が 1 件", await annCount());
    let handRes: Res = { ok: false };
    for (let i = 0; i < 6; i++) {
      handRes = await tool("list_roi_uids", {});
      if ((handRes.data?.uids ?? []).length === 1) break;
      await sleep(1000);
    }
    const hand = handRes.data?.uids ?? [];
    check(hand.length === 1, "前提: ROI の id が 1 件読める（読む側のツール。確認なし）", handRes);
    let handArea = NaN;
    for (let i = 0; i < 8 && !Number.isFinite(handArea); i++) {
      handArea = Number((await measure())[0]?.areaMm2);
      if (!Number.isFinite(handArea)) await sleep(1000);
    }
    check(Number.isFinite(handArea) && handArea > 0, "前提: 手描きの ROI の面積が読める", handArea);
    const handDlg = await dlgCount();

    // --- 2. 拒否 ---
    console.log("\n[2] 拒否");
    await setResponse(1);
    const refused = await tool("make_roi", { shape: "EllipticalROI", rx: 20, ry: 10, mode: "px" });
    check((await dlgCount()) === handDlg + 1, "🔴 write は確認が 1 回出る", await dlgCount());
    check(refused.ok === false && refused.error === "declined", "🔴 拒否すると declined", refused);
    check((await annCount()) === 1, "🔴 拒否したら ROI は増えない（前提: 作る操作は効く＝次の節で増える）", await annCount());

    // --- 3. 承認: 楕円 ---
    console.log("\n[3] 承認（楕円 20×10 mm）");
    await setResponse(0);
    const made = await tool("make_roi", { shape: "EllipticalROI", rx: 20, ry: 10, mode: "px" });
    check(made.ok === true && made.data?.ok === true && typeof made.data.roiUid === "string", "承認すると ROI が作れる", made);
    await viewer.waitForTimeout(1200);
    check((await annCount()) === 2, "🔴 ROI が 2 件になった（画面の注釈も増えた）", await annCount());
    const m1 = await measure();
    const expectedEllipse = Math.PI * 20 * 10;
    const areas = m1.map((r) => Number(r.areaMm2));
    console.log(`  面積: ${JSON.stringify(areas)}（解析値 ${expectedEllipse.toFixed(1)}）`);
    const madeEll = m1.find((r) => Math.abs(Number(r.areaMm2) - expectedEllipse) / expectedEllipse < 0.02);
    check(!!madeEll, "🔴 楕円の面積が解析値 π·20·10 の 2% 以内（独立した値との突き合わせ）", { areas, expected: expectedEllipse });
    check(madeEll?.tool === "EllipticalROI", "作った ROI のツール種別が楕円", madeEll?.tool);
    check(Number(m1.find((r) => r !== madeEll)?.areaMm2) === handArea, "手描きの ROI の面積は変わらない", handArea);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-ellipse.png") });
    const label = await viewer.evaluate(`(function(){ var t=[].slice.call(document.querySelectorAll("svg text")).map(function(x){return x.textContent;}); return t.join("|"); })()`) as string;
    console.log(`  画面の文字: ${label.slice(0, 160)}`);

    // --- 3b. 矩形 ---
    const madeRect = await tool("make_roi", { shape: "RectangleROI", rx: 20, ry: 10, mode: "px" });
    check(madeRect.ok === true && madeRect.data?.ok === true, "矩形も作れる", madeRect);
    await viewer.waitForTimeout(1200);
    const m2 = await measure();
    const expectedRect = 4 * 20 * 10;
    const rectRoi = m2.find((r) => r.tool === "RectangleROI");
    console.log(`  矩形の面積: ${rectRoi?.areaMm2}（解析値 ${expectedRect}）`);
    check(!!rectRoi && Math.abs(Number(rectRoi.areaMm2) - expectedRect) / expectedRect < 0.02, "🔴 矩形の面積が解析値 (2·20)(2·10) の 2% 以内", rectRoi);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-rect.png") });

    // --- 5. 負例 ---
    console.log("\n[5] 負例");
    // LPS の中心: 返ってきた centerLps をそのまま使えば表示中のスライスの面内（正例）、法線方向に 50 mm ずらせば面外（負例）
    const onSlice = await tool("make_roi", { shape: "EllipticalROI", rx: 5, ry: 5, mode: "lps", dz: 0 });
    check(onSlice.data?.ok === true, "LPS の中心（前の結果の centerLps）なら作れる（面内の正例）", onSlice);
    const before2 = await annCount();
    const off = await tool("make_roi", { shape: "EllipticalROI", rx: 20, ry: 10, mode: "lps", dz: 50 });
    check(off.ok === true && off.data?.ok === false && off.data.reason === "off-slice", "🔴 面外（法線方向に 50 mm）は off-slice で拒否", off);
    check((await annCount()) === before2, "🔴 面外の拒否で ROI は増えない（直前の面内の作成は増えた）", { before2, after: await annCount() });
    const before = await annCount();
    const zero = await tool("make_roi", { shape: "EllipticalROI", rx: 0, ry: 10, mode: "px" });
    check(zero.ok === true && zero.data?.ok === false && zero.data.reason === "bad-request", "🔴 半径 0 は bad-request", zero);
    const huge = await tool("make_roi", { shape: "EllipticalROI", rx: 1000, ry: 10, mode: "px" });
    check(huge.ok === true && huge.data?.ok === false && huge.data.reason === "too-large", "🔴 画像より大きい半径は too-large", huge);
    check((await annCount()) === before, "🔴 拒否された作成では ROI が増えない（対象は実在する）", { before, after: await annCount() });

    // --- 6. 消去 ---
    console.log("\n[6] 消去");
    const uids = (await tool("list_roi_uids", {})).data?.uids ?? [];
    check(uids.length === before, "ROI の id が読める（手描き 1 + 作成 3 = 4 件）", uids);
    const handUid = hand[0];
    const mineUid = made.data?.roiUid as string;
    const rmHand = await tool("remove_roi", { roiUid: handUid });
    check(rmHand.data?.ok === false && (await annCount()) === before, "🔴 手で描いた ROI は消せない（false・件数不変）", rmHand);
    const rmMine = await tool("remove_roi", { roiUid: mineUid });
    check(rmMine.data?.ok === true && (await annCount()) === before - 1, "🔴 作った ROI は消せる", rmMine);
    const after = (await tool("list_roi_uids", {})).data?.uids ?? [];
    check(after.includes(handUid) && !after.includes(mineUid), "手で描いた ROI は残り、作ったものは無い", after);
    await setResponse(1);
    const rmRefused = await tool("remove_roi", { roiUid: (made.data?.roiUid as string) });
    check(rmRefused.ok === false && rmRefused.error === "declined", "消去も write なので確認が出て、拒否できる", rmRefused);

    // --- 7. 保存 ---
    console.log("\n[7] 再読み込みしても残る");
    await sleep(2500);
    const keep = (await tool("list_roi_uids", {})).data?.uids ?? [];
    await viewer.reload({ waitUntil: "domcontentloaded" });
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3500);
    const reloaded = (await tool("list_roi_uids", {})).data?.uids ?? [];
    check(keep.length >= 2 && reloaded.length === keep.length && keep.every((u) => reloaded.includes(u)), "🔴 再読み込み後も ROI（作ったもの含む）が残る", { keep, reloaded });
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-reloaded.png") });
  } finally {
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    removePlugin();
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(dataDir, f), { force: true });
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
