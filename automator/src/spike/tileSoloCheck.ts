/*
 * 2D ビューアのタイルヘッダをダブルクリックすると 1 タイル表示になり、もう一度で元に戻ることを実機で測るスパイク。
 *
 * 実行（本番の設定には触れない専用ポート。表示の無い環境では xvfb-run を付ける）:
 *   cd automator
 *   GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *     npx tsx src/spike/tileSoloCheck.ts
 *   TILE_SOLO_DIR=<1 検査・4 シリーズ以上の DICOM フォルダ> を渡せば実データで回せる。
 *   無ければ tileSoloSynth.py の合成データ（1 検査・4 シリーズ）を作って使う。
 *
 * ── 何を見るか ──────────────────────────────────────────────
 * 戻したときに「元と同じ」であること。DOM の属性ではなく、**タイルごとの描画（スクリーンショットのバイト列）**を
 * 切替前後で突き合わせる。スライス位置・W/L・ズーム・パンのどれがずれても一致しない。
 * 比較の前に、操作が実際に効いたこと（各タイルの描画が初期と変わった・タイル同士が違う）を確かめる。
 * 変わらないものを比べて「一致」と言っても何も証明しないので。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）、
 *       `desktop` と `automator` で `npm ci` 済み。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Locator, Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "tile-solo");
const N_TILES = 4;

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

function dataDir(): string {
  if (process.env.TILE_SOLO_DIR) return process.env.TILE_SOLO_DIR;
  const dir = path.join(OUT_DIR, "synth");
  const r = spawnSync("python3", ["-I", path.join(import.meta.dirname, "tileSoloSynth.py"), dir], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`合成データを作れません: ${r.stderr}`);
  return dir;
}

interface Rect { x: number; y: number; width: number; height: number }
const tiles = (page: Page): Locator => page.locator("[data-tile-id]");
const grid = (page: Page): Locator => page.getByTestId("viewer2d-tile-grid");

async function rects(page: Page): Promise<Rect[]> {
  const out: Rect[] = [];
  for (let i = 0; i < (await tiles(page).count()); i++) {
    const b = await tiles(page).nth(i).boundingBox();
    out.push(b ?? { x: 0, y: 0, width: 0, height: 0 });
  }
  return out;
}

/** タイル全体（ヘッダ＋画像）の描画。マウスは画像の外へ逃がして、カーソル位置の値表示を揃える。 */
async function shots(page: Page, tag: string, only?: number[]): Promise<string[]> {
  await page.mouse.move(2, 2);
  await page.waitForTimeout(400);
  const hashes: string[] = [];
  for (let i = 0; i < (await tiles(page).count()); i++) {
    if (only && !only.includes(i)) {
      hashes.push("-");
      continue;
    }
    const buf = await tiles(page).nth(i).screenshot();
    fs.writeFileSync(path.join(OUT_DIR, `${tag}-tile${i}.png`), buf);
    hashes.push(crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12));
  }
  return hashes;
}

/** 画像領域だけの描画（スライス・W/L・ズーム・パンがここに出る）。バイト一致を求める。 */
async function canvasHashes(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < (await tiles(page).count()); i++) {
    const buf = await tiles(page).nth(i).getByTestId("viewer2d-canvas-host").first().screenshot();
    out.push(crypto.createHash("sha256").update(buf).digest("hex").slice(0, 12));
  }
  return out;
}

/** タイル表示の倍率（ヘッダ下の「Zoom 100%」の数値）。 */
async function zoomPercent(page: Page, i: number): Promise<number> {
  const txt = (await tiles(page).nth(i).innerText()).replace(/\s+/g, " ");
  const m = /Zoom\s+([\d.]+)%/.exec(txt);
  return m ? Number(m[1]) : NaN;
}

/**
 * 2 枚の PNG を画素ごとに比べ、どれかのチャンネルが 8 を超えて違う画素の数を返す。
 * 角丸の縁などの 1〜3 程度のアンチエイリアス差は許す（レイアウトの小数位置による）。倍率・位置・階調のずれは数百単位で違う。
 */
