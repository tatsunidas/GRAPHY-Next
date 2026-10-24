/**
 * 実機確認: ROI・描画ツール（ポリゴンライン）が有効なとき、画像ビュー下の操作バーのパンを押すと、
 * 上部ツールバーでパンを選んだのと同じに切り替わる（トーストで断らない）。
 * 判定は (a) 断りのトーストが出ない (b) 下のパンが押下状態 (c) 上部ツールバーの強調が W/L から Pan へ移る
 * (d) 左ドラッグで ROI が増えない（描画でなく移動）。スクリーンショットも残す（目視確認用）。
 * 実行: GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *       FFR_DIR=<症例フォルダ> [OUT=name] npx tsx src/spike/roiToolbarPanSwitchCheck.ts
 * 出力: .results/<OUT>/ にスクリーンショット。標準出力に 合格 / 失敗。
 */
import fs from "node:fs";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const DIR: string = process.env.FFR_DIR ?? "";
if (!DIR) throw new Error("FFR_DIR を指定してください");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", process.env.OUT ?? "roi-toolbar-pan-switch");
const HOST = "viewer2d-canvas-host";

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  合格: ${label}`);
  } else {
    failures.push(label);
    console.log(`  失敗: ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e.stack ?? e).slice(0, 600)));
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    const base = `http://127.0.0.1:${driver.ports.http}/api`;
    await resetDb(driver.ports.http);
    await importPaths(driver.ports.http, [DIR]);
    await new Promise((r) => setTimeout(r, 3000));
    let t: { study: string; series: string } | null = null;
    for (const st of (await (await fetch(`${base}/studies`)).json()) as any[]) {
      for (const se of (await (await fetch(`${base}/studies/${st.studyInstanceUid}/series`)).json()) as any[]) {
        const lay: any = await (await fetch(`${base}/studies/${st.studyInstanceUid}/series/${se.seriesInstanceUid}/layout`)).json();
        if (!t && se.modality === "XA" && (lay.cells?.length ?? 0) > 1) t = { study: st.studyInstanceUid, series: se.seriesInstanceUid };
      }
    }
    if (!t) throw new Error("シネが無い");
    await waitForMainScreenReady(page, 60_000);
    await dismissStartupDialogs(page);
    await page.getByRole("button", { name: /^(All|全期間)$/ }).click();
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${t.study}"]`).click();
    await page.locator(`[data-testid="series-row-${t.series}"]`).click();
    await page.waitForTimeout(500);
    const v = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3_000);
    const cv = v.getByTestId(HOST).first().locator("canvas").first();
    const box = (await cv.boundingBox())!;
    const W = box.width, H = box.height;
    const shot = (name: string) => v.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    const bg = (testId: string) => v.getByTestId(testId).evaluate((el) => getComputedStyle(el as HTMLElement).backgroundColor);
    const annCount = async () => ((await v.evaluate(`window.__graphyDebug.getAnnotationCanvasPoints()`)) as unknown[]).length;
    // 下の操作バーのパン（上部ツールバーのパンと同じ title なので、画像ビュー内のものに絞る）。
    const bottomPan = v.getByTestId("series-viewer-root").first().locator('button[title^="移動（パン）"]').first();

    console.log("\n[0] 初期状態: W/L が有効（上部ツールバーの W/L が強調）");
    const bgActive0 = await bg("toolbar-tool-wl");
    const bgInactive = await bg("toolbar-tool-zoom");
    check(bgActive0 !== bgInactive, "W/L の強調が他のツールと違う（強調の判定に使える）", { bgActive0, bgInactive });
    check((await bg("toolbar-tool-pan")) === bgInactive, "初期はパンは強調されていない");
    await shot("0-initial");

    console.log("\n[1] ポリゴンラインを選ぶ（ROI メニュー）");
    await v.keyboard.press("Escape").catch(() => undefined);
    await v.mouse.click(1000, 100).catch(() => undefined);
    await v.getByTestId("viewer2d-menu-roi").click();
    await v.waitForTimeout(250);
    await v.getByText(/^(✓ )?ポリゴンライン（開）$/).first().click();
    await v.waitForTimeout(400);
    check((await bg("toolbar-tool-wl")) === bgInactive, "ポリゴンライン選択後、W/L の強調が外れた");
    check((await bottomPan.getAttribute("aria-pressed")) !== "true", "下のパンは押下状態ではない");
    await shot("1-polyline-active");

    console.log("\n[2] 画像ビュー下のパンを押す");
    const before = await annCount();
    await bottomPan.click();
    await v.waitForTimeout(500);
    const toastTexts = await v.getByTestId("viewer2d-toast").allInnerTexts().catch(() => [] as string[]);
    check(!toastTexts.some((x) => /ROI・描画ツール|有効中/.test(x)), "「先に切り替えてください」のトーストが出ない", toastTexts);
    check((await bottomPan.getAttribute("aria-pressed")) === "true", "下のパンが押下状態になった");
    check((await bg("toolbar-tool-pan")) === bgActive0, "上部ツールバーのパンが強調された（W/L と同じ強調）");
    check((await bg("toolbar-tool-wl")) === bgInactive, "W/L は強調されていない");
    await shot("2-after-bottom-pan");

    console.log("\n[3] 左ドラッグは描画でなく移動");
    await cv.hover({ position: { x: W * 0.5, y: H * 0.5 } });
    await v.mouse.down();
    await v.mouse.move(box.x + W * 0.5 + 60, box.y + H * 0.5 + 40, { steps: 8 });
    await v.mouse.up();
    await v.waitForTimeout(400);
    check((await annCount()) === before, "ROI が増えていない（描画されなかった）", { before, after: await annCount() });
    await shot("3-after-drag");

    console.log("\n[4] もう一度下のパンを押すと W/L に戻る（既存の切替は変わらない）");
    await bottomPan.click();
    await v.waitForTimeout(400);
    check((await bottomPan.getAttribute("aria-pressed")) !== "true", "下のパンの押下が外れた");
  } finally {
    await driver.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗:", failures.join(" | "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
