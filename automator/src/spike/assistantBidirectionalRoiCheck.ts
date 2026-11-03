/*
 * プラグインが長径・短径（Bidirectional）を作る host.createRoi を、AI の write ツール経由で実機検証する。
 *
 * 実行:  cd automator && npx tsx src/spike/assistantBidirectionalRoiCheck.ts
 *
 * 本物の Electron ＋ backend ＋ fixture(ct-basic) の #2dviewer 窓 ＋ 検証用プラグイン（ai-tools-roi の make_bidirectional）。
 *   1. 前提: 手で楕円 ROI を 1 件描く（基準の位置・画素間隔）
 *   2. 🔴 正例: 30×12 mm の長径・短径 → 本体が出す長さ（lengthMm・bidirShortMm）が指定の mm と 0.5 mm 以内で一致する
 *   3. 🔴 傾けた（30°）2 軸でも同じ長さ。画面に出る（スクリーンショット）
 *   4. 🔴 修正できる: 作った ROI の長径の端点をドラッグすると長さが変わる（本体の長径・短径ツールと同じ扱い）
 *   5. 🔴 負例: 直交しない 2 軸は bad-axes、画像より大きいものは too-large で、ROI が増えない
 *   6. 🔴 消去（作ったものだけ）／再読み込みで残る
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "assistant-bidirectional-roi-check");
const PORTS = { http: 19410, scp: 19411, vite: 19413 };
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
    check(hand.length === 1, "前提: ROI の id が 1 件読める", handRes);
    await setResponse(0);

    const bidir = async () => (await measure()).filter((r) => r.tool === "Bidirectional");
    const settle = async (n: number) => {
      for (let i = 0; i < 10; i++) {
        const b = await bidir();
        if (b.length === n && b.every((r) => Number.isFinite(Number(r.lengthMm)))) return b;
        await sleep(800);
      }
      return bidir();
    };

    // --- 2. 正例 ---
    console.log("\n[2] 長径 30 mm・短径 12 mm");
    const made = await tool("make_bidirectional", { longMm: 30, shortMm: 12 });
    check(made.ok === true && made.data?.ok === true && typeof made.data.roiUid === "string", "作れる", made);
    await viewer.waitForTimeout(1200);
    check((await annCount()) === 2, "🔴 注釈が 2 件になった（手描き 1 + 作成 1）", await annCount());
    const b1 = await settle(1);
    console.log(`  本体の値: ${JSON.stringify(b1.map((r) => [r.lengthMm, r.bidirShortMm]))}`);
    const l1 = Number(b1[0]?.lengthMm);
    const s1 = Number(b1[0]?.bidirShortMm);
    check(b1.length === 1 && Math.abs(l1 - 30) < 0.5 && Math.abs(s1 - 12) < 0.5, "🔴 本体が出す長径・短径が指定の 30 / 12 mm と 0.5 mm 以内で一致（独立した算出との突き合わせ）", { l1, s1 });
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-bidirectional.png") });

    // --- 3. 傾き ---
    console.log("\n[3] 30° 傾けた長径 40 mm・短径 16 mm");
    const tilted = await tool("make_bidirectional", { longMm: 40, shortMm: 16, tiltDeg: 30 });
    check(tilted.data?.ok === true, "傾けた 2 軸も作れる", tilted);
    await viewer.waitForTimeout(1200);
    const b2 = await settle(2);
    const lens = b2.map((r) => [Number(r.lengthMm), Number(r.bidirShortMm)]);
    console.log(`  本体の値: ${JSON.stringify(lens)}`);
    check(lens.some(([l, s]) => Math.abs(l - 40) < 0.5 && Math.abs(s - 16) < 0.5), "🔴 傾けても長さが 40 / 16 mm と 0.5 mm 以内で一致", lens);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-tilted.png") });

    // --- 4. 端点をドラッグして直せる ---
    console.log("\n[4] 長径の端点をドラッグして直す");
    const pts = await viewer.evaluate(`(function(){ return window.__graphyDebug.getAnnotationCanvasPoints().filter(function(a){return a.tool==="Bidirectional";}); })()`) as { uid: string; points: number[][] }[];
    const target = pts.find((a) => a.uid === made.data?.roiUid);
    check(!!target && target.points.length === 4, "作った ROI は 4 点のハンドルを持つ", target);
    if (target) {
      const [x, y] = target.points[1];
      const lensNow = async () => (await bidir()).map((r) => Number(r.lengthMm)).sort((p, q) => p - q);
      const beforeDrag = await lensNow();
      // 生の Pointer イベントで canvas 座標をドラッグする（page.mouse は Cornerstone に届かない。roiMoveCheck.ts と同じ手段）
      await viewer.evaluate(`(function(a){
        var canvas = document.querySelector('[data-testid="series-viewer-root"] canvas');
        if (!canvas) throw new Error("canvas not found");
        var r = canvas.getBoundingClientRect();
        function fire(type, px, py, btns) {
          var c = { bubbles: true, cancelable: true, composed: true, clientX: r.left + px, clientY: r.top + py, button: 0, buttons: btns };
          canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, c, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
          canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), c));
        }
        fire("pointermove", a.x, a.y, 0); fire("pointerdown", a.x, a.y, 1);
        for (var i = 1; i <= 8; i++) fire("pointermove", a.x + a.dx * i / 8, a.y, 1);
        fire("pointerup", a.x + a.dx, a.y, 0);
      })(${JSON.stringify({ x, y, dx: 20 })})`);
      await viewer.waitForTimeout(1500);
      const afterDrag = await lensNow();
      console.log(`  ドラッグ前: ${JSON.stringify(beforeDrag)} → 後: ${JSON.stringify(afterDrag)}`);
      // 30 mm の ROI が（傾けた 40 mm の ROI ではなく）伸びたことを、30 が消えて 30 超の値が増えたことで見る
      check(beforeDrag.some((l) => Math.abs(l - 30) < 0.5) && !afterDrag.some((l) => Math.abs(l - 30) < 0.5) && afterDrag.some((l) => l > 31 && Math.abs(l - 40) > 0.5), "🔴 端点を引くと作った ROI の長径が 30 mm から伸びる（本体の長径・短径ツールと同じ編集ができる）", { beforeDrag, afterDrag });
      await viewer.screenshot({ path: path.join(OUT_DIR, "3-dragged.png") });
    }

    // --- 5. 負例 ---
    console.log("\n[5] 負例");
    const n0 = await annCount();
    const skew = await tool("make_bidirectional", { longMm: 30, shortMm: 12, skewDeg: 10 });
    check(skew.ok === true && skew.data?.ok === false && skew.data.reason === "bad-axes", "🔴 直交しない 2 軸（10° ずれ）は bad-axes", skew);
    const huge = await tool("make_bidirectional", { longMm: 1000, shortMm: 12 });
    check(huge.ok === true && huge.data?.ok === false && huge.data.reason === "too-large", "🔴 画像より大きい長径は too-large", huge);
    const zero = await tool("make_bidirectional", { longMm: 0, shortMm: 12 });
    check(zero.data?.ok === false && zero.data.reason === "degenerate", "🔴 長さ 0 は degenerate", zero);
    check((await annCount()) === n0, "🔴 拒否された作成では ROI が増えない（対照: 正例では増えた）", { n0, after: await annCount() });

    // --- 6. 消去・保存 ---
    console.log("\n[6] 消去と再読み込み");
    const rmHand = await tool("remove_roi", { roiUid: hand[0] });
    check(rmHand.data?.ok === false, "🔴 手で描いた ROI は消せない", rmHand);
    const rmMine = await tool("remove_roi", { roiUid: tilted.data?.roiUid as string });
    check(rmMine.data?.ok === true && (await annCount()) === n0 - 1, "🔴 作った（傾いた）ROI は消せる", rmMine);
    await sleep(2500);
    const keep = (await tool("list_roi_uids", {})).data?.uids ?? [];
    await viewer.reload({ waitUntil: "domcontentloaded" });
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3500);
    const reloaded = (await tool("list_roi_uids", {})).data?.uids ?? [];
    check(keep.length >= 2 && reloaded.length === keep.length && keep.every((u) => reloaded.includes(u)), "🔴 再読み込み後も作った ROI が残る", { keep, reloaded });
    const b3 = await settle(1);
    check(b3.length === 1 && Number.isFinite(Number(b3[0]?.lengthMm)), "再読み込み後も長径が読める", b3);
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-reloaded.png") });
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
