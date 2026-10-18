/*
 * MONAI Bundle の実機検証（computeMonaiCatalogCheck・computeMonaiVerify）が共有する部品。
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { openAnalysisPlugin } from "./computeSpikeShared.js";

export const PLUGIN_ID = "vis-monai";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const state = (viewer: Page): Promise<any> => viewer.evaluate(() => (window as unknown as { __monaiState?: unknown }).__monaiState ?? null);

export async function openViewer(driver: DesktopDriver, page: Page, studyUid: string, seriesUid: string): Promise<Page> {
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
  await openAnalysisPlugin(viewer, PLUGIN_ID);
  await viewer.getByTestId("monai-bundle").waitFor({ state: "visible", timeout: 10_000 });
  return viewer;
}

/**
 * 公式プラグイン（tatsunidas/graphy-next-plugin-monai）を、検証用のプラグインの置き場へ入れる。
 * 手元の作業コピー（既定: GRAPHY-Next の隣。GRAPHY_MONAI_PLUGIN_DIR で変えられる）から取る。
 * 🔴 plugin.json の engines.graphy は公開する版（>=0.4.0）のまま。開発版（0.3.x）でも読み込めるよう、
 *    置き場へ写すときだけ外す（リポジトリのものは変えない）。
 */
export function installOfficialPlugin(): void {
  const src = process.env.GRAPHY_MONAI_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-monai");
  if (!fs.existsSync(path.join(src, "ui.js"))) {
    throw new Error(`公式プラグインの作業コピーがありません: ${src}（git clone https://github.com/tatsunidas/graphy-next-plugin-monai）`);
  }
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf8"));
  manifest.engines = { ...manifest.engines, graphy: ">=0.0.0" };
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(src, "ui.js"), path.join(dst, "ui.js"));
}

