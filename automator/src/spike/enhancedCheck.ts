/**
 * 実機確認: Enhanced CT/MR のマルチフレームが、スライスとして開けるか。
 * 実行: GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *       ENH_FILE=<Enhanced の .dcm> [OUT=name] npx tsx src/spike/enhancedCheck.ts
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

const FILE: string = process.env.ENH_FILE ?? "";
if (!FILE) throw new Error("ENH_FILE を指定してください");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", process.env.OUT ?? "enhanced");

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e.stack ?? e).slice(0, 1500)));
    page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE:", m.text().slice(0, 300)); });
    page.on("response", (r) => { if (r.url().includes("/api/instances/")) console.log("REQ:", r.status(), r.url().slice(-90)); });
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
    const ind = async () => (await page.locator('[data-testid^="dim-slider"], [data-testid="cine-indicator"]').allTextContents()).map((t) => t.replace(/\s+/g, " ").trim()).join(" | ");
    console.log("スライダー表示:", await ind());
    await page.getByTestId("series-viewer-root").first().screenshot({ path: path.join(OUT_DIR, "slice1.png") });
    const box = await page.locator("canvas").first().boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(1_500);
      console.log("ホイール後:", await ind());
      await page.getByTestId("series-viewer-root").first().screenshot({ path: path.join(OUT_DIR, "slice2.png") });
    }
  } finally {
    await driver.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
