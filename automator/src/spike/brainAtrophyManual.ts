/*
 * 脳萎縮定量プラグインの「人が触って確かめる」ための起動（自動検査はしない）。
 *   プラグインを導入 → 症例（IXI175、3T・Philips の DICOM）を取り込み → 基準ファイルのパスを記憶に入れる → ビューアを開く → 人が閉じるまで待つ。
 * 実行:  cd automator && BA_DICOM=<DICOM フォルダ> BA_DB=… BA_HIPPO_DB=… BA_VOI_DB=… BA_GN_DB=… \
 *          GRAPHY_AUTOMATOR_HTTP_PORT=18950 GRAPHY_AUTOMATOR_SCP_PORT=18951 GRAPHY_AUTOMATOR_VITE_PORT=18953 \
 *          PATH=<解析の Python の bin>:$PATH npx tsx src/spike/brainAtrophyManual.ts
 * 終了: アプリの窓を閉じる、またはこのプロセスを kill する。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const PLUGIN_ID = "vis-brain-atrophy";
const PLUGIN_REPO = path.resolve(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-brain-atrophy");
const need = (k: string): string => { const v = process.env[k]; if (!v) throw new Error(`${k} を設定してください`); return v; };

async function main(): Promise<void> {
  const dicomDir = need("BA_DICOM");
  const paths = { db: need("BA_DB"), hippo: process.env.BA_HIPPO_DB ?? null, voi: process.env.BA_VOI_DB ?? null, gn: process.env.BA_GN_DB ?? null };
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_REPO, n), path.join(dst, n));
  console.log(`plugin installed: ${dst}`);

  const driver = new DesktopDriver();
  await driver.start();
  const closed = new Promise<void>((res) => driver.app.on("close", () => res()));
  const main = driver.page;
  await resetDb(driver.ports.http);
  console.log(`import: ${JSON.stringify(await importPaths(driver.ports.http, [dicomDir]))}`);
  await main.reload({ waitUntil: "domcontentloaded" });
  await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  // 基準ファイルの場所を、プラグインの記憶（localStorage）へ入れておく（選び直さなくて済む）
  await main.evaluate((p) => localStorage.setItem("vis-brain-atrophy:paths", JSON.stringify({ db: p.db, hippo: p.hippo, voi: p.voi, gn: p.gn })), paths);
  const rec = createStepRecorder();
  await selectFirstStudy(main, rec);
  const seriesRow = main.locator('[data-testid^="series-row-"]').first();
  await seriesRow.waitFor({ state: "visible", timeout: 15_000 });
  await seriesRow.click();
  // 2D ビューアを開いて、起動直後の画面を撮る（向きの確認用）
  const viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await viewer.waitForTimeout(2500);
  const shot = path.join(AUTOMATOR_ROOT, ".results", "brain-atrophy-manual.png");
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await viewer.screenshot({ path: shot });
  console.log(`SCREENSHOT: ${shot}`);
  console.log("READY: 症例を選択済み。2D Viewer は開いてあります。メニューの 解析 > 脳萎縮定量 から実行してください");
  await Promise.race([closed, new Promise<void>((res) => setTimeout(res, 4 * 3600 * 1000))]);
  await driver.stop();
}

main().catch((e) => { console.error(e); process.exit(1); });
