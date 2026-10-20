/*
 * ROI 統計ダイアログの「体積の見積り」（径から球・楕円体の体積）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/volumeEstimateCheck.ts
 * 前提:  backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と fixture ct-basic。
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物の CT データ）:
 *   1. 楕円 ROI の長径・短径が、見積りの a・b に自動で入る（画面に出ている「長径×短径」と同じ値）
 *   2. 楕円体: 3 つ目の径 c が空なら体積は出ず保存もできない（0・負も同じ）＝負例。入れると出る
 *   3. **画面の体積が、画面の径から別に手計算した値と一致する**（π a b c / 6 / 1000、球は π d³ / 6 / 1000）
 *   4. 球: 径 1 つで出る
 *   5. 「ROI の属性に保存」→ 保存済みの値が出る。閉じて開き直しても出る
 *   値は DOM から読む（内部の関数を呼び合わない）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "volume-estimate-check");
const HOST = "viewer2d-canvas-host";
const { check, summary } = createChecker();

const volOf = (mm: number[]): number => (mm.length === 1 ? (Math.PI * mm[0] ** 3) / 6 : (Math.PI * mm[0] * mm[1] * mm[2]) / 6) / 1000;

async function openViewer(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewer = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewer.waitForTimeout(3000);
  return viewer;
}

async function openStatsDialog(page: Page): Promise<void> {
  const sigma = page.getByTitle(/計測結果を一覧|Show measurements for all/);
  if (!(await sigma.isVisible().catch(() => false))) {
    await page.getByTestId("viewer2d-menu-roiTools").click();
    await page.getByRole("button", { name: /ROI マネージャ|ROI manager/ }).first().click();
    await page.waitForTimeout(500);
  }
  await page.getByTitle(/計測結果を一覧|Show measurements for all/).first().click();
  await page.getByTestId("roi-stats-dialog").waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForTimeout(1500);
}

const num = (s: string | null | undefined): number => Number((s ?? "").replace(/[^0-9.\-]/g, ""));

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  try {
    await resetDb(d.ports.http);
    await importFixtureCategory(d.ports.http, "ct-basic");
    const viewer = await openViewer(d);
    viewer.on("dialog", (dlg) => void dlg.accept());

    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /楕円 ROI|Ellipse ROI/ }).first().click();
    await dragOnCanvasHost(viewer, HOST, 90, 70, 0, 10, { fracX: 0.30, fracY: 0.30 });
    await viewer.waitForTimeout(1500);
    await openStatsDialog(viewer);

    const dlg = viewer.getByTestId("roi-stats-dialog");
    // 画面に出ている「長径×短径」（Detail の行）を読む。
    const detail = (await dlg.textContent()) ?? "";
    const m = detail.match(/(?:長径×短径|Long x short):\s*([0-9.]+)\s*×\s*([0-9.]+)\s*mm/);
    check(!!m, "ダイアログに長径×短径が出ている", detail.slice(0, 200));
    const shownLong = m ? Number(m[1]) : NaN;
    const shownShort = m ? Number(m[2]) : NaN;

    await dlg.getByTestId("vol-estimate-toggle").click();
    const a = dlg.getByTestId("vol-a");
    const b = dlg.getByTestId("vol-b");
    const c = dlg.getByTestId("vol-c");
    const result = dlg.getByTestId("vol-result");
    const save = dlg.getByTestId("vol-save");

    // 1. 自動入力
    const aVal = num(await a.inputValue());
    const bVal = num(await b.inputValue());
    check(Math.abs(aVal - shownLong) < 0.011, "a に長径が自動で入る（画面の値と一致）", { aVal, shownLong });
    check(Math.abs(bVal - shownShort) < 0.011, "b に短径が自動で入る（画面の値と一致）", { bVal, shownShort });

    // 2. 負例: c が空・0・負
    check(/3 つ目の径|third diameter/.test((await result.textContent()) ?? ""), "c が空なら体積は出ず、入力を促す");
    check(await save.isDisabled(), "c が空なら保存できない");
    for (const bad of ["0", "-5"]) {
      await c.fill(bad);
      check(/3 つ目の径|third diameter/.test((await result.textContent()) ?? ""), `c=${bad} でも体積は出ない`);
      check(await save.isDisabled(), `c=${bad} でも保存できない`);
    }

    // 3. 楕円体: 画面の径から別に手計算
    await c.fill("12");
    await viewer.waitForTimeout(200);
    const text = (await result.textContent()) ?? "";
    const shown = Number(text.match(/≈\s*([0-9.]+)\s*mL/)?.[1]);
    const expected = volOf([aVal, bVal, 12]);
    check(Math.abs(shown - Number(expected.toFixed(2))) < 0.0051, "楕円体の体積が手計算と一致する（小数 2 桁）", { shown, expected, text });
    check(/楕円体の仮定|ellipsoid/.test(text), "仮定（楕円体）が値の隣に出ている", text);
    check(!(await save.isDisabled()), "c を入れると保存できる");

    // 4. 球
    await dlg.getByTestId("vol-kind-sphere").check();
    const d1 = num(await dlg.getByTestId("vol-d").inputValue());
    const t2 = (await result.textContent()) ?? "";
    const shown2 = Number(t2.match(/≈\s*([0-9.]+)\s*mL/)?.[1]);
    check(Math.abs(shown2 - Number(volOf([d1]).toFixed(2))) < 0.0051, "球の体積が手計算と一致する", { shown2, d1, t2 });
    check(/球の仮定|sphere/.test(t2), "仮定（球）が値の隣に出ている", t2);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-sphere.png") });

    // 5. 保存 → 保存済み表示 → 閉じて開き直しても残る
    await dlg.getByTestId("vol-kind-ellipsoid").check();
    await c.fill("12");
    await save.click();
    const savedText = (await dlg.getByTestId("vol-estimate-saved").textContent()) ?? "";
    check(savedText.includes(text.trim()), "保存済みの見積りが画面に出る（保存した値と同じ）", { savedText, text });
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-saved.png") });
    await dlg.getByTitle(/閉じる|Close/).first().click();
    await viewer.waitForTimeout(300);
    await openStatsDialog(viewer);
    const saved2 = (await viewer.getByTestId("roi-stats-dialog").getByTestId("vol-estimate-saved").textContent().catch(() => "")) ?? "";
    check(saved2.includes(text.trim()), "閉じて開き直しても保存済みの見積りが残る", saved2);
  } finally {
    await d.stop();
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
process.exitCode = process.exitCode || (summary() > 0 ? 1 : 0);
