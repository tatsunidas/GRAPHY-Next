/*
 * 空間校正ダイアログ（`XaCalibrationDialog`）の実機検証 — 2D/3D QCA を本体から外したあとの校正の入口。
 *
 * 実行:  cd automator && XA_CALIB_DIR=<DICOM のあるフォルダ> [XA_CALIB_FILE=Case2_A.dcm] npx tsx src/spike/xaCalibrationDialogCheck.ts
 *        既定のフォルダは ~/graphy_sample_images/virtual-vessel（合成画素・実症例のタグ入り。リポジトリには入れない）。
 *
 * 確かめること（数値で。「mm と出た」だけで通さない）:
 *  1. 旧入口（2D QCA・3D QCA・分岐部のボタン）が出ていない。
 *  2. 直線が無いときは理由が出て、校正ボタンは押せない（負例）。
 *  3. 直線を引くと候補に出て、カテーテル校正（6Fr = 2.0 mm）で**その線自体が 2.0 mm**と出る。
 *  4. ルーラー校正（既知長 10 mm）で**その線自体が 10 mm**と出る。
 *  5. 解除すると校正前の出自・値に戻る。
 *  6. 確定した校正はビューアを再読込しても残る（保存まで含めて確定する）。
 *  7. QLV のダイアログが開く（校正を使う本体の解析が壊れていない）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-calibration-dialog");
const DIR = process.env.XA_CALIB_DIR ?? path.join(os.homedir(), "graphy_sample_images", "virtual-vessel");
const FILE = process.env.XA_CALIB_FILE ?? "Case2_A.dcm";
const HOST = "viewer2d-canvas-host";
const CATHETER_FR = 6;
const CATHETER_MM = CATHETER_FR / 3;
const RULER_MM = 10;

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/** Length 計測の表示値（"2 mm User" / "318 px"）を SVG のテキストから拾う。 */
async function lengthLabels(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    document.querySelectorAll("svg text").forEach((t) => {
      const s = (t.textContent ?? "").trim();
      if (/\d/.test(s) && /(mm|px)/.test(s)) out.push(s);
    });
    return out;
  });
}
function parseMeasure(label: string): { value: number; unit: string; type: string | null } | null {
  const m = /([\d.]+)\s*(mm|px)(?:\s+([A-Za-z]+))?/.exec(label);
  return m ? { value: Number(m[1]), unit: m[2], type: m[3] ?? null } : null;
}
const firstMeasure = async (page: Page) => (await lengthLabels(page)).map(parseMeasure).find(Boolean) ?? null;

