/*
 * 窓間ライブ共有（solid）の実機検証: 2D 窓と MPR 窓を同じシリーズで同時に開いたまま、
 * 一方の編集が**再読込なしで**他方に出る／消える。
 *
 * 実行:  cd automator && npx tsx src/spike/solidLiveShareCheck.ts   （fixture ct-basic）
 * 専用ポート: GRAPHY_AUTOMATOR_HTTP_PORT / _SCP_PORT / _VITE_PORT。
 *
 *   L1 前提: 両窓とも solid が 0 件（操作が効いたことを後で言うための基準）
 *   L2 MPR で楕円体を描く → 2D の ROI マネージャに行が増え、どこかのスライスに断面が出る
 *   L3 2D で行を削除 → MPR の ROI が消える（墓標の伝播）
 *   L4 2D で球（seed）を作る → MPR に出る（逆向き）
 *   N1 負例: 別患者のドキュメントは空のまま（他の患者へ漏れない）
 * ⚠ MPR の描画は合成イベント（既存の mprRoi3dCheck と同じ）。実機の使い勝手はユーザー確認。
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "solid-live-share-check");
const { check, summary } = createChecker();

async function drag(page: Page, idx: number, from: [number, number], to: [number, number], steps = 8): Promise<void> {
  await page.evaluate(
    `(function (a) {
      var host = document.querySelectorAll('[data-testid="mpr-viewport"]')[a.idx];
      var r = host.getBoundingClientRect();
      function fire(type, fx, fy, buttons) {
        var mt = type.replace("pointer", "mouse");
        host.dispatchEvent(new MouseEvent(mt, { bubbles: true, cancelable: true, button: 0, buttons: buttons,
          clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
        host.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", isPrimary: true,
          button: 0, buttons: buttons, clientX: r.left + r.width * fx, clientY: r.top + r.height * fy }));
      }
      fire("pointerdown", a.from[0], a.from[1], 1);
      for (var i = 1; i <= a.steps; i++) fire("pointermove", a.from[0] + (a.to[0] - a.from[0]) * i / a.steps, a.from[1] + (a.to[1] - a.from[1]) * i / a.steps, 1);
      fire("pointerup", a.to[0], a.to[1], 0);
    })(${JSON.stringify({ idx, from, to, steps })})`,
  );
}

const rows2d = (v: Page) => v.locator('[data-testid="roi-row"][data-kind="sphere"]');
const mprSections = (m: Page) => m.getByTestId("mpr-roi3d-overlay-axial").getByTestId("mpr-roi3d-section").count();

/** 2D 窓: すべてのスライスを回して、断面プレビューが出るスライス数を数える。 */
async function slicesWithPreview(v: Page): Promise<number> {
  const slider = v.getByTestId("dim-slider-z");
  const lo = Number(await slider.getAttribute("min"));
  const hi = Number(await slider.getAttribute("max"));
  let n = 0;
  for (let k = lo; k <= hi; k++) {
    await slider.fill(String(k));
    await v.waitForTimeout(120);
    if ((await v.locator('[data-testid="sphere-preview"]').count()) > 0) n++;
  }
  return n;
}

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
    const ctx = (await v.evaluate(`window.__graphyDebug.currentRoiContext()`)) as { patientKey: string } | null;
    const mpr = await d.waitForNewPage(() => main.locator('button[title="MPR Viewer"]').click(), (url) => url.includes("mpr"));
    await mpr.getByTestId("mpr-roi3d-tool").waitFor({ timeout: 90_000 });
    await mpr.waitForTimeout(4_000);
    check(!!ctx?.patientKey, "2D 窓の患者キーが取れる", ctx);

    console.log("\n[L1] 前提");
    check((await rows2d(v).count()) === 0, "2D の球・solid 行が 0 件");
    check((await mprSections(mpr)) === 0, "MPR の断面が 0 件");

    console.log("\n[L2] MPR で描く → 2D に出る（再読込なし）");
    await mpr.getByTestId("mpr-roi3d-tool").selectOption("ellipsoid");
    await mpr.waitForTimeout(300);
    await drag(mpr, 0, [0.4, 0.4], [0.6, 0.6]);
    await mpr.waitForTimeout(600);
    check((await mprSections(mpr)) === 1, "MPR 側に断面が 1 つ");
    await v.waitForTimeout(3500); // 保存 800 ms ＋ 通知 ＋ 取り込み 200 ms ＋余裕
    check((await rows2d(v).count()) === 1, "2D の ROI マネージャに行が 1 行増える");
    const nPrev = await slicesWithPreview(v);
    console.log(`  断面プレビューが出る 2D スライス数 = ${nPrev}`);
    check(nPrev >= 1, "2D のどこかのスライスに断面プレビューが出る", nPrev);
    await v.getByTestId("dim-slider-z").fill(String(Math.floor((Number(await v.getByTestId("dim-slider-z").getAttribute("min")) + Number(await v.getByTestId("dim-slider-z").getAttribute("max"))) / 2)));
    await v.waitForTimeout(300);
    await v.screenshot({ path: path.join(OUT_DIR, "2d-after-mpr-draw.png") });

    console.log("\n[L3] 2D で削除 → MPR から消える");
    await rows2d(v).getByTestId("roi-row-delete").click();
    await v.waitForTimeout(3500);
    check((await mprSections(mpr)) === 0, "MPR の断面が消える");
    await mpr.screenshot({ path: path.join(OUT_DIR, "mpr-after-2d-delete.png") });

    console.log("\n[L4] 2D で球を作る → MPR に出る");
    const geo = (await v.evaluate(`(function () { var g = window.__graphyDebug.getViewportGeometry()[0].image; return { origin: Array.from(g.origin), spacing: Array.from(g.spacing), dims: Array.from(g.dimensions), dir: Array.from(g.direction) }; })()`)) as { origin: number[]; spacing: number[]; dims: number[]; dir: number[] };
    const c0 = [0, 1, 2].map((i) => geo.origin[i] + geo.dir[i] * geo.spacing[0] * geo.dims[0] / 2 + geo.dir[3 + i] * geo.spacing[1] * geo.dims[1] / 2);
    await v.evaluate(`window.__graphyDebug.seedSphere3D(${JSON.stringify(c0)}, 10)`);
    await v.waitForTimeout(3500);
    await mpr.getByTestId("mpr-roi3d-measure").click();
    const dlg = mpr.getByTestId("mpr-roi3d-dialog");
    await dlg.waitFor({ timeout: 5_000 });
    check((await dlg.getByTestId("mpr-roi3d-row").count()) === 1, "MPR の 3D ROI 一覧に球が 1 件出る");
    const vol = ((await dlg.getByTestId("mpr-roi3d-volume").first().textContent()) ?? "").trim();
    check(vol === "4.1888 mL", "容積は半径 10 mm の球の理論値 4.1888 mL（4/3·π·10³/1000）", vol);
    await mpr.screenshot({ path: path.join(OUT_DIR, "mpr-after-2d-sphere.png") });

    console.log("\n[N1] 負例: 別患者");
    const other = await fetch(`http://127.0.0.1:${port}/api/rois?patientKey=OTHER-PATIENT`);
    const od = (await other.json()) as { json: string | null };
    check(other.ok && od.json === null, "別患者のドキュメントは空のまま", od);
    await mpr.close().catch(() => {});
    await v.close().catch(() => {});
  } finally {
    await d.stop();
  }
  process.exitCode = summary() ? 1 : 0;
}

void main();
