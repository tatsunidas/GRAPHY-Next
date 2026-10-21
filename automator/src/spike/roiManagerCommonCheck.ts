/*
 * solid 管理 UI の共通化の実機検証: 2D の ROI マネージャと MPR の計測ダイアログが同じ部品（表示・名前・色・容積・式）を出し、
 * 一方の編集が他方へライブ共有される。「塗りにする」は 2D だけ。
 *
 * 実行:  cd automator && npx tsx src/spike/roiManagerCommonCheck.ts   （fixture ct-basic）
 *
 *   C1 2D の球（seed, r=10）を展開 → 容積 4.1888 mL（理論値）と式が出る
 *   C2 2D で名前を変える → MPR ダイアログの展開行の名前欄に反映される
 *   C3 MPR で表示を切る → 2D の行の目が 🚫 になる
 *   C4 「塗りにする」は 2D にあり MPR に無い
 *   C5 MPR で X の全長を 30 に → 2D は等径でなくなり X/Y/Z の全長欄（solid-size-x=30.0）に変わる
 *   C6 2D で削除 → MPR の一覧が空
 * ⚠ 実機の使い勝手はユーザー確認。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-manager-common-check");
const { check, summary } = createChecker();

const rows2d = (v: Page) => v.locator('[data-testid="roi-row"][data-kind="sphere"]');

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const port = d.ports.http;
  try {
    await resetDb(port);
    await importFixtureCategory(port, "ct-basic");
    const main = d.page;
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const v = await d.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await v.waitForTimeout(3000);
    if (!(await v.getByTestId("roi-new-painted").isVisible().catch(() => false))) {
      await v.getByTestId("viewer2d-menu-roiTools").click();
      await v.getByText(/^(ROI マネージャ|ROI manager)$/i).first().click();
      await v.waitForTimeout(500);
    }
    const mpr = await d.waitForNewPage(() => main.locator('button[title="MPR Viewer"]').click(), (url) => url.includes("mpr"));
    await mpr.getByTestId("mpr-roi3d-tool").waitFor({ timeout: 90_000 });
    await mpr.waitForTimeout(4_000);

    console.log("\n[C1] 2D の球を展開");
    const geo = (await v.evaluate(`(function () { var g = window.__graphyDebug.getViewportGeometry()[0].image; return { origin: Array.from(g.origin), spacing: Array.from(g.spacing), dims: Array.from(g.dimensions), dir: Array.from(g.direction) }; })()`)) as { origin: number[]; spacing: number[]; dims: number[]; dir: number[] };
    const c0 = [0, 1, 2].map((i) => geo.origin[i] + geo.dir[i] * geo.spacing[0] * geo.dims[0] / 2 + geo.dir[3 + i] * geo.spacing[1] * geo.dims[1] / 2);
    check((await rows2d(v).count()) === 0, "前提: 2D の solid 行が 0 件");
    await v.evaluate(`window.__graphyDebug.seedSphere3D(${JSON.stringify(c0)}, 10)`);
    await v.waitForTimeout(1500);
    check((await rows2d(v).count()) === 1, "2D に球の行が 1 行");
    // 追加直後の solid は選択済み＝展開済み。閉じていたときだけ開く（トグルなので盲目的に押さない）。
    if ((await rows2d(v).getByTestId("solid-info").count()) === 0) await rows2d(v).getByTestId("solid-expand").click();
    await v.waitForTimeout(300);
    const vol2d = ((await rows2d(v).getByTestId("solid-info-volume").textContent()) ?? "").trim();
    check(vol2d === "4.1888 mL", "2D の展開に容積 4.1888 mL（4/3·π·10³/1000）", vol2d);
    const f2d = ((await rows2d(v).getByTestId("mpr-roi3d-formula").textContent()) ?? "").trim();
    check(f2d.length > 0, "2D の展開に式が出る", f2d);
    await v.screenshot({ path: path.join(OUT_DIR, "2d-expanded.png") });

    console.log("\n[C2] 2D で名前 → MPR に反映");
    const nm = rows2d(v).getByTestId("solid-name");
    await nm.fill("tumor-A");
    await v.waitForTimeout(3500);
    await mpr.getByTestId("mpr-roi3d-measure").click();
    const dlg = mpr.getByTestId("mpr-roi3d-dialog");
    await dlg.waitFor({ timeout: 5_000 });
    check((await dlg.getByTestId("mpr-roi3d-row").count()) === 1, "MPR の一覧に 1 件");
    await dlg.getByTestId("mpr-roi3d-row").click();
    await mpr.waitForTimeout(300);
    const nm2 = await dlg.getByTestId("solid-name").inputValue();
    check(nm2 === "tumor-A", "MPR の展開行の名前欄が 2D で付けた名前", nm2);
    const volM = ((await dlg.getByTestId("mpr-roi3d-volume").first().textContent()) ?? "").trim();
    check(volM === vol2d, "MPR と 2D の容積が一致", { volM, vol2d });
    await mpr.screenshot({ path: path.join(OUT_DIR, "mpr-dialog.png") });

    console.log("\n[C3] MPR で表示を切る → 2D の目");
    const eye2d = rows2d(v).getByTestId("roi-row-visible");
    check(((await eye2d.textContent()) ?? "").includes("👁"), "前提: 2D の目は表示中");
    await dlg.getByTestId("roi-row-visible").click();
    await v.waitForTimeout(3500);
    check(((await eye2d.textContent()) ?? "").includes("🚫"), "2D の目が 🚫 になる");

    console.log("\n[C4] 塗りにするは 2D のみ");
    check((await rows2d(v).getByTestId("sphere-bake").count()) === 1, "2D には「塗りにする」がある");
    check((await dlg.getByTestId("sphere-bake").count()) === 0, "MPR には無い");

    console.log("\n[C5] MPR で X 全長 30 → 2D は 3 径欄");
    check((await rows2d(v).getByTestId("sphere-radius").count()) === 1, "前提: 2D は半径欄");
    const sx = dlg.getByTestId("mpr-roi3d-size-X");
    await sx.fill("30");
    await sx.press("Enter");
    await v.waitForTimeout(3500);
    check((await rows2d(v).getByTestId("sphere-radius").count()) === 0, "等径でなくなり半径欄が消える");
    const x2d = await rows2d(v).getByTestId("solid-size-x").inputValue();
    check(Number(x2d) === 30, "2D の X 全長が 30", x2d);

    console.log("\n[C6] 2D で削除 → MPR が空");
    await rows2d(v).getByTestId("roi-row-delete").click();
    await v.waitForTimeout(3500);
    check((await mpr.getByTestId("mpr-roi3d-dialog").getByTestId("mpr-roi3d-row").count()) === 0, "MPR の一覧が空");
    await mpr.close().catch(() => {});
    await v.close().catch(() => {});
  } finally {
    await d.stop();
  }
  process.exitCode = summary() ? 1 : 0;
}

void main();
