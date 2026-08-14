/*
 * XA の空間校正（A3）の実機検証 — `fw/angio-design.md` §7.6 の受け入れ条件 7 項目。
 *
 * 実行:  cd automator && npx tsx src/spike/xaCalibCheck.ts
 *
 * 使うデータ: Rubo 0002.DCM。**空間校正タグ（PixelSpacing / ImagerPixelSpacing / SID / SOD /
 * 拡大率）を 1 つも持たない**ので、連鎖は P7（未校正）に落ちる ＝ **px 表示になるのが正しい**。
 * そこへ Length 計測を引いてカテーテル校正（6Fr = 2.0mm）を当て、mm 表示に変わることを見る。
 *
 * ⚠️ 「mm と出た」で通さない。**校正に使った線分自体が 2.0mm と出る**ことまで数値で確かめる
 *    （校正値が間違っていても mm 表示にはなる）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "xa-calib");
const XA_DIR = path.join(AUTOMATOR_ROOT, "fixtures", "xa-angio");
const SAMPLE = "0002.DCM";
const HOST = "viewer2d-canvas-host";
/** カテーテル外径 6Fr = 6/3 = 2.0 mm。 */
const CATHETER_FR = 6;
const CATHETER_MM = CATHETER_FR / 3;

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

/** スケールバーのラベル（"100 px" / "20 mm" など）。 */
async function scaleBarLabel(page: Page): Promise<string | null> {
  const el = page.getByTestId("scale-bar").first();
  if ((await el.count()) === 0) return null;
  return (await el.textContent())?.trim() ?? null;
}

/** Length 計測の表示値（"12.3 px" / "2.00 mm"）を SVG のテキストから拾う。 */
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

/** 計測値を数値と単位に分解する。 */
function parseMeasure(label: string): { value: number; unit: string; type: string | null } | null {
  // Cornerstone は校正種別を単位に付ける（"2.00 mm User" / "318 px"）。
  const m = /([\d.]+)\s*(mm|px)(?:\s+(\S+))?/.exec(label);
  return m ? { value: Number(m[1]), unit: m[2], type: m[3] ?? null } : null;
}

