/*
 * ROI 統計表示の実機検証スパイク（`fw/roi-stats-design.md` §10.1）。
 *
 * 実行:  cd automator && npx tsx src/spike/roiStatsCheck.ts
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物の CT データ）:
 *   1. **10 種のツールすべてで統計が出る**（発端は「矩形だけ詳しい」）。
 *      とくに **ポリゴンライン / フリーライン（開いた ROI）でも出る**こと。
 *   2. 🚨 **ROI 脇の値と、計測結果ダイアログの値が一致する**。
 *      `fw/angio-design.md` の教訓「書き出しは画面と同じかを画面から測る」に従い、
 *      **どちらも画面（DOM）から読んで**突き合わせる。内部の関数を呼び合っても意味が無い。
 *   3. 単位が実データで解決される（CT なら "HU"。RescaleType が空でも空欄にしない）。
 *   4. 表示モード（off / corner / 選択中のみ）が効く。
 *   5. CSV が出る（ヘッダに単位が入る）。
 *   6. **プラグイン（H5）が受け取る値が画面と同じ**（RS5 の切り替え）。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と
 *       fixture ct-basic（`npx tsx src/cli.ts check-fixtures`）。
 *
 * ⚠ **未検証**: SUV 校正済み PET（fixture `pet-suv` が未取得）。RS5 の目玉である
 *   「SUV 校正で値と単位が変わる」はここでは確かめられていない。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-stats-check");
const PLUGIN_ID = "hostapi-check";
const HOST = "viewer2d-canvas-host";

/** 期待する表示（ja / en の両方を通す）。 */
const AREA = /面積|Area/;
const LENGTH = /長さ|Length/;
const MEAN = /平均|Mean/;

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

function installVerificationPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) fs.copyFileSync(path.join(src, name), path.join(dst, name));
}

/**
 * ROI 脇の textBox に**いま描かれている文字**を読む（Cornerstone の SVG レイヤ）。
 *
 * <p>これが「画面から測る」の本体。内部のストアを覗くと、表示されていない値でも
 * 合格してしまう（実際にそれで取りこぼした前例がある）。
 */
