/*
 * Fusion の差分・乗算の間、ROI 計測が背景画像を読んでいることを計測側に示すかの実機検証
 * （Chromium＋実 backend＋合成ファントム。画面に出た文字と、書き出した CSV で判定する）。
 *
 * 実行:  cd automator && npx tsx src/spike/fusionMeasureWarnCheck.ts
 *        （jar が要る: cd backend && mvn -q -Dfrontend.skip=true -DskipTests clean package）
 *
 * 確かめること（正例と負例の両方）:
 *  [1] 通常の Fusion／Fusion なし: 警告も CSV の追加列も出ない（負例）
 *  [2] 差分・乗算: ROI マネージャと統計ダイアログに警告が出て、計算元が「背景画像」と読め、CSV に 3 列が付く（正例）
 *  [3] 通常へ戻すと警告が消える
 *  [4] 演算結果を保存したシリーズを開いて測ると、警告は出ない（そのシリーズの画素そのものを測っている）
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { WebDriver } from "../driver/webDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "fusion-measure-warn");
const PHANTOM_DIR = path.join(OUT_DIR, "phantom");
const HOST = "viewer2d-canvas-host";
const { check, summary } = createChecker();
const py = process.env.GRAPHY_TEST_PYTHON ?? "python3";

async function openViewerWith(d: WebDriver, seriesText: RegExp): Promise<Page> {
  if ((await d.page.locator('[data-testid^="series-row-"]').count()) === 0) {
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.waitForTimeout(1500);
  }
  await d.page.locator('[data-testid^="series-row-"]').filter({ hasText: seriesText }).first().click();
  await d.page.waitForTimeout(2500);
  const v = await d.waitForNewPage(() => d.page.getByTestId("viewer2d-toolbar-button").click(), () => true, 30_000);
  await v.setViewportSize({ width: 1400, height: 900 });
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(3000);
  return v;
}

async function dropFusion(v: Page, fgText: RegExp): Promise<void> {
  const tile = v.getByTestId("series-viewer-root").first();
  const box = (await tile.boundingBox())!;
  await v.getByText(fgText).first().dragTo(tile, { targetPosition: { x: box.width / 2, y: box.height / 2 } });
  await v.getByTestId("fusion-blend").waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(3000);
}

async function drawRect(v: Page): Promise<void> {
  await v.getByTestId("viewer2d-menu-roi").click();
  await v.getByRole("button", { name: /矩形 ROI|Rectangle ROI/ }).first().click();
  await v.waitForTimeout(250);
  await dragOnCanvasHost(v, HOST, 90, 70, 0, 10, { fracX: 0.3, fracY: 0.3 });
  await v.waitForTimeout(800);
}

async function openRoiManager(v: Page): Promise<void> {
  if (await v.getByTestId("roi-mgr-save").isVisible().catch(() => false)) return;
  await v.getByTestId("viewer2d-menu-roiTools").click();
  await v.getByRole("button", { name: /ROI マネージャ|ROI manager/ }).first().click();
  await v.getByTestId("roi-mgr-save").waitFor({ state: "visible", timeout: 10_000 });
}

/** 統計ダイアログを開き、警告の有無・計算元の文言・CSV（クリップボード横取り）を返して閉じる。 */
async function statsDialog(v: Page, shot: string) {
  await v.getByTestId("roi-mgr-stats-all").click();
  await v.getByTestId("roi-stats-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await v.waitForTimeout(1500);
  const warn = await v.getByTestId("roi-stats-fusion-warn").count();
  const text = (await v.getByTestId("roi-stats-dialog").innerText()).replace(/\s+/g, " ");
  await v.evaluate(`(function(){ window.__csv = ""; navigator.clipboard.writeText = function(s){ window.__csv = s; return Promise.resolve(); }; })()`);
  await v.getByTestId("roi-stats-dialog").getByTitle(/CSV をクリップボード|Copy CSV/).first().click();
  await v.waitForTimeout(400);
  const csv = (await v.evaluate("window.__csv")) as string;
  await v.screenshot({ path: path.join(OUT_DIR, shot) });
  await v.getByTestId("roi-stats-dialog").getByTitle(/閉じる|Close/).first().click();
  await v.waitForTimeout(300);
  return { warn, text, csvHead: csv.split("\r\n")[0] ?? "", csvRow: csv.split("\r\n")[1] ?? "" };
}

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const gen = spawnSync(py, [path.join(AUTOMATOR_ROOT, "scripts", "make-fusion-calc-phantom.py"), PHANTOM_DIR], { encoding: "utf8" });
  if (gen.status !== 0) throw new Error(`ファントムを作れませんでした: ${gen.stderr}`);

  const d = new WebDriver({ http: 18640, scp: 18641, vite: 18643 }, { viewport: { width: 1400, height: 900 }, locale: "ja-JP" });
  await d.start();
  try {
    await resetDb(d.ports.http);
    await importPaths(d.ports.http, [PHANTOM_DIR]);
    await d.page.reload();
    await d.page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    await d.page.getByTestId("search-allperiod-chip").click();
    await d.page.getByTestId("search-submit-button").click();
    await d.page.locator('[data-testid^="study-row-"]').first().click();
    await d.page.waitForTimeout(1500);

    let v = await openViewerWith(d, /CT background/);
    await drawRect(v);
    await openRoiManager(v);

    console.log("\n[1] Fusion なし（負例）");
    check((await v.getByTestId("roi-mgr-fusion-warn").count()) === 0, "ROI マネージャに警告が出ない");
    const s0 = await statsDialog(v, "1-no-fusion.png");
    check(s0.warn === 0, "統計ダイアログに警告が出ない");
    check(!s0.csvHead.includes("measuredOn") && s0.csvHead.length > 0, "CSV に追加列が無い（読めている）", s0.csvHead.slice(-40));

    await dropFusion(v, /PT foreground/);
    console.log("\n[1b] 通常ブレンドの Fusion（負例）");
    check((await v.getByTestId("roi-mgr-fusion-warn").count()) === 0, "通常のときは ROI マネージャに警告が出ない");
    const s1 = await statsDialog(v, "1b-normal.png");
    check(s1.warn === 0 && !s1.csvHead.includes("measuredOn"), "通常のときは統計ダイアログ・CSV とも変化なし");

    console.log("\n[2] 差分（正例）");
    await v.getByTestId("fusion-blend").selectOption("difference");
    await v.waitForTimeout(1200);
    check((await v.getByTestId("roi-mgr-fusion-warn").count()) === 1, "ROI マネージャに警告が出る");
    const s2 = await statsDialog(v, "2-difference.png");
    check(s2.warn === 1, "統計ダイアログに警告が出る");
    check(/背景画像の画素の統計/.test(s2.text) && /差分/.test(s2.text) && /PT foreground/.test(s2.text), "警告の文言に『背景画像』『差分』前景名が入る", s2.text.slice(0, 300));
    check(/計算元（背景画像）/.test(s2.text), "計算元が『背景画像』と読める");
    check(s2.csvHead.endsWith("measuredOn,fusionBlend,fusionForeground"), "CSV の末尾に 3 列", s2.csvHead.slice(-60));
    check(/,background,difference,.*PT foreground/.test(s2.csvRow), "CSV の行に background / difference / 前景名", s2.csvRow.slice(-60));

    console.log("\n[2b] 乗算");
    await v.getByTestId("fusion-blend").selectOption("multiply");
    await v.waitForTimeout(1000);
    const s3 = await statsDialog(v, "2b-multiply.png");
    check(s3.warn === 1 && /乗算/.test(s3.text) && /,background,multiply,/.test(s3.csvRow), "乗算でも警告と CSV の記録が出る");

    console.log("\n[3] 通常へ戻す");
    await v.getByTestId("fusion-blend").selectOption("normal");
    await v.waitForTimeout(1000);
    check((await v.getByTestId("roi-mgr-fusion-warn").count()) === 0, "ROI マネージャの警告が消える");
    const s4 = await statsDialog(v, "3-back-normal.png");
    check(s4.warn === 0 && !s4.csvHead.includes("measuredOn"), "統計ダイアログの警告・CSV 列も消える");

    console.log("\n[4] 演算結果を保存したシリーズを開いて測る（負例）");
    await v.getByTestId("fusion-blend").selectOption("difference");
    await v.getByTestId("fusion-blend-save-image").click();
    await v.getByTestId("fusion-calc-dialog").waitFor({ state: "visible", timeout: 10_000 });
    await v.getByTestId("fusion-calc-output").filter({ hasText: /MB/ }).waitFor({ timeout: 60_000 });
    await v.getByTestId("fusion-calc-save").click();
    await v.getByTestId("fusion-calc-message").filter({ hasText: /保存しました/ }).waitFor({ timeout: 120_000 });
    await v.getByTestId("fusion-calc-close").click();
    await v.close();
    v = await openViewerWith(d, /CT background .* PT foreground|PT foreground .* CT background|CT background [-|]/);
    await drawRect(v);
    await openRoiManager(v);
    check((await v.getByTestId("roi-mgr-fusion-warn").count()) === 0, "保存したシリーズでは ROI マネージャに警告が出ない");
    const s5 = await statsDialog(v, "4-saved-series.png");
    check(s5.warn === 0 && !s5.csvHead.includes("measuredOn"), "保存したシリーズでは統計ダイアログ・CSV とも変化なし");
    await v.close();
  } finally {
    await d.stop();
  }
}

main()
  .then(() => process.exit(summary() === 0 ? 0 : 1))
  .catch((e) => {
    console.error(e);
    process.exit(2);
  });
