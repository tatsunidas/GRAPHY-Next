/*
 * 画素間隔の照合: 校正した画像で、Cornerstone の world がどの間隔を基準にしているかを実機で確かめる。
 *
 * 実行:  cd automator && npx tsx src/spike/spacingCalibrationCheck.ts
 *
 * データ: automator/fixtures/spacing-calib/（pydicom で合成。縦横の間隔が違う XA・DX・US と、対照の CT）
 *   xa.dcm  ImagerPixelSpacing [0.3, 0.2]（縦・横）・IPP/IOP なし
 *   dx.dcm  ImagerPixelSpacing [0.2, 0.1]・IPP/IOP なし
 *   us.dcm  超音波の領域 PhysicalDeltaX 0.01 cm・PhysicalDeltaY 0.02 cm
 *   ct.dcm  PixelSpacing [0.9, 0.6]・IPP/IOP あり（対照）
 *
 * 各画像で window.__graphyDebug.getSpacingProbe() を読み、描画の間隔・画像に付いた間隔・imagePlaneModule・
 * loaderSpacingFor と、既知の画素 (10, 20) を world 経由で戻した値を記録する。
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT, FIXTURES_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "spacing-calibration");

async function openViewer(driver: DesktopDriver, page: Page, studyUid: string, seriesUid: string): Promise<Page> {
  await dismissStartupDialogs(page);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  await page.locator(`[data-testid="study-row-${studyUid}"]`).click();
  await page.locator(`[data-testid="series-row-${seriesUid}"]`).click();
  const viewer = await driver.waitForNewPage(
    () => page.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await viewer.waitForTimeout(3_000);
  return viewer;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  const rows: unknown[] = [];
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await importPaths(driver.ports.http, [path.join(FIXTURES_ROOT, "spacing-calib")]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const base = `http://localhost:${driver.ports.http}`;
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
    for (const st of studies.sort((a, b) => a.patientId.localeCompare(b.patientId))) {
      const series = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
      const viewer = await openViewer(driver, page, st.studyInstanceUid, series[0].seriesInstanceUid);
      const probe = await viewer.evaluate(() => (window as unknown as { __graphyDebug: { getSpacingProbe: () => unknown[] } }).__graphyDebug.getSpacingProbe());
      const p = (probe as Record<string, unknown>[])[0];
      console.log(`\n[${st.patientId}]\n${JSON.stringify(p, null, 1)}`);
      // XA は読み込みの後でカテーテル校正（0.25 mm/px）した場合も測る（横 40 px → 10 mm・縦 20 px → 5 mm が正しい）
      const user = st.patientId.startsWith("SPC-XA")
        ? await viewer.evaluate(() => (window as unknown as { __graphyDebug: { probeUserCalibration: (m: number) => unknown } }).__graphyDebug.probeUserCalibration(0.25))
        : null;
      if (user) console.log(`  user calibration 0.25 mm/px: ${JSON.stringify(user)}`);
      rows.push({ patientId: st.patientId, ...p, userCalibration: user });
      await viewer.screenshot({ path: path.join(OUT_DIR, `${st.patientId}.png`) });
      await viewer.close();
    }
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "probe.json"), JSON.stringify(rows, null, 2));
    await driver.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