async function readTextBoxLines(page: Page): Promise<string[]> {
  return page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      if (!host) return [];
      var out = [];
      host.querySelectorAll("svg text").forEach(function (t) {
        var spans = t.querySelectorAll("tspan");
        if (spans.length) spans.forEach(function (s) { out.push((s.textContent || "").trim()); });
        else out.push((t.textContent || "").trim());
      });
      return out.filter(function (s) { return s.length > 0; });
    })()
  `) as Promise<string[]>;
}

/** クリック列＋ダブルクリックで輪郭を作る（ポリゴン / ポリゴンライン）。 */
async function clickPolygon(
  page: Page,
  points: Array<{ fracX: number; fracY: number }>,
): Promise<void> {
  const args = JSON.stringify({ hostTestId: HOST, points });
  await page.evaluate(`
    (function (args) {
      var host = document.querySelector('[data-testid="' + args.hostTestId + '"]');
      var canvas = host && host.querySelector("canvas");
      if (!canvas) throw new Error("canvas not found");
      var rect = canvas.getBoundingClientRect();
      function at(p) { return [rect.left + rect.width * p.fracX, rect.top + rect.height * p.fracY]; }
      function fire(type, x, y, btns, detail) {
        var common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: btns, detail: detail || 0 };
        canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), common));
      }
      for (var i = 0; i < args.points.length; i++) {
        var p = at(args.points[i]);
        fire("pointermove", p[0], p[1], 0);
        fire("pointerdown", p[0], p[1], 1);
        fire("pointerup", p[0], p[1], 0);
      }
      // 最後の点でダブルクリックして終える（ポリゴンは閉じ、ポリゴンラインは開いたまま終わる）。
      var last = at(args.points[args.points.length - 1]);
      fire("pointerdown", last[0], last[1], 1, 2);
      fire("pointerup", last[0], last[1], 0, 2);
      canvas.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, composed: true, clientX: last[0], clientY: last[1], detail: 2 }));
    })(${args})
  `);
}

/** ROI メニューからツールを選ぶ。 */
async function pickTool(page: Page, labelRe: RegExp): Promise<void> {
  await page.getByTestId("viewer2d-menu-roi").click();
  await page.getByRole("button", { name: labelRe }).first().click();
  await page.waitForTimeout(250);
}

/**
 * 全 ROI を消す（次のツールの検証を汚さない）。
 *
 * <p>「ROI を全消去」は native confirm を出す。**承諾ハンドラは呼び出し前に 1 度だけ付ける**
 * （付けずに押すと Playwright が既定で dismiss し、何も削除されない＝過去に踏んだ）。
 */
async function clearRois(page: Page): Promise<void> {
  await page.getByTestId("viewer2d-menu-roi").click();
  await page.getByRole("button", { name: /^(ROI を全消去|Clear ROIs)$/ }).first().click();
  await page.waitForTimeout(800);
}

interface ToolCase {
  key: string;
  label: RegExp;
  /** 描き方。 */
  draw: (page: Page) => Promise<void>;
  /** textBox に必ず出ているべきもの。 */
  expect: RegExp[];
}

const CASES: ToolCase[] = [
  {
    key: "rect",
    label: /矩形 ROI|Rectangle ROI/,
    draw: (p) => dragOnCanvasHost(p, HOST, 90, 70, 0, 10, { fracX: 0.30, fracY: 0.30 }),
    expect: [AREA, MEAN],
  },
  {
    key: "ellipse",
    label: /楕円 ROI|Ellipse ROI/,
    draw: (p) => dragOnCanvasHost(p, HOST, 90, 70, 0, 10, { fracX: 0.30, fracY: 0.30 }),
    expect: [AREA, MEAN],
  },
  {
    key: "freehand",
    label: /フリーハンド ROI（閉）|Freehand ROI \(closed\)/,
    draw: (p) => dragOnCanvasHost(p, HOST, 80, 60, 0, 24, { fracX: 0.32, fracY: 0.32 }),
    expect: [AREA, MEAN],
  },
  {
    key: "polygon",
    label: /ポリゴン ROI（閉）|Polygon ROI \(closed\)/,
    draw: (p) =>
      clickPolygon(p, [
        { fracX: 0.30, fracY: 0.30 },
        { fracX: 0.42, fracY: 0.30 },
        { fracX: 0.42, fracY: 0.42 },
        { fracX: 0.30, fracY: 0.42 },
      ]),
    expect: [AREA, MEAN],
  },
  {
    key: "polyline",
    // 🔴 これが本件の核心。上流は開いた輪郭に textBox を一切出さない。
    label: /ポリゴンライン（開）|Polygon line \(open\)/,
    draw: (p) =>
      clickPolygon(p, [
        { fracX: 0.30, fracY: 0.30 },
        { fracX: 0.42, fracY: 0.34 },
        { fracX: 0.52, fracY: 0.30 },
      ]),
    expect: [LENGTH, MEAN],
  },
  {
    key: "freeLine",
    label: /フリーライン（開）|Free line \(open\)/,
    draw: (p) => dragOnCanvasHost(p, HOST, 110, 40, 0, 24, { fracX: 0.30, fracY: 0.36 }),
    expect: [LENGTH, MEAN],
  },
  {
    key: "length",
    label: /^長さ$|^Length$/,
    draw: (p) => dragOnCanvasHost(p, HOST, 120, 30, 0, 10, { fracX: 0.30, fracY: 0.30 }),
    expect: [LENGTH],
  },
];

/** ダイアログの表から数値セルを読む（画面から読むこと自体が要件）。 */
async function readDialogRows(page: Page): Promise<string[][]> {
  return page.evaluate(`
    (function () {
      var dlg = document.querySelector('[data-testid="roi-stats-dialog"]');
      if (!dlg) return [];
      var out = [];
      dlg.querySelectorAll("tbody tr").forEach(function (tr) {
        var cells = [];
        tr.querySelectorAll("td").forEach(function (td) { cells.push((td.textContent || "").trim()); });
        out.push(cells);
      });
      return out;
    })()
  `) as Promise<string[][]>;
}

async function openStatsDialog(page: Page): Promise<void> {
  // ROI マネージャ（右パネル）を開いてから Σ。
  const sigma = page.getByTitle(/計測結果を一覧|Show measurements for all/);
  if (!(await sigma.isVisible().catch(() => false))) {
    await page.getByTestId("viewer2d-menu-roiTools").click();
    await page.getByRole("button", { name: /ROI マネージャ|ROI manager/ }).first().click();
    await page.waitForTimeout(500);
  }
  await page.getByTitle(/計測結果を一覧|Show measurements for all/).first().click();
  await page.getByTestId("roi-stats-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(1200); // 画素の読み込み＋計算
}

async function closeStatsDialog(page: Page): Promise<void> {
  await page.getByTestId("roi-stats-dialog").getByTitle(/閉じる|Close/).first().click();
  await page.waitForTimeout(300);
}

async function openViewer(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  mainPage.on("console", (m) => {
    if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
  });
  await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewerPage = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewerPage.waitForTimeout(3000);
  return viewerPage;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installVerificationPlugin();

  const d = new DesktopDriver();
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importFixtureCategory(d.ports.http, "ct-basic"))}`);
    const viewer = await openViewer(d);
    viewer.on("dialog", (dlg) => void dlg.accept());

    // ── 1. ツールごとに統計が出るか ────────────────────────────────
    console.log("\n[1] ツールごとに ROI 脇へ統計が出るか");
    for (const c of CASES) {
      await clearRois(viewer);
      await pickTool(viewer, c.label);
      await c.draw(viewer);
      await viewer.waitForTimeout(1200); // 掃除のデバウンス（100ms）＋画素読み込み＋再描画
      const lines = await readTextBoxLines(viewer);
      for (const re of c.expect) {
        check(lines.some((l) => re.test(l)), `${c.key}: ROI 脇に ${re.source} が出る`, lines);
      }
      await viewer.screenshot({ path: path.join(OUT_DIR, `tool-${c.key}.png`) });
    }

    // ── 2. ROI 脇とダイアログの値が一致するか ──────────────────────
    console.log("\n[2] ROI 脇の値と計測結果ダイアログの値が一致するか（どちらも画面から読む）");
    await clearRois(viewer);
    await pickTool(viewer, /矩形 ROI|Rectangle ROI/);
    await dragOnCanvasHost(viewer, HOST, 100, 80, 0, 10, { fracX: 0.30, fracY: 0.30 });
    await viewer.waitForTimeout(1500);

    const besideLines = await readTextBoxLines(viewer);
    const besideMean = firstNumberAfter(besideLines, MEAN);
    const besideArea = firstNumberAfter(besideLines, AREA);
    check(besideMean !== null, "ROI 脇に平均が数値で出ている", besideLines);
    check(besideArea !== null, "ROI 脇に面積が数値で出ている", besideLines);
    // 🔴 CT なので単位は HU。RescaleType が空のデータでも空欄にしない（resolveValueUnit）。
    check(besideLines.some((l) => MEAN.test(l) && /HU/.test(l)), "統計の単位が HU（実データで解決される）", besideLines);
    // 面積は mm²（ct-basic は校正済み）。px² のままなら換算が効いていない。
    check(besideLines.some((l) => AREA.test(l) && /mm²/.test(l)), "面積が mm²（校正済みシリーズ）", besideLines);

    await openStatsDialog(viewer);
    const rows = await readDialogRows(viewer);
    check(rows.length === 1, "ダイアログに ROI が 1 行出る", rows);
    const dialogMean = rows[0] ? Number(rows[0][3]) : NaN;
    const dialogSize = rows[0]?.[2] ?? "";
    console.log(`  ROI 脇: mean=${besideMean} area=${besideArea} / ダイアログ: mean=${dialogMean} size=${dialogSize}`);
    // 🚨 ここが本題。整形を通す関数が 1 本なので**文字列として一致する**はず。
    check(
      besideMean !== null && Math.abs(besideMean - dialogMean) < 1e-9,
      "平均が ROI 脇とダイアログで一致する",
      { beside: besideMean, dialog: dialogMean },
    );
    check(
      besideArea !== null && dialogSize.startsWith(String(besideArea)),
      "面積が ROI 脇とダイアログで一致する",
      { beside: besideArea, dialog: dialogSize },
    );
    // 詳細行（中央値・エントロピーなど）が出ている。
    const detailText = await viewer.evaluate(`
      (function () {
        var d = document.querySelector('[data-testid="roi-stats-dialog"]');
        return d ? (d.textContent || "") : "";
      })()
    `) as string;
    check(/中央値|Median/.test(detailText), "詳細に中央値が出る", detailText.slice(0, 200));
    check(/エントロピー|Entropy/.test(detailText), "詳細にエントロピーが出る");
    check(/計算元|Computed from/.test(detailText), "どの画像で計算したかが出る");
    await viewer.screenshot({ path: path.join(OUT_DIR, "dialog.png") });

    // CSV コピー（クリップボードが読めない環境ではスキップ）。
    await viewer.getByTestId("roi-stats-dialog").getByTitle(/CSV をクリップボード|Copy CSV/).first().click();
    await viewer.waitForTimeout(500);
    const csv = await viewer.evaluate("navigator.clipboard.readText().catch(function(){return ''})") as string;
    if (csv) {
      check(/mean\[HU\]/.test(csv), "CSV のヘッダに単位が入る（mean[HU]）", csv.split("\r\n")[0]);
      check(csv.split("\r\n").length === 2, "CSV は ヘッダ＋1 行", csv.split("\r\n").length);
      fs.writeFileSync(path.join(OUT_DIR, "roi-stats.csv"), csv);
    } else {
      console.log("  [skip] クリップボードを読めないため CSV の中身は未検証");
    }
    await closeStatsDialog(viewer);

    // ── 3. プラグイン（H5）が受け取る値が画面と同じか ────────────────
    console.log("\n[3] プラグイン（H5）が受け取る値が画面と同じか（RS5）");
    // 🔎 いつ値が動いたかを切り分けるため、プラグインを開く**直前**の画面をもう一度読む。
    //    （パネルの開閉でビューポートが伸縮するので、その前後で変わっていないかを見る）
    const beforePluginLines = await readTextBoxLines(viewer);
    const beforePluginMean = firstNumberAfter(beforePluginLines, MEAN);
    check(
      beforePluginMean === besideMean,
      "パネルを開閉しても ROI 脇の平均が変わらない",
      { first: besideMean, beforePlugin: beforePluginMean },
    );
    let pluginMean: number | null = null;
    const payload = await runPlugin(viewer);
    const afterPluginLines = await readTextBoxLines(viewer);
    console.log(`  プラグイン起動後の ROI 脇: ${JSON.stringify(afterPluginLines.filter((l) => MEAN.test(l)))}`);
    const m = payload.rois?.[0]?.measurements;
    check(!!m, "プラグインが ROI を 1 件受け取る", payload.rois?.length);
    if (m) {
      console.log(`  H5: rois=${payload.rois?.length} uid=${payload.rois?.[0]?.roiUid} mean=${m.mean} unit=${m.unit} area=${m.area}`);
      check(
        typeof m.mean === "number" && Math.abs(m.mean - dialogMean) < 1e-9,
        "H5 の平均が画面の値と一致する",
        { plugin: m.mean, screen: dialogMean },
      );
      pluginMean = typeof m.mean === "number" ? m.mean : null;
      // 🔎 表示用（data キー）と問い合わせ用（uid キー）の 2 つの読み口を並べて見る。
      const pair = await viewer.evaluate(
        `window.__graphyDebug ? window.__graphyDebug.getRoiStatsPair() : null`,
      );
      console.log(`  キャッシュの内訳: ${JSON.stringify(pair)}`);
      check(m.unit === "HU", "H5 の単位が HU（cachedStats 素通しでは空になっていた）", m.unit);
      check(typeof m.area === "number" && m.area > 0, "H5 の面積が mm² で入る", m.area);

    }

    // ── 4. 表示モード ──────────────────────────────────────────────
    console.log("\n[4] 表示モードの切り替え");
    await setStatsPlacement(viewer, /表示しない|Hidden/);
    await viewer.waitForTimeout(800);
    const offLines = await readTextBoxLines(viewer);
    check(!offLines.some((l) => MEAN.test(l)), "「表示しない」で ROI 脇の統計が消える", offLines);

    await setStatsPlacement(viewer, /右下に一覧|List at bottom right/);
    await viewer.waitForTimeout(1000);
    const cornerLines = await readTextBoxLines(viewer);
    check(!cornerLines.some((l) => MEAN.test(l)), "「右下に一覧」では ROI 脇に出さない", cornerLines);
    const cornerText = await viewer.evaluate(`
      (function () {
        var e = document.querySelector('[data-testid="roi-stats-corner"]');
        return e ? (e.textContent || "") : "";
      })()
    `) as string;
    check(/#1/.test(cornerText), "右下の一覧に #1 が出る", cornerText);
    check(/HU/.test(cornerText), "右下の一覧に統計が出る", cornerText);
    await viewer.screenshot({ path: path.join(OUT_DIR, "corner-mode.png") });

    await setStatsPlacement(viewer, /ROI の脇|Beside the ROI/);
    await viewer.waitForTimeout(800);
    const afterRerenderLines = await readTextBoxLines(viewer);
    check(afterRerenderLines.some((l) => MEAN.test(l)), "「ROI の脇」へ戻すと再び出る", afterRerenderLines);
    // 🔎 切り分けの決め手: **強制的に描き直した後**の画面は、どちらの値を言うか。
    //    H5 と同じ値になる → 図形が動いており、それまでの ROI 脇の表示が**古いまま**だった。
    //    元の値のまま      → 画面用と問い合わせ用でキャッシュが割れている。
    const afterRerenderMean = firstNumberAfter(afterRerenderLines, MEAN);
    console.log(`  再描画後の ROI 脇: mean=${afterRerenderMean}（初回 ${besideMean} / H5 ${pluginMean}）`);
    check(
      afterRerenderMean === besideMean,
      "再描画しても ROI 脇の平均が変わらない（＝図形は動いていない）",
      { first: besideMean, afterRerender: afterRerenderMean, plugin: pluginMean },
    );

    // ── 5. 未校正シリーズ（px 表示） ────────────────────────────────
    console.log("\n[5] 未校正シリーズでは mm を捏造しない");
    console.log("  [skip] fixture xa-no-geometry / pet-suv が未取得のため未検証");

    await viewer.close().catch(() => {});
  } finally {
    await d.stop();
  }

  console.log(`\n合計: ${passed} 件 ok / ${failures.length} 件 FAIL`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

/** 表示モードを ROI ツールメニューから切り替える。 */
async function setStatsPlacement(page: Page, labelRe: RegExp): Promise<void> {
  await page.getByTestId("viewer2d-menu-roiTools").click();
  await page.getByRole("button", { name: /統計の表示|Statistics display/ }).first().hover();
  await page.waitForTimeout(250);
  await page.getByRole("button", { name: labelRe }).first().click();
  await page.waitForTimeout(300);
}

/** `平均: 43.21 ± 11.83 HU` のような行から最初の数値を取る。 */
function firstNumberAfter(lines: string[], re: RegExp): number | null {
  for (const l of lines) {
    if (!re.test(l)) continue;
    const m = /(-?\d+(?:\.\d+)?)/.exec(l.replace(/^[^:：]*[:：]\s*/, ""));
    if (m) return Number(m[1]);
  }
  return null;
}

interface Payload {
  rois?: Array<{
    roiUid: string;
    tool: string;
    measurements: { mean?: number; unit?: string; area?: number };
  }>;
}

/** hostapi-check プラグインを起動して H5 の戻り値を読む（公式契約だけを使う）。 */
async function runPlugin(viewerPage: Page): Promise<Payload> {
  await viewerPage.evaluate(`delete window.__hostApiCheck`);
  await viewerPage.getByTestId("viewer2d-menu-plugins").click();
  await viewerPage.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewerPage.getByTestId("hostapi-check-panel").waitFor({ state: "visible", timeout: 10_000 });
  return viewerPage.evaluate(`window.__hostApiCheck`) as Promise<Payload>;
}

void main();
