/*
 * v0.4.0 操作ガイド: 外部の GPU（Google Colab）で MONAI のモデルを動かす。
 *
 * 外部の計算機と MONAI のプラグインは**デスクトップ版だけ**の機能なので、ガイドの撮影（web）とは別に、
 * ここでデスクトップ版（Electron）をポートを変えて起動して撮る。
 * - データ: HCC_001 の #2 PRE LIVER（ct-basic と同じ）
 * - Colab: desktop/ のログイン（secrets.enc.json）と計算機の設定をそのまま使う（利用者の Colab の枠を数分使う）
 * - プラグイン: 公式リポジトリ tatsunidas/graphy-next-plugin-monai の作業コピー（既定は GRAPHY-Next の隣）
 * 本文は docs/release-guides/v0.4.0/guide.html。番号の順はそちらの説明の順と合わせる。
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../../backend/dbReset.js";
import { waitForMainScreenReady } from "../../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../../driver/desktopDriver.js";
import { importPaths } from "../../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../../fixtures/manifest.js";
import type { Scenario } from "../run.js";

const PLUGIN_ID = "vis-monai";
const PLUGIN_SRC = process.env.GRAPHY_MONAI_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-next-plugin-monai");
const DATA_DIR = process.env.GRAPHY_GUIDE_DATA ?? path.join(process.env.HOME ?? "", "graphy-demo-samples");
const BUNDLE = "wholeBody_ct_segmentation";

/**
 * 撮る画面を 1280×720・倍率 2（ガイドの他の画面と同じ）にする。
 * Electron の窓は大きさを変えても中身の幅が窓に合わないことがあるので、窓ではなく画面の寸法を上書きする。
 */
async function fit(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 2, mobile: false });
  await page.waitForTimeout(800);
}

const scenario: Scenario = async ({ shot }) => {
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_SRC, n), path.join(dst, n));

  // web の撮影（run.ts）と同時に動くので、ポートを変える
  const driver = new DesktopDriver({ http: 18490, scp: 18491, vite: 18493 });
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await importPaths(driver.ports.http, [DATA_DIR]);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForMainScreenReady(page);
    await fit(page);

    // 1. 環境設定 ＞ 外部の計算機
    await dismissStartupDialogs(page);
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-compute").click();
    await page.getByTestId("compute-colab-account").waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => !(document.querySelector('[data-testid="compute-colab-account"]')?.textContent ?? "").includes("…"), null, { timeout: 30_000 });
    const endpoint = page.locator('[data-testid^="compute-endpoint-colab"]').first();
    await endpoint.waitFor({ timeout: 10_000 });
    // 公開する資料に実際のアカウントを写さない
    await page.getByTestId("compute-colab-account").evaluate((el) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) n.textContent = (n.textContent ?? "").replace(/[\w.+-]+@[\w.-]+/g, "you@example.com");
    });
    await shot(page, "settings", [
      page.getByTestId("compute-colab-account"),
      { at: page.locator('[data-testid^="compute-default-"]').first(), side: "top" },
      { at: page.locator('[data-testid^="compute-colab-ensure-"], [data-testid^="compute-colab-release-"]').first(), side: "top" },
    ]);
    await page.getByTestId("dialog-close-button").click();

    // 2. PRE LIVER を 2D ビューアで開き、解析 ＞ MONAI
    await page.getByTestId("search-patientid-input").fill("HCC_001");
    await page.getByTestId("search-allperiod-chip").click();
    await page.getByTestId("search-submit-button").click();
    await page.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
    await page.locator('[data-testid^="series-row-"]', { hasText: "PRE LIVER" }).first().click({ timeout: 20_000 });
    const viewer: Page = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
    await fit(viewer);
    await viewer.waitForTimeout(3_000);
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
    await viewer.getByTestId("monai-bundle").waitFor({ timeout: 10_000 });
    await viewer.getByTestId("monai-bundle").selectOption(BUNDLE);
    await viewer.getByTestId("monai-run").click();

    // 3. 送る前の同意（main が描く窓）
    let consent: Page | undefined;
    for (let i = 0; i < 600 && !consent; i++) {
      consent = driver.app.windows().find((w) => w.url().endsWith("computeConsent.html"));
      if (!consent) await new Promise((r) => setTimeout(r, 500));
    }
    if (!consent) throw new Error("同意の窓が開きません");
    await consent.waitForFunction(() => (document.getElementById("code")?.textContent ?? "").length > 0);
    await fit(consent);
    await shot(consent, "consent", [
      consent.getByTestId("consent-url"),
      { at: consent.getByTestId("consent-datasets"), side: "left" },
      { at: consent.getByTestId("consent-code"), side: "left" },
      { at: consent.getByTestId("consent-send"), side: "top" },
    ]);
    await consent.getByTestId("consent-ack").check();
    await consent.getByTestId("consent-send").click();

    // 4. 結果（全身 104 臓器・ROI マネージャへ）
    await viewer.waitForFunction(
      () => (window as unknown as { __monaiState?: { phase: string } }).__monaiState?.phase === "idle",
      null,
      { timeout: 1_800_000 },
    );
    await viewer.waitForTimeout(2_000);
    await shot(viewer, "monai", [
      { at: viewer.getByTestId("monai-bundle"), side: "top" },
      { at: viewer.getByTestId("monai-run"), side: "top" },
      { at: viewer.getByTestId("monai-status"), side: "left" },
      { at: viewer.getByTestId("monai-preview"), side: "left" },
    ]);

    // 5. 窓を閉じると、Colab のランタイムを解放するかを聞かれる
    await viewer.locator(".graphy-plugin-window__close").click();
    await viewer.getByTestId("compute-release-confirm").waitFor({ timeout: 30_000 });
    await shot(viewer, "release", [
      { at: viewer.getByTestId("compute-release-ok"), side: "top" },
      { at: viewer.getByTestId("compute-release-keep"), side: "top" },
    ]);
    await viewer.getByTestId("compute-release-ok").click();
    await viewer.waitForTimeout(3_000);
  } finally {
    // 確保したまま終わらない（失敗しても解放する）
    await driver.page.evaluate(async () => {
      const d = (window as unknown as { graphyDesktop: any }).graphyDesktop;
      const c = await d.computeEndpointsGet();
      for (const e of c.endpoints) if (e.kind === "colab") await d.computeColabRelease(e.id);
    }).catch(() => undefined);
    await driver.stop();
  }
};

export default scenario;
