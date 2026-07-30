/*
 * Lesion Evanesco の **ROI クロップ画像（サムネイル）** の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/recistThumbCheck.ts
 *
 * <p><b>なぜ実機で見る必要があるか</b>: プラグイン側の単体テストは canvas のスタブで動いており、
 * **画像の内容は検証できていない**（値→輝度の変換と切り出し幾何は純関数として固定済み）。
 * 「本当に画素が描かれているか」は本物の canvas でしか確かめられない。
 *
 * <p>確かめること:
 *   1. 病変表に `<img>` が出て、中身が `data:image/png`
 *   2. **画像が空白でない**（ページ内で画素を読み、階調が 1 種類でないことを確認）
 *   3. **病変が写っている**（ファントムの病変は背景より高信号なので明るい画素が存在する）
 *   4. 視野の実寸(mm)が画像に添えられる
 *   5. Tracking ID 未設定では作らない（時系列に並べられないため）
 *
 * <p>前提: backend jar、プラグインの `npm run build` と `npm run phantom`。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const PLUGIN_REPO = path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-lesion-evanesco");
const PLUGIN_ID = "lesion-evanesco";
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "recist-thumb-check");
const PATIENT = "RECIST-PR";
const TP0 = "TP0_20260105.dcm";

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

function installPlugin(): void {
  const uiJs = path.join(PLUGIN_REPO, "ui.js");
  if (!fs.existsSync(uiJs)) {
    throw new Error(`${uiJs} がありません。(cd ${PLUGIN_REPO} && npm run build) を実行してください。`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  fs.copyFileSync(path.join(PLUGIN_REPO, "plugin.json"), path.join(dst, "plugin.json"));
  fs.copyFileSync(uiJs, path.join(dst, "ui.js"));
}

async function importOne(httpPort: number, fileName: string): Promise<void> {
  const file = path.join(PLUGIN_REPO, "phantom", PATIENT, fileName);
  if (!fs.existsSync(file)) {
    throw new Error(`${file} がありません。(cd ${PLUGIN_REPO} && npm run phantom) を実行してください。`);
  }
  const res = await fetch(`http://127.0.0.1:${httpPort}/api/import/paths`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths: [file] }),
  });
  if (!res.ok) throw new Error(`import failed: ${res.status}`);
  console.log(`  import ${fileName}: ${JSON.stringify(await res.json())}`);
}

async function openViewer(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  mainPage.on("console", (m) => {
    if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
  });
  try {
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  }
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewer = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(2500);
  return viewer;
}

/** 前回実行の記録・サムネイルを消す（localStorage は実行を跨いで残る）。 */
async function clearPluginState(viewer: Page): Promise<void> {
  await viewer.evaluate(`
    (function () {
      var drop = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("lesion-evanesco.") === 0) drop.push(k);
      }
      for (var j = 0; j < drop.length; j++) localStorage.removeItem(drop[j]);
      return drop.length;
    })()
  `);
}

async function openPanel(viewer: Page): Promise<void> {
  await viewer.getByTestId("viewer2d-menu-plugins").click();
  await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("lesion-evanesco-panel").waitFor({ state: "visible", timeout: 15_000 });
}

interface ImageStats {
  found: boolean;
  src: string;
  width: number;
  height: number;
  /** 階調の種類数（1 なら空白）。 */
  distinct: number;
  /** 明るい**グレー**画素（>150）の数。ファントムの病変は背景より高信号。 */
  bright: number;
  /** 暗いグレー画素（<40）の数。 */
  dark: number;
  /** グレーでない画素（ROI の枠線・画像外の埋め色）。統計から除いている。 */
  overlay: number;
  /** 統計に使ったグレー画素の数。 */
  grayPixels: number;
  mean: number;
}

/**
 * サムネイル画像の中身を読む。**ページ内で本物の canvas に描いて画素を数える**
 * （単体テストの canvas スタブでは中身を検証できないため、ここが唯一の確認手段）。
 */
