/*
 * 操作ガイド用の撮影（Computed DWI / vMRE プラグイン）。本体 v0.6.1 のガイドとプラグイン v1.0.0 のガイドで共有する。
 * 合成のデジタルファントム（患者情報なし。automator/scripts/make-dwi-phantom.py）を、実アプリ（デスクトップ版）に入れて撮る。
 *
 * - 患者 PH-B400-800（b400・b800）: vMRE の両方実測、cDWI、点 ROI の信号減衰、ROI 統計、保存
 * - 患者 PH-B0-B1000（b0・b1000）: vMRE で L だけ合成（H は実測）
 * - プラグインは CDWI_PLUGIN_DIR（既定 ~/graphy-next-plugin-computed-dwi）の plugin.json・ui.js を、使い捨ての作業場所に置く。
 * - 🔴 撮れなかった画面は一覧に出し、ガイドには載せない（呼び出し側が `failed` を見る）。
 * - 画面は 2 倍の画素で撮る（縮小して載せても文字が読める）。大きさは 1280×720（タイル）と 560×860（パネル）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Locator, Page } from "playwright";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../../driver/desktopDriver.js";
import { resetDb } from "../../backend/dbReset.js";
import { importPaths } from "../../fixtures/importFixtures.js";
import { dismissStartupDialogs } from "../../common/dismissDialogs.js";
import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { MarkTarget } from "../run.js";

export type Shot = (page: Page, name: string, marks?: MarkTarget[]) => Promise<void>;

const PLUGIN_ID = "vis-computed-dwi";
const PLUGIN_DIR = process.env.CDWI_PLUGIN_DIR ?? path.join(os.homedir(), "graphy-next-plugin-computed-dwi");
const P0 = Number(process.env.CDWI_PORT_BASE ?? 28771);
/** タイルを並べる画面の大きさ（3 枚が 2 行に収まる大きさ）。 */
const TILES = { w: 1500, h: 1060 };

export interface CaptureResult {
  captured: string[];
  failed: string[];
}

async function fit(page: Page, width: number, height: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(900);
}

const park = (p: Page) => p.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); if (w) w.style.display = 'none'; })()`);
const unpark = (p: Page, x = 12, y = 12) => p.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); if (w) { w.style.display = ''; w.style.left = '${x}px'; w.style.top = '${y}px'; } })()`);

/** n 番目の画像領域を含むタイル（グリッド直下の要素）に印を付けて返す。 */
async function tileOf(page: Page, n: number): Promise<Locator> {
  await page.evaluate(`(function(){
    var hosts = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]');
    var p = hosts[${n}];
    while (p && p.parentElement && p.parentElement.getAttribute('data-testid') !== 'viewer2d-tile-grid') p = p.parentElement;
    document.querySelectorAll('[data-guide-tile]').forEach(function(e){ e.removeAttribute('data-guide-tile'); });
    if (p) p.setAttribute('data-guide-tile', '${n}');
  })()`);
  return page.locator(`[data-guide-tile="${n}"]`);
}

/** n 番目の画像領域の (fx, fy)（0〜1）から (dx, dy) だけドラッグする（楕円 ROI を描く）。 */
async function drawEllipseAt(page: Page, n: number, fx: number, fy: number, dx: number, dy: number): Promise<void> {
  await page.evaluate(`(function(){
    var host = document.querySelectorAll('[data-testid="viewer2d-canvas-host"]')[${n}];
    var canvas = host.querySelector('canvas');
    var rc = canvas.getBoundingClientRect();
    var x0 = rc.left + rc.width*${fx}, y0 = rc.top + rc.height*${fy};
    function fire(type, x, y, buttons){
      var common = {bubbles:true, cancelable:true, composed:true, clientX:x, clientY:y, button:0, buttons:buttons};
      canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, {pointerId:1, pointerType:'mouse', isPrimary:true})));
      canvas.dispatchEvent(new MouseEvent(type.replace('pointer','mouse'), common));
    }
    fire('pointermove', x0, y0, 0);
    fire('pointerdown', x0, y0, 1);
    for (var i=1;i<=10;i++) fire('pointermove', x0+${dx}*i/10, y0+${dy}*i/10, 1);
    fire('pointerup', x0+${dx}, y0+${dy}, 0);
  })()`);
}

/** 患者 ID で検索してスタディを開く（スタディ一覧の先頭）。 */
async function openPatient(main: Page, patientId: string): Promise<void> {
  await main.getByTestId("search-patientid-input").fill(patientId);
  await main.getByTestId("search-allperiod-chip").click();
  await main.getByTestId("search-submit-button").click();
  await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
}

