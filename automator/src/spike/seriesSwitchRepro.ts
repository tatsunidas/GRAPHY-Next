/**
 * 再現用スパイク: メイン画面でシリーズを切り替えたとき、下部のビューアが切り替わるか。
 * 各クリックの後に、ビューアが取りに行った URL（レイアウト・画素）と画面を記録する。
 *
 * 実行: GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *       npx tsx src/spike/seriesSwitchRepro.ts
 * 環境: FFR_CASES_DIR（既定 ~/graphy_sample_images/ffr-cases）に FFR/（DICOM）があること。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const CASES_DIR = process.env.FFR_CASES_DIR ?? path.join(os.homedir(), "graphy_sample_images", "ffr-cases");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", process.env.REPRO_OUT ?? "series-switch");

const CASE2 = process.env.REPRO_CASE === "2";
const CASE_DIR = CASE2 ? "Case2 FFR0.90" : "Case1 FFR 0.69";
const STUDY = CASE2
  ? "1.2.392.200001.1001.4.3.5.190.4.99.4.4436905220260827"
  : "1.2.392.200001.1001.4.3.5.190.4.99.4.4522341520260928";
// Case1: XA シネ B・SC B・XA シネ A・SC A。Case2: 1 シリーズに 2 撮影のシネ・SC 2 本。
const SERIES: Record<string, string> = CASE2
  ? {
      cine: "1.2.392.200036.9110.17.142737080101.20260909.90746.0.101",
      sc1: "2.16.840.1.113669.632.22.192738599905202192191575998311255503367",
      sc2: "2.16.840.1.113669.632.22.291039787242388173433153569313857865624",
    }
  : {
      cineB: "1.2.392.200036.9110.17.346138440102.9.20261002.153257.2.1006",
      scB: "2.16.840.1.113669.632.22.264623429742827203808317093863434614109",
      cineA: "1.2.392.200036.9110.17.346138440101.9.20261002.153456.1.1007",
      scA: "2.16.840.1.113669.632.22.182395518494892977891778991666339416782",
    };
const SEQUENCE = CASE2 ? ["cine", "sc1", "sc2", "cine"] : ["cineB", "scB", "cineA", "scA", "cineB"];

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 400)));
    page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE.ERROR:", m.text().slice(0, 300)); });
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    await resetDb(driver.ports.http);
    // 検査用の既定は「パネルを開く」。実機の既定（閉）で見るため、閉に戻す（REPRO_PANEL=open で開く）。
    await fetch(`http://127.0.0.1:${driver.ports.http}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ "viewer.toolPanelDefault": process.env.REPRO_PANEL === "open" ? "true" : "false" }),
    });
    const imp = await importPaths(driver.ports.http, [
      path.join(CASES_DIR, "FFR", CASE_DIR, "DICOM"),
    ]);
    console.log("import", JSON.stringify(imp));
    await waitForMainScreenReady(page, 60_000).catch(async (e) => {
      console.log("URL:", page.url());
      await page.reload();
      await page.waitForTimeout(15_000);
      await page.screenshot({ path: path.join(OUT_DIR, "main-not-ready.png") });
      throw e;
    });
    await dismissStartupDialogs(page);
    await page.getByRole("button", { name: /^(All|全期間)$/ }).click();
    await page.getByTestId("search-submit-button").click();
    const row = page.locator(`[data-testid="study-row-${STUDY}"]`);
    await row.waitFor({ state: "visible", timeout: 20_000 });
    await row.click();
    await page.waitForTimeout(800);

    const headingNow = async () => (await page.locator("h3").filter({ hasText: /^(シリーズ|Series)/ }).first().textContent().catch(() => null)) ?? "(なし)";
    console.log("未選択の見出し:", `「${await headingNow()}」`);
    let urls: string[] = [];
    page.on("request", (r) => {
      const u = r.url();
      if (/\/api\/(studies|instances)\//.test(u)) urls.push(u.replace(/^https?:\/\/[^/]+/, ""));
    });

    for (const [i, key] of SEQUENCE.entries()) {
      urls = [];
      await page.locator(`[data-testid="series-row-${SERIES[key]}"]`).click();
      await page.waitForTimeout(4_000);
      const roots = await page.getByTestId("series-viewer-root").count();
      const heading = (await page.locator("h3").filter({ hasText: /^(シリーズ|Series)/ }).first().textContent().catch(() => null)) ?? "(なし)";
      const visible = async (id: string) => page.getByTestId(id).first().isVisible().catch(() => false);
      const runSlider = (await visible("dim-slider-other")) || (await visible("dim-slider-other-compact")) ? "表示" : "非表示/なし";
      const shot = path.join(OUT_DIR, `${i}-${key}.png`);
      await page.screenshot({ path: shot });
      console.log(`\n[${i}] クリック: ${key} (${SERIES[key].slice(-12)})  viewer-root=${roots}  見出し=「${heading}」 runスライダー=${runSlider}`);
      for (const u of urls.filter((x) => /\/series\/|\/instances\/[^/]+\/file/.test(x))) console.log("   ", u);
      console.log("   screenshot:", shot);
      const cells = (await page.locator("table").allInnerTexts()).map((t) => t.replace(/s+/g, " ").slice(0, 400));
      console.log("   枚数セル(表):", cells.join(" | "));
      // フレーム・ショットの位置指定（パネルを開いたとき）: 指定番号へ移動できるか。
      if (process.env.REPRO_PANEL === "open" && (await page.getByTestId("cine-indicator").first().isVisible().catch(() => false))) {
        const ind = async () => ((await page.getByTestId("cine-indicator").first().textContent()) ?? "").trim();
        console.log("   フレーム表示:", await ind());
        const shotJump = page.getByTestId("dim-slider-other-jump").first();
        if (await shotJump.isVisible().catch(() => false)) {
          for (const shot of ["2", "1"]) {
            await shotJump.fill(shot);
            await shotJump.press("Enter");
            await page.waitForTimeout(1_500);
            console.log(`   ショット ${shot} へ移動 → フレーム表示:`, await ind());
            await page.getByTestId("cine-jump").first().fill("50");
            await page.getByTestId("cine-jump").first().press("Enter");
            await page.waitForTimeout(800);
            console.log("     フレーム 50 を指定 →", await ind());
            await page.screenshot({ path: path.join(OUT_DIR, `${i}-${key}-shot${shot}-f50.png`) });
          }
        }
      }
      // ラン切替の確認: スライダーがあれば 2 本目へ動かし、画像（オーバーレイの InstanceNumber）が変わるか見る。
      const slider = page.getByTestId("dim-slider-other-compact").or(page.getByTestId("dim-slider-other")).first();
      if (await slider.isVisible().catch(() => false)) {
        const overlay = async () => ((await page.getByTestId("series-viewer-root").first().innerText()).replace(/s+/g, " ").slice(0, 140));
        console.log("   ラン切替前:", await overlay());
        await slider.fill("1");
        await page.waitForTimeout(2_500);
        console.log("   ラン切替後:", await overlay());
        await page.screenshot({ path: path.join(OUT_DIR, `${i}-${key}-run2.png`) });
        await slider.fill("0");
        await page.waitForTimeout(1_000);
      }
    }
  } finally {
    await driver.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