function readThumbImage(viewer: Page): Promise<ImageStats> {
  return viewer.evaluate(`
    (async function () {
      var img = document.querySelector('[data-testid^="le-thumb-"]');
      if (!img) return { found: false, src: "", width: 0, height: 0, distinct: 0, bright: 0, dark: 0, mean: 0 };
      var src = img.getAttribute("src") || "";
      var bmp = new Image();
      bmp.src = src;
      await new Promise(function (res, rej) { bmp.onload = res; bmp.onerror = rej; });
      var c = document.createElement("canvas");
      c.width = bmp.naturalWidth;
      c.height = bmp.naturalHeight;
      var ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      var d = ctx.getImageData(0, 0, c.width, c.height).data;
      var seen = {};
      var bright = 0, dark = 0, sum = 0, n = 0, overlay = 0;
      for (var i = 0; i < d.length; i += 4) {
        var r = d[i], g = d[i + 1], b = d[i + 2];
        // **ROI の枠線（黄 rgba(255,220,0)）と画像外の埋め色（暗い青灰）を除く**。
        // 赤チャンネルだけを見ると枠線が「明るい画素」に数えられ、
        // 「病変が写っている」の判定が枠線を数えただけになる（実際にこれで誤検証した）。
        var isGray = Math.abs(r - g) <= 2 && Math.abs(g - b) <= 2;
        if (!isGray) { overlay++; continue; }
        seen[g] = 1;
        if (g > 150) bright++;
        if (g < 40) dark++;
        sum += g; n++;
      }
      return {
        found: true,
        src: src.slice(0, 30),
        width: c.width,
        height: c.height,
        distinct: Object.keys(seen).length,
        bright: bright,
        dark: dark,
        overlay: overlay,
        grayPixels: n,
        mean: n > 0 ? sum / n : 0,
      };
    })()
  `) as Promise<ImageStats>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installPlugin();

  const driver = new DesktopDriver();
  await driver.start();
  try {
    console.log("\n[1] ファントムのベースラインを取り込み、病変を計測する");
    await resetDb(driver.ports.http);
    await importOne(driver.ports.http, TP0);
    const viewer = await openViewer(driver);
    await clearPluginState(viewer);

    // ファントムの病変 A は画像座標 (170, 256) 中心・直径 40mm（1 画素 1mm）。
    // Fit 表示なので fracX ≈ 170/512 ≈ 0.33。少し左から右へ引いて病変を横断する。
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
    await viewer.waitForTimeout(300);
    // 病変 A の中心は画像 (170, 256)。Fit 表示では画像が**高さ基準で収まり左右に余白**が付くため、
    // canvas の相対位置と画像座標は一致しない。病変を確実に横断するよう、まず中央付近から引く
    // （画像中心 = canvas 中心。病変 A は中心から左へ 86px = 画像幅の 17%）。
    await dragOnCanvasHost(viewer, "viewer2d-canvas-host", 60, 0, 0, 10, { fracX: 0.42, fracY: 0.5 });
    await viewer.waitForTimeout(800);

    await openPanel(viewer);
    await viewer.waitForTimeout(1500);

    // Tracking ID 未設定ではサムネイルを作らない（時系列に並べられないため）。
    const before = await readThumbImage(viewer);
    check(before.found === false, "Tracking ID 未設定ではサムネイルを作らない", before);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-no-tracking-id.png") });

    console.log("\n[2] Tracking ID を付けてサムネイルが出るか");
    // 病変行をクリックして属性エディタを開き、Tracking ID を 1 にする。
    await viewer.locator('[data-testid^="le-lesion-"]').first().click();
    await viewer.getByTestId("le-editor").waitFor({ state: "visible", timeout: 10_000 });
    const trackingInput = viewer.getByTestId("le-tracking-id");
    await trackingInput.fill("1");
    await trackingInput.press("Enter");
    // サムネイルの取得は非同期（画素読み → canvas → PNG）。出るまで待つ。
    await viewer.locator('[data-testid^="le-thumb-"]').first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(500);

    const img = await readThumbImage(viewer);
    console.log(JSON.stringify(img, null, 2));
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-thumbnail.png") });

    check(img.found, "病変表にサムネイルの img が出る");
    check(img.src.startsWith("data:image/png"), "中身が data:image/png（外部参照ではない）", img.src);
    check(img.width > 0 && img.height > 0, "画像に大きさがある", { w: img.width, h: img.height });
    // **ここが単体テストで確認できなかった部分**: 実際に画素が描かれているか。
    check(img.distinct > 1, "画像が空白でない（階調が 1 種類ではない）", { distinct: img.distinct });
    // **枠線を除いたグレー画素で判定する**（赤チャンネルだけを見ると黄色い枠線を数えてしまう）。
    check(img.grayPixels > 1000, "統計に使えるグレー画素が十分ある", { grayPixels: img.grayPixels });
    check(img.overlay > 0, "ROI の枠線が重なっている（どこを測ったか分かる）", { overlay: img.overlay });
    check(
      img.bright > img.grayPixels * 0.05,
      "病変が写っている（明るいグレー画素が全体の 5% 超）",
      { bright: img.bright, grayPixels: img.grayPixels, ratio: (img.bright / img.grayPixels).toFixed(3) },
    );
    check(
      img.mean > 5 && img.mean < 250,
      "画像が真っ黒でも真っ白でもない（W/L が効いている）",
      { mean: Math.round(img.mean) },
    );

    // 視野の実寸が添えられているか（同じ病変を回ごとに比較する根拠になる）。
    const fovText = await viewer.evaluate(`
      (function () {
        var img = document.querySelector('[data-testid^="le-thumb-"]');
        var box = img ? img.parentElement : null;
        return box ? (box.textContent || "").trim() : "";
      })()
    `);
    check(/^\d+mm$/.test(String(fovText)), "視野の実寸(mm)が画像に添えられる", fovText);

    console.log("\n[3] 測り直すとサムネイルも変わるか（指紋による作り直し）");
    const firstSrc = await viewer.evaluate(
      `(function () { var i = document.querySelector('[data-testid^="le-thumb-"]'); return i ? i.getAttribute("src") : ""; })()`,
    );
    // ROI のハンドルを掴んで動かす（同じ場所から少し引くと既存 ROI を編集する）。
    await dragOnCanvasHost(viewer, "viewer2d-canvas-host", 30, 10, 0, 10, { fracX: 0.29, fracY: 0.5 });
    await viewer.waitForTimeout(2500);
    const secondSrc = await viewer.evaluate(
      `(function () { var i = document.querySelector('[data-testid^="le-thumb-"]'); return i ? i.getAttribute("src") : ""; })()`,
    );
    check(
      typeof secondSrc === "string" && secondSrc.length > 0,
      "測り直した後もサムネイルが出ている",
      String(secondSrc).slice(0, 20),
    );
    // 形が変われば画像も変わる。変わらない場合もある（同じ画素範囲に収まった場合）ので、
    // 「変わった」ことは必須にせず、**壊れていない**ことを確認する。
    if (firstSrc !== secondSrc) {
      check(true, "ROI を動かすとサムネイルが作り直される（指紋が変わった）");
    } else {
      console.log("  [info] 画像が同一（視野が同じ範囲に収まった可能性）。壊れていないことのみ確認");
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-after-remeasure.png") });

    await viewer.close().catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
