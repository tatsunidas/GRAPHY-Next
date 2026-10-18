/*
 * しきい値ダイアログ（範囲内の画素をアクティブ segment に塗る）を実機で確かめるスパイク（`fw/segmentation-tools-design.md` §5.2）。
 *
 * 実行:  cd automator && GRAPHY_DICOM_SCP_PORT=18491 npx tsx src/spike/thresholdCheck.ts
 *
 * 合成 CT（`scripts/make-ct-quant-phantom.py`、128×112×40、保存値は slope 2・intercept −1024）を取り込み、2D ビューアで
 * メニュー「しきい値…」を開き、labelmap を `window.__graphyDebug.getSegCounts` で数える。期待値はファントムの定義
 * （直方体の HU・範囲）から解析的に出し、ツールの計算とは独立にする:
 *   muscle 50 HU  k 8..19   行 50..69  列 15..44   → 1 枚 600 画素
 *   liver  60 HU  k 2..37   行 10..59  列 70..109  → 1 枚 2000 画素
 *   mixed  40 HU（列 60..79）/ −120 HU（列 80..99）  k 25..34  行 75..99 → 40 HU 側は 1 枚 500 画素
 *   fat   −100 HU  k 5..24   空気 −1000 HU
 * 範囲 [40, 70]: スライス 12 は 600 + 2000 = 2600、全スライスは 600×12 + 2000×36 + 500×10 = 84200。
 * 範囲 [41, 70]（40 HU ちょうどの mixed を外す境界の負例）: 全スライスは 600×12 + 2000×36 = 79200。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT = process.env.THRESHOLD_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "threshold-check");
fs.mkdirSync(OUT, { recursive: true });
const CASE = path.join(OUT, "phantom");
execFileSync("python3", [path.join(AUTOMATOR_ROOT, "scripts", "make-ct-quant-phantom.py"), CASE], { stdio: "ignore" });

const { check, summary } = createChecker();
const vis = (p: Page, id: string) => p.getByTestId(id).isVisible().catch(() => false);

type Counts = { slices: { index: number; counts: Record<string, number> }[]; total: Record<string, number> } | null;
const counts = (p: Page): Promise<Counts> => p.evaluate(() => (window as any).__graphyDebug.getSegCounts());
const total1 = (c: Counts) => c?.total["1"] ?? 0;
const sliceIdx = (c: Counts) => (c?.slices ?? []).filter((s) => (s.counts["1"] ?? 0) > 0).map((s) => s.index);

async function menu(page: Page, item: RegExp): Promise<void> {
  await page.getByTestId("viewer2d-menu-roiTools").click();
  await page.getByRole("button", { name: item }).first().click();
  await page.waitForTimeout(1_500);
}

async function gotoSlice(page: Page, k: number): Promise<void> {
  await page.evaluate((v) => {
    const el = document.querySelector('input[type="range"]') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, k);
  await page.waitForTimeout(1_200);
}

async function setField(page: Page, id: string, v: string): Promise<void> {
  const f = page.getByTestId(id);
  await f.fill(v);
  await f.press("Enter");
  await page.waitForTimeout(1_500);
}
const shownCount = async (p: Page) => Number((await p.getByTestId("threshold-count").innerText()).trim());

const driver = new WebDriver({ http: 18490, scp: 18491, vite: 18493 }, { viewport: { width: 1600, height: 900 }, locale: "ja-JP" });
try {
  await driver.start();
  const main = driver.page;
  await waitForMainScreenReady(main, 60_000);
  await resetDb(driver.ports.http);
  const imp = await importPaths(driver.ports.http, [CASE]);
  check(imp.imported > 0, "合成 CT を取り込めた", imp);
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

  const K = 12;
  await gotoSlice(viewer, K);
  // 対象タイルを操作したことにする（W/L ツールのまま画像を 1 回押す。何も描かない）
  const cv = await viewer.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
  await viewer.mouse.click(cv!.x + 5, cv!.y + 5);
  check(!(await vis(viewer, "threshold-dialog")), "開く前はダイアログが出ない");

  await menu(viewer, /^しきい値/);
  check(await vis(viewer, "threshold-dialog"), "メニューからダイアログが開く");
  check(((await viewer.getByTestId("threshold-value-kind").innerText()) || "").includes("HU"), "判定値は Rescale 適用値（HU）と表示される");
  const c0 = await counts(viewer);
  check(total1(c0) === 0, "触るまでは何も塗られていない（対照）", c0?.total);
  await viewer.screenshot({ path: path.join(OUT, "01-open.png") });

  // 範囲 [40, 70]・現在スライス
  await setField(viewer, "threshold-lower", "40");
  await setField(viewer, "threshold-upper", "70");
  const c1 = await counts(viewer);
  console.log("slice", K, "shown", await shownCount(viewer), "labelmap", total1(c1), "slices", sliceIdx(c1));
  check(total1(c1) === 2600, "現在スライス [40,70]: muscle 600 + liver 2000 = 2600 画素（保存値のままなら合わない）", total1(c1));
  check((await shownCount(viewer)) === total1(c1), "ダイアログの件数と labelmap の個数が一致");
  check(sliceIdx(c1).length === 1 && sliceIdx(c1)[0] === K, "他のスライスは空", sliceIdx(c1));
  await viewer.screenshot({ path: path.join(OUT, "02-slice.png") });

  // 全スライス
  await viewer.getByTestId("threshold-scope-all").click();
  await viewer.waitForTimeout(4_000);
  const c2 = await counts(viewer);
  console.log("all", total1(c2), "slices", sliceIdx(c2).length);
  check(total1(c2) === 84200, "全スライス [40,70]: 7200 + 72000 + 5000 = 84200 画素", total1(c2));

  // 境界の負例: 40 HU ちょうどの mixed を外す
  await setField(viewer, "threshold-lower", "41");
  await viewer.waitForTimeout(3_000);
  const c3 = await counts(viewer);
  check(total1(c3) === 79200, "下限を 41 にすると、40 HU ちょうどの画素（5000）が外れる = 79200", total1(c3));

  // 下限 > 上限
  await setField(viewer, "threshold-lower", "80");
  await setField(viewer, "threshold-upper", "40");
  await viewer.waitForTimeout(2_000);
  const c4 = await counts(viewer);
  check(await vis(viewer, "threshold-invalid"), "下限 > 上限で警告が出る");
  check(total1(c4) === 0, "下限 > 上限では何も塗られない（前回の結果も戻る）", total1(c4));
  await viewer.screenshot({ path: path.join(OUT, "03-invalid.png") });

  // 取消: 元に戻る
  await setField(viewer, "threshold-lower", "40");
  await setField(viewer, "threshold-upper", "70");
  await viewer.waitForTimeout(3_000);
  check(total1(await counts(viewer)) === 84200, "範囲を戻すと 84200 に戻る");
  await viewer.getByTestId("threshold-cancel").click();
  await viewer.waitForTimeout(1_500);
  check(!(await vis(viewer, "threshold-dialog")), "取消でダイアログが閉じる");
  check(total1(await counts(viewer)) === 0, "取消で labelmap が元（空）に戻る", total1(await counts(viewer)));

  // 適用: 結果が残る（現在スライスの 2600）
  await menu(viewer, /^しきい値/);
  await setField(viewer, "threshold-lower", "40");
  await setField(viewer, "threshold-upper", "70");
  await viewer.getByTestId("threshold-commit").click();
  await viewer.waitForTimeout(1_500);
  const c5 = await counts(viewer);
  check(!(await vis(viewer, "threshold-dialog")), "適用でダイアログが閉じる");
  check(total1(c5) === 2600, "適用すると結果が残る（2600）", total1(c5));
  await gotoSlice(viewer, K);
  await viewer.screenshot({ path: path.join(OUT, "04-applied.png") });
  console.log("未達: 別 segment の不変（segment を 2 つ作る操作が未自動化）、Windows・macOS");
} finally {
  const failed = summary();
  await driver.stop();
  process.exitCode = failed ? 1 : 0;
}
