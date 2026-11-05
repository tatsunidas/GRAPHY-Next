// 回帰検査: プラグインの窓を開いたあとに開いたタイルも、getTargets（「表示中のシリーズを追加」）に出ること。
// 実行: AUTOMATOR_DATA_DIR=<専用のデータ置き場> CDWI_GE=... npx tsx src/spike/addCurrentRepro.ts （専用ポート 28751 番台）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { selectFirstStudy } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";

const GE = process.env.CDWI_GE!;
const PLUGIN_DIR = path.join(os.homedir(), "graphy-next-plugin-computed-dwi");
const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", "vis-computed-dwi");
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_DIR, n), path.join(dst, n));
const driver = new DesktopDriver({ http: 28751, scp: 28752, vite: 28753 });
try {
  await driver.start();
  await resetDb(driver.ports.http);
  await importPaths(driver.ports.http, [path.join(GE, "b0"), path.join(GE, "b1000")]);
  const base = `http://localhost:${driver.ports.http}`;
  const st = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0].studyInstanceUid;
  const series = (await (await fetch(`${base}/api/studies/${st}/series`)).json()) as { seriesInstanceUid: string; seriesNumber: number }[];
  const page = driver.page;
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await selectFirstStudy(page, createStepRecorder());
  await page.locator(`[data-testid="series-row-${series[0].seriesInstanceUid}"]`).click();
  await page.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForTimeout(1500);
  const v = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (u) => u.includes("2dviewer"));
  await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await v.waitForTimeout(2000);
  const info = async (tag: string): Promise<{ rows: number; opts: string[] }> => {
    const opts = await v.locator("#cdwi-base-low option").allInnerTexts();
    const rows = await v.locator('[data-testid="input-row"]').count();
    const msg = (await v.getByTestId("status").first().textContent().catch(() => "")) ?? "";
    console.log(`[${tag}] 入力行=${rows} 低bの選択肢=${JSON.stringify(opts)} メッセージ=${msg}`);
    return { rows, opts };
  };
  await v.getByTestId("viewer2d-menu-analysis").click();
  await v.getByTestId("plugin-analysis-item-vis-computed-dwi").click();
  await v.locator("#cdwi-run").waitFor({ state: "visible", timeout: 15_000 });
  await v.waitForTimeout(2500);
  await info("窓を開いた直後");
  await v.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); if(w){ w.style.left = (window.innerWidth - 40) + 'px'; w.style.top = (window.innerHeight - 40) + 'px'; } })()`);
  // 2 枚目のタイルを左パネルの「＋」で開く
  const toggles = v.locator('[data-testid="series-toggle"]');
  console.log(`左パネルの series-toggle: ${await toggles.count()}`);
  for (let i = 0; i < (await toggles.count()); i++) {
    if ((await toggles.nth(i).textContent())?.includes("＋")) { await toggles.nth(i).click({ force: true }); break; }
  }
  await v.waitForTimeout(2500);
  console.log(`タイル数: ${await v.locator('[data-testid="viewer2d-canvas-host"]').count()}`);
  await v.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); if(w){ w.style.left = (window.innerWidth - 40) + 'px'; w.style.top = (window.innerHeight - 40) + 'px'; } })()`);
  await v.screenshot({ path: path.join(path.dirname(fileURLToPathSafe()), "x.png") }).catch(() => undefined);
  await v.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); w.style.left='20px'; w.style.top='20px'; })()`);
  await v.getByTestId("add-current").click();
  await v.waitForTimeout(2000);
  const r2 = await info("表示中のシリーズを追加（2 枚目を開いた後）");
  if (r2.rows !== 2 || r2.opts.length !== 2) { console.log("FAIL: 窓を開いたあとに開いたタイルが追加されない"); process.exitCode = 1; } else console.log("OK: 2 枚目のタイルのシリーズが基準 b の選択肢に入る");
  await v.evaluate(`(function(){ var w = document.querySelector('.graphy-plugin-window'); w.style.left='700px'; w.style.top='500px'; })()`);
  await v.locator('[data-testid="viewer2d-canvas-host"]').nth(1).click({ position: { x: 20, y: 20 }, force: true }).catch((e) => console.log("click失敗", String(e).slice(0, 100)));
  await v.mouse.click(930, 237);
  await v.waitForTimeout(500);
  await v.screenshot({ path: path.join(process.cwd(), ".results", "repro.png") });
  await v.getByTestId("add-current").click();
  await v.waitForTimeout(2000);
  await info("2 枚目のタイルを選んでから追加");
} finally {
  await driver.stop().catch(() => undefined);
}
function fileURLToPathSafe(): string { return path.join(process.cwd(), ".results", "x"); }