async function dismissStartupDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const dialog = page.locator('[role="dialog"]');
    if ((await dialog.count()) === 0) return;
    const close = dialog.first().getByRole("button", { name: /閉じる|Close/ });
    if ((await close.count()) > 0) await close.first().click().catch(() => {});
    else await page.mouse.click(5, 5).catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const sample = path.join(XA_DIR, SAMPLE);
  if (!fs.existsSync(sample)) {
    throw new Error(`XA サンプルがありません: ${sample}`);
  }

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
    const dateInputs = main.locator('input[type="date"]');
    await dateInputs.nth(0).fill("");
    await dateInputs.nth(1).fill("");
    await main.getByTestId("search-submit-button").click();
    const studyRow = main.locator('[data-testid^="study-row-"]').first();
    await studyRow.waitFor({ state: "visible", timeout: 30_000 });
    await studyRow.click();
    const seriesRow = main.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 20_000 });
    await seriesRow.click();

    // 計測ツールが要るので 2D Viewer 画面を開く（インライン表示のツールバーには計測が無い）。
    const viewer = await driver.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await viewer.waitForTimeout(3_000);

    // ── 条件 1/2: 未校正なら px 表示 ────────────────────────────────
    const bar0 = await scaleBarLabel(viewer);
    check(!!bar0 && /px/.test(bar0), "[1] 未校正の XA ではスケールバーが px 表示", bar0);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-uncalibrated.png") }).catch(() => {});

    // 情報パネル（Info）に校正の出自が出ること。
    const infoBtn = viewer.getByRole("button", { name: "Info" }).first();
    if ((await infoBtn.count()) > 0) {
      await infoBtn.click().catch(() => {});
      await viewer.waitForTimeout(600);
    }
    const panelText = (await viewer.getByTestId("series-viewer-root").first().textContent()) ?? "";
    check(
      panelText.includes("未校正") || panelText.includes("Uncalibrated"),
      "[2] 情報パネルに「未校正」と出る",
      panelText.includes("未校正"),
    );

    // ── Length 計測を引く ───────────────────────────────────────────
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.waitForTimeout(300);
    await viewer.getByText("長さ", { exact: true }).first().click();
    await viewer.waitForTimeout(400);
    // 水平に 120px 引く（校正の分母になる線分）。
    await dragOnCanvasHost(viewer, HOST, 120, 0, 0, 10, { fracX: 0.3, fracY: 0.35 });
    await viewer.waitForTimeout(1_200);
    const before = await lengthLabels(viewer);
    const beforeM = before.map(parseMeasure).find(Boolean) ?? null;
    check(!!beforeM && beforeM.unit === "px", "[1b] 計測値も px 単位で出る", before);
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-length-px.png") }).catch(() => {});

    // ── 条件 3/4/5/6: カテーテル校正 ────────────────────────────────
    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.waitForTimeout(800);
    await viewer.getByTestId("xa-analysis-dialog").waitFor({ state: "visible", timeout: 10_000 });
    check(true, "[3a] 校正 / QCA ダイアログが開く");
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-dialog.png") }).catch(() => {});

    // Fr を入れて「カテーテルで校正」。
    await viewer.getByTestId("xa-catheter-fr").fill(String(CATHETER_FR));
    await viewer.getByTestId("xa-calibrate-catheter").click();
    await viewer.waitForTimeout(1_500);

    const dialogText = (await viewer.getByTestId("xa-calib-status").textContent()) ?? "";
    check(
      /カテーテル法|Catheter calibration/.test(dialogText),
      "[6] 校正の出自が「カテーテル法」になる",
      dialogText.slice(0, 160),
    );
    const mmPerPx = /([\d.]+)\s*mm\/px/.exec(dialogText);
    check(!!mmPerPx, "[3b] mm/px が確定した", mmPerPx?.[1]);

    // ダイアログを閉じて表示を見る。
    await viewer.getByTestId("xa-dialog-close").click();
    await viewer.waitForTimeout(1_500);

    const bar1 = await scaleBarLabel(viewer);
    check(!!bar1 && /(mm|cm)/.test(bar1), "[4] 校正後はスケールバーが mm（cm）表示", bar1);

    const after = await lengthLabels(viewer);
    const afterM = after.map(parseMeasure).find(Boolean) ?? null;
    check(!!afterM && afterM.unit === "mm", "[5a] 計測値が mm 単位になる", after);
    // ★ 校正に使った線分そのものなので、値は 6Fr = 2.0mm でなければならない。
    check(
      !!afterM && Math.abs(afterM.value - CATHETER_MM) < 0.05,
      `[5b] 校正に使った線分が ${CATHETER_MM} mm と出る（校正値の整合）`,
      { measured: afterM?.value, expected: CATHETER_MM },
    );
    check(
      afterM?.type === "User",
      "[5c] 計測ラベルに校正種別（User）が出る",
      { label: after[0], type: afterM?.type },
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-calibrated.png") }).catch(() => {});

    // ── 条件 7: 解除 ───────────────────────────────────────────────
    await viewer.getByTestId("xa-analysis-open").click();
    await viewer.waitForTimeout(800);
    await viewer.getByTestId("xa-clear-calibration").click();
    await viewer.waitForTimeout(1_000);
    await viewer.getByTestId("xa-dialog-close").click();
    await viewer.waitForTimeout(1_500);
    const bar2 = await scaleBarLabel(viewer);
    check(!!bar2 && /px/.test(bar2), "[7] 校正解除で px 表示に戻る", bar2);
    await viewer.screenshot({ path: path.join(OUT_DIR, "5-cleared.png") }).catch(() => {});
  } finally {
    await driver.stop();
  }

  console.log(`\n===== 空間校正（A3）受け入れ条件 =====`);
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