export async function captureCdwiGuide(shot: Shot, want: Set<string>, outRoot: string): Promise<CaptureResult> {
  const result: CaptureResult = { captured: [], failed: [] };
  const phantoms = path.join(outRoot, "phantoms");
  fs.rmSync(phantoms, { recursive: true, force: true });
  for (const [pid, bs] of [["PH-B400-800", "400,800"], ["PH-B0-B1000", "0,1000"]] as const) {
    const r = spawnSync(process.env.PYTHON ?? "python3", [path.join(AUTOMATOR_ROOT, "scripts", "make-dwi-phantom.py"), path.join(phantoms, pid), "--patient-id", pid, "--b", bs], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`ファントムを作れません: ${r.stderr}`);
  }
  if (!fs.existsSync(path.join(PLUGIN_DIR, "ui.js"))) throw new Error(`プラグインの ui.js がありません: ${PLUGIN_DIR}（npm run build を先に）`);

  // DesktopDriver の作業場所（保管庫・設定・プラグイン）。利用者のデータに触れないよう、実行前に AUTOMATOR_DATA_DIR を
  // 使い捨ての場所にしておく（この定数は読み込み時に決まるので、ここで環境変数を変えても効かない）。
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, n), path.join(dst, n));
  console.log(`プラグイン: ${JSON.parse(fs.readFileSync(path.join(dst, "plugin.json"), "utf8")).version}（${dst}）`);

  /** 撮る画面を名前で絞る（状態を進める操作は、撮らない画面でも必ず実行する）。 */
  const shotW: Shot = async (page, name, marks) => {
    if (!want.has(name)) return;
    await shot(page, name, marks);
    result.captured.push(name);
  };
  const section = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      const msg = String((e as Error).message).split("\n")[0];
      result.failed.push(`${name}: ${msg}`);
      console.log(`  [撮れず] ${name}: ${msg}`);
    }
  };

  const driver = new DesktopDriver({ http: P0, scp: P0 + 1, vite: P0 + 2 });
  try {
    await driver.start();
    await resetDb(driver.ports.http);
    for (const pid of ["PH-B400-800", "PH-B0-B1000"]) {
      const imp = await importPaths(driver.ports.http, [path.join(phantoms, pid)]);
      console.log(`取り込み(${pid}): ${JSON.stringify({ imported: imp.imported, failed: imp.failed })}`);
    }
    const main = driver.page;
    await main.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await main.reload({ waitUntil: "domcontentloaded" });
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(main);
    const base = `http://localhost:${driver.ports.http}`;

    /** 患者の系列を取り、b 値のシリーズ UID を返す。 */
    const seriesOf = async (patientId: string): Promise<{ study: string; byDesc: Record<string, string> }> => {
      const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
      const st = studies.find((s) => s.patientId === patientId);
      if (!st) throw new Error(`患者が見つかりません: ${patientId}`);
      const list = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; seriesDescription?: string }[];
      return { study: st.studyInstanceUid, byDesc: Object.fromEntries(list.map((x) => [x.seriesDescription ?? "", x.seriesInstanceUid])) };
    };

    let menuNext = true;
    /** 患者を開き、シリーズを 2D ビューアで開いて、Computed DWI のパネルを出し、もう 1 系列を保管庫から足す。 */
    const openPanel = async (patientId: string, openDesc: string, addDesc: string): Promise<Page> => {
      const s = await seriesOf(patientId);
      await main.goto(`http://localhost:${driver.ports.vite}/`).catch(() => undefined);
      await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
      await dismissStartupDialogs(main);
      await openPatient(main, patientId);
      await main.locator(`[data-testid="series-row-${s.byDesc[openDesc]}"]`).click();
      await main.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
      await main.waitForTimeout(1200);
      const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await viewer.waitForTimeout(2500);
      await fit(viewer, 1280, 720);
      await viewer.getByTestId("viewer2d-menu-analysis").click();
      if (menuNext && want.has("menu")) {
        menuNext = false;
        try {
          await viewer.waitForTimeout(500);
          await shotW(viewer, "menu", [viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`)]);
        } catch (e) {
          result.failed.push(`menu: ${String((e as Error).message).split("\n")[0]}`);
        }
      }
      await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
      await viewer.locator("#cdwi-run").waitFor({ state: "visible", timeout: 15_000 });
      await viewer.locator('[data-testid="input-row"]').first().waitFor({ state: "visible", timeout: 20_000 });
      await viewer.getByRole("button", { name: /保管庫から追加/ }).click();
      await viewer.getByTestId("pickseries-dialog").last().waitFor({ state: "visible", timeout: 20_000 });
      const top = (id: string) => viewer.getByTestId(id).last();
      await top(`pickseries-study-${s.study}`).waitFor({ state: "visible", timeout: 20_000 });
      if ((await top(`pickseries-series-check-${s.byDesc[addDesc]}`).count()) === 0) await top(`pickseries-expand-${s.study}`).click();
      await top(`pickseries-series-check-${s.byDesc[addDesc]}`).check();
      await top("pickseries-ok").click();
      await viewer.waitForFunction(() => document.querySelectorAll('[data-testid="input-row"]').length >= 2, undefined, { timeout: 30_000 });
      return viewer;
    };
    const waitDone = (v: Page) => v.waitForFunction(
      () => /計算しました|表示を切り替えました|開けません|ください|必要|できません/.test(document.querySelector('[data-testid="status"]')?.textContent ?? "") && !document.querySelector("#cdwi-run")?.hasAttribute("disabled"),
      undefined, { timeout: 240_000 });
    const run = async (v: Page): Promise<void> => {
      await fit(v, TILES.w, TILES.h);
      await unpark(v, 8, 8);
      await v.getByTestId("run").click();
      await waitDone(v);
      await v.waitForFunction(() => document.querySelector('[data-testid="graph-caption"]')?.getAttribute("data-live-points") === "5", undefined, { timeout: 60_000 }).catch(() => undefined);
      await v.waitForTimeout(2500);
    };
    /** パネルだけを撮る（縦長の窓。パネルを左上に置き、見せたいカードの先頭へスクロール）。 */
    const panelShot = async (v: Page, name: string, card: string, marks: Locator[]): Promise<void> => {
      await fit(v, 560, 860);
      await unpark(v, 8, 8);
      await v.waitForTimeout(500);
      await v.getByTestId(card).evaluate((e) => e.scrollIntoView({ block: "start" }));
      await v.waitForTimeout(600);
      await shotW(v, name, marks);
    };
    /** 点の値の文字（「座標: (x, y)」と値）を隠す。5 点が近いと文字が重なって読めないので、円だけにする（表はパネルで読める）。 */
    const hidePointText = async (v: Page): Promise<void> => {
      await v.evaluate(`(function(){
        var texts = document.querySelectorAll('svg text');
        for (var i = 0; i < texts.length; i++) {
          if ((texts[i].textContent || '').indexOf('座標') >= 0) texts[i].style.display = 'none';
        }
      })()`);
    };
    /** タイルを撮る（パネルは隠す）。 */
    const tilesShot = async (v: Page, name: string, marks: MarkTarget[] = []): Promise<void> => {
      await fit(v, TILES.w, TILES.h);
      await park(v);
      await hidePointText(v);
      await v.waitForTimeout(3000);
      await shotW(v, name, marks);
    };

    // ---- 患者 PH-B400-800: 両方実測 ----
    const v = await openPanel("PH-B400-800", "Phantom DWI b800", "Phantom DWI b400");
    await section("panel-input", async () => {
      await panelShot(v, "panel-input", "card-input", [v.getByTestId("card-input").locator("button").first(), v.getByTestId("inputs").locator("input").first(), v.getByTestId("card-input").locator("[data-testid=input-row]").first()]);
    });
    await section("panel-cdwi", async () => {
      await v.getByTestId("mode-cdwi").click();
      await v.waitForTimeout(600);
      await panelShot(v, "panel-cdwi", "card-cond", [v.getByTestId("card-cond")]);
    });
    await section("tiles-cdwi", async () => {
      await unpark(v);
      await run(v);
      await tilesShot(v, "tiles-cdwi");
    });
    await section("panel-vmre-real", async () => {
      await unpark(v, 8, 8);
      await v.getByTestId("mode-vmre").click();
      await v.waitForTimeout(800);
      await panelShot(v, "panel-vmre-real", "card-cond", [v.getByTestId("lowB"), v.getByTestId("highB"), v.getByTestId("source-note")]);
    });
    await section("panel-vmre-error", async () => {
      await v.getByTestId("lowB").fill("500");
      await v.waitForTimeout(500);
      await panelShot(v, "panel-vmre-error", "card-cond", [v.getByTestId("lowB"), v.getByTestId("lh-error")]);
      await v.getByTestId("lowB").fill("400");
      await v.waitForTimeout(400);
    });
    await section("tiles-vmre", async () => {
      await unpark(v);
      await run(v);
      await tilesShot(v, "tiles-vmre");
    });
    await section("panel-decay", async () => {
      await unpark(v, 8, 8);
      await panelShot(v, "panel-decay", "card-graph", [v.getByTestId("graph-canvas"), v.getByTestId("stats-table"), v.getByTestId("replace-points")]);
    });

    // ---- 保存 ----
    await section("save", async () => {
      await fit(v, 1280, 720);
      await unpark(v, 12, 12);
      await v.getByTestId("card-save").evaluate((e) => e.scrollIntoView({ block: "center" }));
      await v.getByTestId("save-sadc").click();
      await v.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
      await v.waitForTimeout(500);
      await shotW(v, "save-confirm", [v.getByTestId("plugin-save-confirm").locator("button").last()]);
      await v.getByTestId("plugin-save-confirm-button").click();
      await v.waitForFunction(() => /保存しました/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ""), undefined, { timeout: 60_000 });
      await v.getByTestId("save-mudiff").click();
      await v.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
      await v.getByTestId("plugin-save-confirm-button").click();
      await v.waitForFunction(() => /保存しました/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ""), undefined, { timeout: 60_000 });
      await v.getByTestId("mode-cdwi").click();
      await waitDone(v);
      await v.getByTestId("save-adc").click();
      await v.getByTestId("plugin-save-confirm").waitFor({ state: "visible", timeout: 20_000 });
      await v.getByTestId("plugin-save-confirm-button").click();
      await v.waitForFunction(() => /保存しました/.test(document.querySelector('[data-testid="status"]')?.textContent ?? ""), undefined, { timeout: 60_000 });
    });
    await section("stats", async () => {
      await fit(v, TILES.w, TILES.h);
      await park(v);
      await v.waitForTimeout(1500);
      // 楕円 ROI を選び、ADC のタイル（2 番目）の被写体の上に描く
      const tile1 = await tileOf(v, 1);
      await tile1.locator('[data-testid="tile-patient-label"]').first().click().catch(() => undefined);
      await v.keyboard.press("Escape");
      await v.getByTestId("viewer2d-menu-roi").click();
      await v.getByRole("button", { name: /^(✓ )?楕円 ROI/ }).first().click({ timeout: 8000 });
      await v.waitForTimeout(300);
      await drawEllipseAt(v, 1, 0.593, 0.5, 18, 14);
      await v.waitForTimeout(1500);
      await hidePointText(v);
      await shotW(v, "tiles-roi", []);
      await unpark(v, 8, 8);
      await v.getByTestId("tab-stats").click();
      await v.waitForTimeout(800);
      await panelShot(v, "panel-stats", "card-graph", [v.getByTestId("graph-caption"), v.getByTestId("stats-table")]);
    });
    await v.close().catch(() => undefined);
    await section("saved-series", async () => {
      // 保存した 3 本（sADC・μdiff・ADC）を、本体の一覧から開く。シリーズ番号が重ならない連番で並ぶ
      const s = await seriesOf("PH-B400-800");
      await main.goto(`http://localhost:${driver.ports.vite}/`);
      await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
      await dismissStartupDialogs(main);
      await openPatient(main, "PH-B400-800");
      const adc = Object.entries(s.byDesc).find(([d]) => /\] ADC /.test(d));
      if (!adc) throw new Error("保存した ADC が一覧に無い");
      await main.locator(`[data-testid="series-row-${adc[1]}"]`).click();
      await main.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
      await fit(main, 1280, 720);
      await main.waitForTimeout(900);
      // 状態バーの版（v0.5.1 など。開発中のコミットの版数で、リリースの版と一致しない）は写さない
      await main.evaluate(`(function(){ var all = document.querySelectorAll('*'); for (var i = 0; i < all.length; i++) { var e = all[i]; if (e.childElementCount === 0 && /^v[0-9]+[.][0-9]+[.][0-9]+$/.test((e.textContent || '').trim())) e.style.visibility = 'hidden'; } })()`);
      await shotW(main, "saved-list", [main.locator('[data-testid^="series-row-"]', { hasText: "ADC" }).first()]);
      const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await viewer.waitForTimeout(3000);
      await fit(viewer, 1280, 720);
      await viewer.evaluate(`document.querySelectorAll('.graphy-plugin-window').forEach(function(w){ w.style.display = 'none'; })`);
      await viewer.waitForTimeout(800);
      await shotW(viewer, "saved-adc", []);
      await viewer.close().catch(() => undefined);
    });

    // ---- 患者 PH-B0-B1000: L だけ合成 ----
    await section("panel-vmre-mixed", async () => {
      const v2 = await openPanel("PH-B0-B1000", "Phantom DWI b1000", "Phantom DWI b0");
      await v2.getByTestId("mode-vmre").click();
      await v2.waitForTimeout(800);
      await panelShot(v2, "panel-vmre-mixed", "card-cond", [v2.getByTestId("lowB"), v2.getByTestId("highB"), v2.getByTestId("source-note")]);
    });
  } finally {
    await driver.stop().catch(() => undefined);
  }
  return result;
}
