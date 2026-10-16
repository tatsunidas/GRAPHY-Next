/*
 * Wand のしきい値をモダリティごとに実機で確かめるスパイク（`fw/segmentation-tools-design.md` §6.1）。
 *
 * 実行:  cd automator && WAND_CASES=<dir> npx tsx src/spike/wandModalityCheck.ts
 *
 * WAND_CASES の下の各ディレクトリを 1 症例として、1 つずつ取り込み直して 2D ビューアで開き、
 *   1. 2D Wand で中央を押す → 判定値の種類・シード値・4 方式が押せるか・「校正値が無い」警告が無いか
 *   2. 以上（下限＝シード値）・範囲（シード値〜シード値）で塗れる（count ≥ 1）
 *   3. 負例: 範囲の下限 > 上限 では塗らず「シードが条件を満たさない」が出る
 *   4. CT の比較用: 許容差の既定値と、範囲 40〜200 の count（旧コードでも同じ手順で測る）
 *   5. 3D Wand を選んだときの扱い（動画は弾かれてトーストが出る・CT はダイアログが開く）
 * を測る。画面は WAND_OUT（既定 .results/wand-modality-check）に撮る。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const CASES = process.env.WAND_CASES;
if (!CASES) throw new Error("WAND_CASES を指定してください");
const OUT = process.env.WAND_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "wand-modality-check");
fs.mkdirSync(OUT, { recursive: true });

const vis = (p: Page, id: string) => p.getByTestId(id).isVisible().catch(() => false);
const text = async (p: Page, id: string) => ((await vis(p, id)) ? (await p.getByTestId(id).innerText()).trim() : null);

async function menu(page: Page, top: string, item: RegExp): Promise<void> {
  await page.getByTestId(`viewer2d-menu-${top}`).click();
  await page.getByRole("button", { name: item }).first().click();
  await page.waitForTimeout(600);
}

async function clickCenter(page: Page): Promise<void> {
  const cv = await page.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
  if (!cv) throw new Error("canvas がありません");
  await page.mouse.click(cv.x + cv.width / 2, cv.y + cv.height / 2);
}

async function setField(page: Page, id: string, v: string): Promise<void> {
  const f = page.getByTestId(id);
  await f.fill(v);
  await f.press("Enter");
  await page.waitForTimeout(1_500);
}

async function count(page: Page): Promise<number> {
  return Number(await text(page, "wand-count"));
}

const driver = new WebDriver(
  { http: 18190, scp: 18191, vite: 18193 },
  { viewport: { width: 1600, height: 900 }, locale: "ja-JP" },
);
const results: Record<string, unknown>[] = [];
try {
  await driver.start();
  const main = driver.page;
  await waitForMainScreenReady(main, 60_000);
  for (const name of fs.readdirSync(CASES).sort()) {
    const dir = path.join(CASES, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const r: Record<string, unknown> = { case: name };
    results.push(r);
    console.log(`\n== ${name}`);
    try {
      await resetDb(driver.ports.http);
      const imp = await importPaths(driver.ports.http, [dir]);
      r.imported = imp.imported;
      await main.reload();
      await waitForMainScreenReady(main, 60_000);
      await dismissStartupDialogs(main);
      await main.getByTestId("search-allperiod-chip").click();
      await main.getByTestId("search-submit-button").click();
      await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
      await main.locator('[data-testid^="series-row-"]').first().click({ timeout: 20_000 });
      const viewer = await driver.waitForNewPage(
        () => main.locator('button[title="2D Viewer"]').click(),
        (u) => u.includes("2dviewer"),
      );
      await viewer.locator('[data-testid="viewer2d-canvas-host"] canvas').first().waitFor({ timeout: 60_000 });
      await viewer.waitForTimeout(4_000);

      // ---- 2D Wand ----
      await menu(viewer, "roiTools", /^2D Wand/);
      await clickCenter(viewer);
      await viewer.getByTestId("wand-count").waitFor({ timeout: 60_000 });
      await viewer.waitForTimeout(1_500);
      r.valueKind = await text(viewer, "wand-value-kind");
      r.noCalibrationWarning = await vis(viewer, "wand-no-calibration");
      const methods: Record<string, boolean> = {};
      for (const m of ["tolerance", "ge", "le", "range"]) methods[m] = await viewer.getByTestId(`wand-method-${m}`).isEnabled();
      r.methodsEnabled = methods;
      r.toleranceDefault = await viewer.getByTestId("wand-threshold").inputValue();
      r.toleranceCount = await count(viewer);
      if (name.startsWith("ct")) {
        await setField(viewer, "wand-threshold", "50");
        r.ctTolerance50Count = await count(viewer);
      }
      await viewer.screenshot({ path: path.join(OUT, `${name}-tolerance.png`) });

      if (methods.ge) {
        await viewer.getByTestId("wand-method-ge").click();
        await viewer.waitForTimeout(1_500);
        const seed = await viewer.getByTestId("wand-threshold").inputValue();
        r.seed = seed;
        r.geAtSeedCount = await count(viewer);
        await viewer.screenshot({ path: path.join(OUT, `${name}-ge.png`) });
        await viewer.getByTestId("wand-method-range").click();
        await viewer.waitForTimeout(1_500);
        await setField(viewer, "wand-threshold-lower", seed);
        await setField(viewer, "wand-threshold-upper", seed);
        r.rangeAtSeedCount = await count(viewer);
        if (name.startsWith("ct")) {
          await setField(viewer, "wand-threshold-lower", "40");
          await setField(viewer, "wand-threshold-upper", "200");
          r.ctRange40to200Count = await count(viewer);
        }
        await viewer.screenshot({ path: path.join(OUT, `${name}-range.png`) });
        // 負例: 下限 > 上限
        await setField(viewer, "wand-threshold-upper", String(Number(seed) - 1));
        await setField(viewer, "wand-threshold-lower", String(Number(seed) + 1));
        r.invertedCount = await count(viewer);
        r.invertedSeedRejected = await vis(viewer, "wand-seed-rejected");
      }
      await viewer.getByTestId("wand-cancel").click();
      await viewer.waitForTimeout(800);

      // ---- 3D Wand ----
      await menu(viewer, "roiTools", /^3D Wand/);
      const toast = await text(viewer, "viewer2d-toast");
      r.wand3dToast = toast;
      await clickCenter(viewer);
      await viewer.waitForTimeout(4_000);
      r.wand3dDialog = await vis(viewer, "wand-count");
      if (r.wand3dDialog) r.wand3dTitle = (await viewer.locator("text=/Wand.*（3D）|Wand.*\\(3D\\)/").count()) > 0;
      await viewer.screenshot({ path: path.join(OUT, `${name}-wand3d.png`) });
      if (r.wand3dDialog) await viewer.getByTestId("wand-cancel").click();
      await viewer.close();
    } catch (e) {
      r.error = String(e).slice(0, 300);
    }
    console.log(JSON.stringify(r));
  }
} finally {
  await driver.stop();
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
}
