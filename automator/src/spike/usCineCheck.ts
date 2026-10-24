/**
 * 実機確認: US マルチフレーム（心エコーのシネ）が、フレーム列として開けるか。
 * 実行: GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *       US_FILE=<US マルチフレームの .dcm> [OUT=name] npx tsx src/spike/usCineCheck.ts
 * 出力: .results/<OUT>/ にスクリーンショット。標準出力に、枚数・フレーム表示・XA ボタンの有無。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const FILE: string = process.env.US_FILE ?? "";
if (!FILE) throw new Error("US_FILE を指定してください");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", process.env.OUT ?? "us-cine");

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 300)));
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    await fetch(`http://127.0.0.1:${driver.ports.http}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "viewer.toolPanelDefault": "true" }),
    });
    const imp = await importPaths(driver.ports.http, [FILE]);
    console.log("import", JSON.stringify({ imported: imp.imported, failed: imp.failed }));
    await waitForMainScreenReady(page, 60_000);
    await dismissStartupDialogs(page);
    await page.getByRole("button", { name: /^(All|全期間)$/ }).click();
    await page.getByTestId("search-submit-button").click();
    const studyRow = page.locator('[data-testid^="study-row-"]').first();
    await studyRow.waitFor({ state: "visible", timeout: 20_000 });
    await studyRow.click();
    const seriesRow = page.locator('[data-testid^="series-row-"]').first();
    await seriesRow.waitFor({ state: "visible", timeout: 20_000 });
    console.log("シリーズ表:", (await page.locator("table").nth(1).innerText()).replace(/\s+/g, " ").slice(0, 200));
    await seriesRow.click();
    await page.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(4_000);
    const vis = async (id: string) => page.getByTestId(id).first().isVisible().catch(() => false);
    const ind = async () => ((await page.getByTestId("cine-indicator").first().textContent().catch(() => null)) ?? "(なし)").trim();
    console.log("フレーム表示:", await ind());
    console.log("shot スライダー:", (await vis("dim-slider-other")) || (await vis("dim-slider-other-compact")));
    console.log("XA 解析ボタン(xa-analysis-open):", await vis("xa-analysis-open"), " DSA チェック:", await vis("dsa-check"));
    await page.screenshot({ path: path.join(OUT_DIR, "frame1.png") });
    if (await vis("cine-jump")) {
      const jump = page.getByTestId("cine-jump").first();
      await jump.fill("60");
      await jump.press("Enter");
      await page.waitForTimeout(2_000);
      console.log("フレーム 60 を指定 →", await ind());
      await page.screenshot({ path: path.join(OUT_DIR, "frame60.png") });
    }
  } finally {
    await driver.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