async function pngDiffCount(page: Page, a: Buffer, b: Buffer): Promise<number> {
  // tsx（esbuild）が関数に __name を差し込み、ページ内で未定義になるので、式を文字列で渡す。
  const expr = `(async () => {
    const load = (b64) => new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0);
        res(ctx.getImageData(0, 0, img.width, img.height));
      };
      img.onerror = rej;
      img.src = "data:image/png;base64," + b64;
    });
    const [ia, ib] = await Promise.all([load(${JSON.stringify(a.toString("base64"))}), load(${JSON.stringify(b.toString("base64"))})]);
    if (ia.width !== ib.width || ia.height !== ib.height) return -1;
    let n = 0;
    for (let k = 0; k < ia.data.length; k += 4) {
      if (Math.abs(ia.data[k] - ib.data[k]) > 8 || Math.abs(ia.data[k + 1] - ib.data[k + 1]) > 8 || Math.abs(ia.data[k + 2] - ib.data[k + 2]) > 8) n++;
    }
    return n;
  })()`;
  return (await page.evaluate(expr)) as number;
}

async function dblclickHeader(page: Page, i: number): Promise<void> {
  const head = tiles(page).nth(i).locator("div[draggable='true']").first();
  await head.scrollIntoViewIfNeeded();
  const b = await head.boundingBox();
  if (!b) throw new Error(`タイル ${i} のヘッダが見えません`);
  // タイトル文字の上（ボタンから離れた左寄り）を押す。
  await page.mouse.dblclick(b.x + 40, b.y + b.height / 2);
  await page.waitForTimeout(700);
}