async function status(page: Page): Promise<string> {
  return ((await page.getByTestId("xa-calib-status").textContent()) ?? "").replace(/\s+/g, " ").trim();
}
async function openDialog(page: Page): Promise<void> {
  await page.getByTestId("xa-calibration-open").click();
  await page.getByTestId("xa-calibration-dialog").waitFor({ state: "visible", timeout: 10_000 });
}
async function closeDialog(page: Page): Promise<void> {
  await page.getByTestId("xa-calibration-close").click();
  await page.getByTestId("xa-calibration-dialog").waitFor({ state: "detached", timeout: 10_000 });
  await page.waitForTimeout(1_200);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(DIR, FILE);
  if (!fs.existsSync(sample)) throw new Error(`DICOM がありません: ${sample}`);

  const driver = new DesktopDriver();
  await driver.start();
  try {
    const main = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [sample]);
    if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
    await waitForMainScreenReady(main, 60_000);
    await dismissStartupDialogs(main);
    main.once("dialog", (d) => void d.accept());
    const dates = main.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await main.getByTestId("search-submit-button").click();
    const studyRow = main.locator('[data-testid^="study-row-"]').first();
    await studyRow.waitFor({ state: "visible", timeout: 30_000 });
    await studyRow.click();
    const seriesRow = main.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 20_000 });
    await seriesRow.click();
    const viewer = await driver.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    // ── 1. 旧入口が無い ───────────────────────────────────────────
    for (const id of ["xa-analysis-open", "xa3d-open", "xa3dbif-open"]) {
      check((await viewer.getByTestId(id).count()) === 0, `[1] 旧入口 ${id} が出ていない`);
    }
    check((await viewer.getByTestId("xa-calibration-open").count()) === 1, "[1] 校正ボタンが出ている");

    // ── 2. 直線が無いとき（負例）────────────────────────────────────
    await openDialog(viewer);
    check((await viewer.getByTestId("xa-calib-need-line").count()) === 1, "[2] 直線が無いと理由が出る");
    check(await viewer.getByTestId("xa-calibrate-catheter").isDisabled(), "[2] カテーテル校正ボタンは押せない");
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-no-line.png") }).catch(() => {});
    await closeDialog(viewer);

    // ── 3. 直線を引いてカテーテル校正 ──────────────────────────────
    await viewer.getByTestId("viewer2d-menu-measure").click();
    await viewer.waitForTimeout(300);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(400);
    await dragOnCanvasHost(viewer, HOST, 120, 0, 0, 10, { fracX: 0.3, fracY: 0.35 });
    await viewer.waitForTimeout(1_200);
    const before = await firstMeasure(viewer);
    check(!!before, "[3] 長さの計測を引けた", before);

    await openDialog(viewer);
    const status0 = await status(viewer);
    const opts = await viewer.getByTestId("xa-calib-pick").locator("option").allTextContents();
    check(opts.length === 1 && opts[0].trim().startsWith("#1"), "[3] 直線が校正の候補に 1 本出る", opts);
    check(!(await viewer.getByTestId("xa-calibrate-catheter").isDisabled()), "[3] カテーテル校正ボタンが押せる");
    await viewer.getByTestId("xa-catheter-fr").fill(String(CATHETER_FR));
    await viewer.getByTestId("xa-calibrate-catheter").click();
    await viewer.waitForTimeout(1_500);
    const status1 = await status(viewer);
    check(/カテーテル法|Catheter/.test(status1), "[3] 校正の出自が「カテーテル法」になる", status1);
    check(status1 !== status0, "[3] 校正前と状態表示が変わる", { status0, status1 });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-catheter.png") }).catch(() => {});
    await closeDialog(viewer);
    const m1 = await firstMeasure(viewer);
    check(!!m1 && m1.unit === "mm" && Math.abs(m1.value - CATHETER_MM) < 0.05, `[3] 校正に使った線そのものが ${CATHETER_MM} mm と出る`, m1);
    check(m1?.type === "User", "[3] 計測ラベルに校正種別（User）が出る", m1);

    // ── 4. ルーラー校正 ───────────────────────────────────────────
    await openDialog(viewer);
    await viewer.getByTestId("xa-known-mm").fill(String(RULER_MM));
    await viewer.getByTestId("xa-calibrate-ruler").click();
    await viewer.waitForTimeout(1_500);
    const status2 = await status(viewer);
    check(/ルーラー法|Ruler/.test(status2), "[4] 校正の出自が「ルーラー法」になる", status2);
    await closeDialog(viewer);
    const m2 = await firstMeasure(viewer);
    check(!!m2 && m2.unit === "mm" && Math.abs(m2.value - RULER_MM) < 0.05, `[4] 校正に使った線そのものが ${RULER_MM} mm と出る`, m2);

    // ── 6. 再読込しても残る（解除より前に確かめる）──────────────────────
    if (!process.env.XA_CALIB_NO_RELOAD) {
      await viewer.reload();
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
      await viewer.waitForTimeout(3_000);
      console.log("  再読込直後の計測ラベル:", JSON.stringify(await lengthLabels(viewer)));
    }
    await openDialog(viewer);
    const status3 = await status(viewer);
    check(/ルーラー法|Ruler/.test(status3), "[6] 再読込しても校正が残る", status3);

    // ── 5. 解除 ───────────────────────────────────────────────────
    await viewer.getByTestId("xa-clear-calibration").click();
    await viewer.waitForTimeout(1_200);
    const status4 = await status(viewer);
    check(status4 === status0, "[5] 解除すると校正前の状態表示に戻る", { status0, status4 });
    await closeDialog(viewer);
    const m3 = await firstMeasure(viewer);
    check(!!m3 && !!before && m3.unit === before.unit && Math.abs(m3.value - before.value) < 0.05, "[5] 計測値も校正前の値に戻る", { before, m3 });
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-cleared.png") }).catch(() => {});

    // ── 7. QLV が開く ─────────────────────────────────────────────
    const qlv = viewer.getByTestId("qlv-open");
    if ((await qlv.count()) === 1 && !(await qlv.isDisabled())) {
      await qlv.click();
      const opened = await viewer.getByTestId("qlv-dialog").waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false);
      check(opened, "[7] QLV のダイアログが開く");
      if (opened) await viewer.getByTestId("qlv-close").click();
    } else {
      console.log("  [未達] [7] QLV ボタンが無効（フレーム数が足りない）— 合格には数えない");
    }
  } finally {
    await driver.stop();
  }

  console.log(`\n===== 空間校正ダイアログ =====`);
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗した項目:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
  console.log(`スクリーンショット: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
