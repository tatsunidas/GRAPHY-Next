/*
 * アシスタント組み込みの createRoi / removeAssistantRoi（プラグイン無し）を実機で検証する。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantBuiltinRoiCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓。アシスタント窓の中継口（assistantViewerCmd）から
 * 命令を送る（main の確認は stub して応答を制御）。結果は実際の注釈（getAnnotationCanvasPoints）と getMeasurements で確かめる。
 *   1. 🔴 拒否: 確認が出て、拒否すると ROI が増えない（前提: 手描きの ROI が実在）
 *   2. 🔴 承認: 半径 20×10 mm の楕円 → 面積が π·20·10 ≈ 628.3 mm² の 2% 以内。矩形は 800 mm²
 *   3. 🔴 位置: 中心の画面位置が指定した割合 (u,v) に一致（画面に見えるとおり）
 *   4. 🔴 取り消し: inverse の removeAssistantRoi で作った ROI だけ消え、手描きは残る（手描きの uid を直接指定しても消えない）
 *   5. 🔴 負例: 範囲外の割合・半径は検証で拒否され、ROI が増えない。メイン窓からは forbidden
 * 未達として残すもの: too-large（単体のみ）／実 OS のネイティブ確認の見た目／回転・反転表示での実機確認。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-builtin-roi-check");
const PORTS = { http: 19420, scp: 19421, vite: 19423 };
const { check, summary } = createChecker();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));


async function dismissUpdate(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await page.evaluate(`(function(){ var b=[].slice.call(document.querySelectorAll("button")).find(function(x){return /^(後で|Later)$/.test((x.textContent||"").trim());}); if(b) b.click(); })()`).catch(() => undefined);
    await sleep(500);
  }
}


type Res = { ok: boolean; error?: string; inverse?: { id: string; params: { roiUid?: string } }[]; measurements?: { rois: Record<string, unknown>[] } };

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
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
    check(prov.ok === true, "ローカル提供元を保存できる", prov);

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
    await sleep(800);
    const cmd = (page: Page, c: unknown) =>
      page.evaluate((c) => (window as unknown as { graphyDesktop: { assistantViewerCmd: (s: string, c: unknown) => Promise<unknown> } }).graphyDesktop.assistantViewerCmd("builtin-roi", c), c) as Promise<Res>;
    const act = (id: string, params: unknown) => cmd(win, { kind: "action", id, params });
    const measure = async () => ((await cmd(win, { kind: "getMeasurements" })).measurements?.rois ?? []);
    const anns = () =>
      viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints(); })()`) as Promise<{ uid: string; tool: string; points: number[][] }[]>;
    const canvasSize = () =>
      viewer.evaluate(`(function(){ var r=document.querySelector('[data-testid="series-viewer-root"] canvas'); return [r.clientWidth, r.clientHeight]; })()`) as Promise<[number, number]>;

    // --- 手描き（基準） ---
    console.log("\n[0] 手で楕円 ROI を描く（基準）");
    check((await anns()).length === 0, "前提: ROI が 0 件から始まる");
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
    const base = await anns();
    check(base.length === 1, "前提: 手描きの楕円 ROI が 1 件", base.length);
    const handUid = base[0]?.uid ?? "";
    const handDlg = await dlgCount();

    // --- 1. 拒否 ---
    console.log("\n[1] 拒否");
    await setResponse(1);
    const ell = { shape: "ellipse", u: 0.5, v: 0.5, radiusXmm: 20, radiusYmm: 10 };
    const refused = await act("createRoi", ell);
    check((await dlgCount()) === handDlg + 1, "🔴 createRoi は確認が 1 回出る", await dlgCount());
    check(refused.ok === false && refused.error === "declined", "🔴 拒否すると declined", refused);
    check((await anns()).length === 1, "🔴 拒否したら ROI は増えない（前提: 承認なら増える＝次の節）", (await anns()).length);

    // --- 2. 承認 ---
    console.log("\n[2] 承認（楕円 20×10 mm）");
    await setResponse(0);
    const made = await act("createRoi", ell);
    check(made.ok === true, "承認すると ROI が作れる", made);
    const inv = made.inverse ?? [];
    check(inv.length === 1 && inv[0].id === "removeAssistantRoi" && typeof inv[0].params.roiUid === "string", "取り消し用の inverse が返る", inv);
    await viewer.waitForTimeout(1200);
    const a2 = await anns();
    check(a2.length === 2, "🔴 ROI が 2 件になった（画面の注釈も増えた）", a2.length);
    const m1 = await measure();
    const expectedEllipse = Math.PI * 20 * 10;
    const areas = m1.map((r) => Number(r.areaMm2));
    console.log(`  面積: ${JSON.stringify(areas)}（解析値 ${expectedEllipse.toFixed(1)}）`);
    check(areas.some((a) => Math.abs(a - expectedEllipse) / expectedEllipse < 0.02), "🔴 楕円の面積が解析値 π·20·10 の 2% 以内", { areas, expectedEllipse });
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-ellipse.png") });

    // --- 3. 位置 ---
    console.log("\n[3] 位置（画面に見える割合どおり）");
    const [cw, ch] = await canvasSize();
    const centerFrac = (pts: number[][]) => [pts.reduce((s, p) => s + p[0], 0) / pts.length / cw, pts.reduce((s, p) => s + p[1], 0) / pts.length / ch];
    const mine = a2.find((a) => a.uid === inv[0]?.params.roiUid);
    const f1 = mine ? centerFrac(mine.points) : [NaN, NaN];
    check(Math.abs(f1[0] - 0.5) < 0.02 && Math.abs(f1[1] - 0.5) < 0.02, "🔴 u=0.5,v=0.5 → 画面の中心", f1);
    const rect = await act("createRoi", { shape: "rectangle", u: 0.25, v: 0.75, radiusXmm: 20, radiusYmm: 10 });
    check(rect.ok === true, "矩形（u=0.25,v=0.75）も作れる", rect);
    await viewer.waitForTimeout(1200);
    const a3 = await anns();
    const mineRect = a3.find((a) => a.uid === rect.inverse?.[0]?.params.roiUid);
    const f2 = mineRect ? centerFrac(mineRect.points) : [NaN, NaN];
    check(mineRect?.tool === "RectangleROI" && Math.abs(f2[0] - 0.25) < 0.02 && Math.abs(f2[1] - 0.75) < 0.02, "🔴 u=0.25,v=0.75 → 画面のその位置（別の位置でも一致＝定数ではない）", { tool: mineRect?.tool, f2 });
    const rectArea = Number((await measure()).find((r) => r.tool === "RectangleROI")?.areaMm2);
    check(Math.abs(rectArea - 800) / 800 < 0.02, "🔴 矩形の面積が解析値 (2·20)(2·10)=800 の 2% 以内", rectArea);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-rect.png") });

    // --- 4. 取り消し ---
    console.log("\n[4] 取り消し");
    const rmHand = await act("removeAssistantRoi", { roiUid: handUid });
    check(rmHand.ok === false && rmHand.error === "not-removable" && (await anns()).length === 3, "🔴 手描きの ROI は uid を直接指定しても消えない（前提: 3 件ある）", { rmHand, n: (await anns()).length });
    const dlgBefore = await dlgCount();
    for (const step of [...(rect.inverse ?? []), ...inv]) {
      const r = await act(step.id, step.params);
      check(r.ok === true, "inverse を実行できる", r);
    }
    check((await dlgCount()) === dlgBefore, "取り消しは確認を出さない（作った ROI だけを消す逆操作）", await dlgCount());
    await viewer.waitForTimeout(800);
    const a4 = await anns();
    check(a4.length === 1 && a4[0].uid === handUid, "🔴 作った 2 件だけ消え、手描きが残る", a4.map((a) => a.uid));
    const again = await act("removeAssistantRoi", { roiUid: inv[0].params.roiUid });
    check(again.ok === false && again.error === "not-removable", "消えた uid の再実行は not-removable", again);

    // --- 5. 負例 ---
    console.log("\n[5] 負例");
    await setResponse(0);
    const n0 = await dlgCount();
    for (const [label, p] of [
      ["u>1", { ...ell, u: 1.1 }], ["v<0", { ...ell, v: -0.1 }], ["半径0", { ...ell, radiusXmm: 0 }], ["半径>500", { ...ell, radiusYmm: 501 }],
      ["未知の形", { ...ell, shape: "polygon" }], ["未知キー", { ...ell, centerLps: [0, 0, 0] }],
    ] as [string, unknown][]) {
      const r = await act("createRoi", p);
      check(r.ok === false, `🔴 ${label} は拒否`, r);
    }
    // 検証の拒否は確認ダイアログの前か後かを問わず ROI を増やさない
    check((await anns()).length === 1, "🔴 拒否された作成で ROI は増えない（対象は実在する）", (await anns()).length);
    console.log(`  （確認ダイアログの出た回数 ${(await dlgCount()) - n0}）`);
    // 半径の上限 500 mm は、この fixture の画像（対角 > 500 mm）では too-large にならず作成される（正しい挙動）。
    // too-large 自体は roiCreate の単体テストで確認済み。ここでは作れてしまう事実を確かめ、取り消して後続の件数検査に備える。
    const big = await act("createRoi", { ...ell, radiusXmm: 500, radiusYmm: 500 });
    check(big.ok === true && big.inverse?.[0]?.id === "removeAssistantRoi", "上限 500 mm はこの画像では作成できる（too-large は単体テストで確認。この節では未達）", big);
    if (big.inverse?.[0]) await act(big.inverse[0].id, big.inverse[0].params);
    await viewer.waitForTimeout(500);
    const fromMain = await cmd(main, { kind: "action", id: "createRoi", params: ell });
    check(fromMain.ok === false && fromMain.error === "forbidden", "🔴 メイン窓からの中継は forbidden", fromMain);
    check((await anns()).length === 1, "メイン窓の命令でも ROI は増えない", (await anns()).length);
  } finally {
    await driver.app
      .evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __dlg?: { orig: unknown } };
        if (g.__dlg) (dialog as unknown as { showMessageBox: unknown }).showMessageBox = g.__dlg.orig;
      })
      .catch(() => undefined);
    await driver.stop();
    for (const f of ["ai-providers.json", "secrets.enc.json"]) fs.rmSync(path.join(dataDir, f), { force: true });
  }
  const failed = summary();
  fs.writeFileSync(path.join(OUT_DIR, "result.json"), JSON.stringify({ failed }, null, 2));
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