async function canvasCenter(page: Page, i: number): Promise<{ x: number; y: number }> {
  const b = await tiles(page).nth(i).getByTestId("viewer2d-canvas-host").first().boundingBox();
  if (!b) throw new Error(`タイル ${i} の画像領域が見えません`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

async function wheel(page: Page, i: number, dy: number): Promise<void> {
  const c = await canvasCenter(page, i);
  await page.mouse.move(c.x, c.y);
  for (let k = 0; k < Math.abs(dy); k++) {
    await page.mouse.wheel(0, Math.sign(dy) * 100);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
}

async function drag(page: Page, i: number, button: "left" | "right", dx: number, dy: number): Promise<void> {
  const c = await canvasCenter(page, i);
  await page.mouse.move(c.x, c.y);
  await page.mouse.down({ button });
  for (let k = 1; k <= 8; k++) {
    await page.mouse.move(c.x + (dx * k) / 8, c.y + (dy * k) / 8);
    await page.waitForTimeout(25);
  }
  await page.mouse.up({ button });
  await page.waitForTimeout(400);
}

const near = (a: number, b: number, eps = 1) => Math.abs(a - b) <= eps;
const sameRect = (a: Rect, b: Rect) => near(a.x, b.x) && near(a.y, b.y) && near(a.width, b.width) && near(a.height, b.height);

async function run(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dir = dataDir();

  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  try {
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [dir]);
    check(imp.imported > 0 && imp.failed === 0, "データを取り込めた", imp);

    const mainPage = driver.page;
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await openFirstSeriesInViewer(mainPage, recorder);
    const page = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    page.on("console", (m) => {
      if (m.type() === "error") console.log(`  [viewer error] ${m.text()}`);
    });
    await page.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    // ウィンドウマネージャの無い環境（xvfb）では maximize が効かず小さいままなので、大きさを明示する。
    await driver.app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.webContents.getURL().includes("2dviewer")) w.setBounds({ x: 0, y: 0, width: 1700, height: 1000 });
      }
    });
    await page.waitForTimeout(2000);

    console.log("\n[0] 前提: タイルを 4 枚開く");
    const addBtns = page.locator("button[title='タイルに追加']");
    for (let k = 0; k < N_TILES - 1; k++) {
      await addBtns.first().click();
      await page.waitForTimeout(1500);
    }
    check((await tiles(page).count()) === N_TILES, `タイルが ${N_TILES} 枚ある`, await tiles(page).count());
    // 2×2 に固定して、全タイルがスクロール無しで見えるようにする（行×列の手動指定の下でも戻ることを兼ねて見る）。
    await page.getByTestId("viewer2d-menu-view").click();
    await page.getByTestId("viewer2d-menu-layout").click();
    await page.getByTestId("layout-preset-2x2").click();
    await page.waitForTimeout(2500);
    check(
      (await grid(page).getAttribute("data-grid-rows")) === "2" && (await grid(page).getAttribute("data-grid-cols")) === "2",
      "レイアウトは 2×2",
    );

    console.log("\n[1] タイルごとに状態を変える（スライス位置・ズーム・W/L・パン）");
    const initial = await shots(page, "0-initial");
    await wheel(page, 0, 3);
    await wheel(page, 1, 7);
    await drag(page, 2, "right", 0, 30); // ズーム（Fit の 50 倍を超えないこと。超えると既存のリサイズ保護が Fit へ戻す）
    await drag(page, 3, "left", 80, 40); // 既定の左ドラッグ（W/L など）
    const before = await shots(page, "1-before");
    const beforeCanvas = await canvasHashes(page);
    const beforeZoom = await Promise.all([0, 1, 2, 3].map((i) => zoomPercent(page, i)));
    console.log(`  zoom(before)=${beforeZoom.join(" ")}`);
    check(beforeZoom[2] > 150 && beforeZoom[2] < 4000, "タイル 2 は拡大されていて、既存のリサイズ保護（50 倍）の範囲内", beforeZoom);
    const beforeRects = await rects(page);
    const beforeGrid = [await grid(page).getAttribute("data-grid-rows"), await grid(page).getAttribute("data-grid-cols")];
    console.log(`  initial=${initial.join(" ")}\n  before =${before.join(" ")}`);
    // 操作が効いていなければ、以降の「一致」は何も証明しない。
    check(before.every((h, i) => h !== initial[i]), "全タイルの描画が初期から変わった（操作が効いた）", { initial, before });
    check(new Set(before).size === N_TILES, "タイル同士の描画が互いに違う", before);
    check((await grid(page).getAttribute("data-solo-tile")) === "", "通常表示では data-solo-tile が空");

    console.log("\n[2] タイル 1 のヘッダをダブルクリック → 単独表示");
    const gridBox = (await grid(page).boundingBox())!;
    const wrapBox = (await grid(page).locator("xpath=..").boundingBox())!;
    await dblclickHeader(page, 1);
    const soloId = await grid(page).getAttribute("data-solo-tile");
    const id1 = await tiles(page).nth(1).getAttribute("data-tile-id");
    check(!!soloId && soloId === id1, "data-solo-tile がタイル 1 の ID になった", { soloId, id1 });
    const soloRect = (await tiles(page).nth(1).boundingBox())!;
    check(sameRect(soloRect, wrapBox), "単独のタイルが外枠いっぱいに広がった", { soloRect, wrapBox });
    check(soloRect.width > beforeRects[1].width * 1.5, "単独のタイルが元より大きい", { soloRect, was: beforeRects[1] });
    for (const i of [0, 2, 3]) {
      const vis = await tiles(page).nth(i).evaluate((e) => getComputedStyle(e).visibility);
      check(vis === "hidden", `タイル ${i} は見えない`, vis);
    }
    check(sameRect((await rects(page))[0], beforeRects[0]) && sameRect((await rects(page))[3], beforeRects[3]),
      "隠れたタイルの大きさは変わらない");
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT_DIR, "2-solo-page.png") });

    console.log("\n[3] 単独表示中も画像の操作が効く（スライス送り）");
    const soloShot = (await shots(page, "3-solo", [1]))[1];
    await wheel(page, 1, 2);
    const soloAfterWheel = (await shots(page, "3-solo-wheel", [1]))[1];
    check(soloShot !== soloAfterWheel, "単独表示中にホイールで描画が変わる", { soloShot, soloAfterWheel });
    await wheel(page, 1, -2);

    console.log("\n[4] もう一度ダブルクリック → 元に戻る");
    await dblclickHeader(page, 1);
    check((await grid(page).getAttribute("data-solo-tile")) === "", "data-solo-tile が空に戻った");
    const afterRects = await rects(page);
    check(afterRects.length === N_TILES && afterRects.every((r, i) => sameRect(r, beforeRects[i])), "全タイルの位置・大きさが元と同じ", { afterRects, beforeRects });
    check(
      (await grid(page).getAttribute("data-grid-rows")) === beforeGrid[0] && (await grid(page).getAttribute("data-grid-cols")) === beforeGrid[1],
      "行×列が元と同じ",
    );
    const after = await shots(page, "4-after");
    const afterCanvas = await canvasHashes(page);
    const afterZoom = await Promise.all([0, 1, 2, 3].map((i) => zoomPercent(page, i)));
    console.log(`  zoom(after) =${afterZoom.join(" ")}`);
    afterCanvas.forEach((h, i) => check(h === beforeCanvas[i], `タイル ${i} の画像領域が切替前とバイト一致`, { before: beforeCanvas[i], after: h }));
    check(afterZoom.every((z, i) => z === beforeZoom[i]), "各タイルの倍率の表示が切替前と同じ", { beforeZoom, afterZoom });
    for (let i = 0; i < N_TILES; i++) {
      const diff = await pngDiffCount(
        page,
        fs.readFileSync(path.join(OUT_DIR, `1-before-tile${i}.png`)),
        fs.readFileSync(path.join(OUT_DIR, `4-after-tile${i}.png`)),
      );
      check(diff === 0, `タイル ${i} 全体の描画が切替前と一致（許容 8 を超える画素 0）`, { diff });
    }
    const gridBox2 = (await grid(page).boundingBox())!;
    check(sameRect(gridBox, gridBox2), "グリッドの外形が元と同じ");

    console.log("\n[5] 負例: ヘッダ内のボタン上のダブルクリックでは切り替わらない");
    // 副作用の無い Sync ボタンを 2 回続けて押す（偶数回なので状態は元に戻る）。ボタンが無ければこの検査は成立しないので失敗にする。
    const sync = tiles(page).nth(2).locator("div[draggable='true'] button").filter({ hasText: "🔗" });
    check((await sync.count()) === 1, "ヘッダに Sync ボタンがある（この負例の前提）", await sync.count());
    const sb = (await sync.first().boundingBox())!;
    await page.mouse.dblclick(sb.x + sb.width / 2, sb.y + sb.height / 2);
    await page.waitForTimeout(500);
    check((await grid(page).getAttribute("data-solo-tile")) === "", "ボタン上のダブルクリックでは単独表示にならない");

    console.log("\n[6] 単独表示中のタイルを × で消す → 通常表示に戻る");
    await dblclickHeader(page, 3);
    check(!!(await grid(page).getAttribute("data-solo-tile")), "タイル 3 が単独表示");
    const removeBtn = tiles(page).nth(3).locator("div[draggable='true'] button").last();
    await removeBtn.click();
    await page.waitForTimeout(800);
    check((await tiles(page).count()) === N_TILES - 1, "タイルが 1 枚減った", await tiles(page).count());
    check((await grid(page).getAttribute("data-solo-tile")) === "", "単独表示が解除された");
    const visAfter = await Promise.all([0, 1, 2].map((i) => tiles(page).nth(i).evaluate((e) => getComputedStyle(e).visibility)));
    check(visAfter.every((v) => v === "visible"), "残りのタイルがすべて見える", visAfter);

    console.log("\n[7] 単独表示中にレイアウトを変える → 解除してレイアウトが変わる");
    await dblclickHeader(page, 0);
    check(!!(await grid(page).getAttribute("data-solo-tile")), "タイル 0 が単独表示");
    await page.getByTestId("viewer2d-menu-view").click();
    await page.getByTestId("viewer2d-menu-layout").click();
    await page.getByTestId("layout-preset-1x3").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("layout-preset-1x3").click();
    await page.waitForTimeout(800);
    check((await grid(page).getAttribute("data-solo-tile")) === "", "レイアウトを変えると単独表示が解除された");
    check((await grid(page).getAttribute("data-grid-rows")) === "1" && (await grid(page).getAttribute("data-grid-cols")) === "3", "レイアウトは 1×3 になった");
    const visLayout = await Promise.all([0, 1, 2].map((i) => tiles(page).nth(i).evaluate((e) => getComputedStyle(e).visibility)));
    check(visLayout.every((v) => v === "visible"), "3 枚とも見える", visLayout);
    await page.screenshot({ path: path.join(OUT_DIR, "7-after-layout.png") });

    console.log("\n[8] 1 枚だけのときはダブルクリックしても何も起きない");
    for (const i of [2, 1]) {
      await tiles(page).nth(i).locator("div[draggable='true'] button").last().click();
      await page.waitForTimeout(600);
    }
    check((await tiles(page).count()) === 1, "タイルが 1 枚になった", await tiles(page).count());
    const lone = (await tiles(page).nth(0).boundingBox())!;
    await dblclickHeader(page, 0);
    check((await grid(page).getAttribute("data-solo-tile")) === "", "1 枚のとき data-solo-tile は空のまま");
    check(sameRect((await tiles(page).nth(0).boundingBox())!, lone), "1 枚のとき大きさは変わらない");
  } finally {
    await driver.stop();
  }

  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length > 0) {
    console.log(failures.map((f) => ` - ${f}`).join("\n"));
    process.exit(1);
  }
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
