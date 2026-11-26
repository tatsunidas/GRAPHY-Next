/*
 * 一括抽出で、2D の単位（最大断面）を含む表を実際に作って書き出す（研究統計の 2D の行の検証用データ）。
 *
 * 実行:  cd automator && CASES=<症例フォルダを : 区切り> OUT=<書き出し先> GRAPHY_AUTOMATOR_HTTP_PORT=19480 GRAPHY_AUTOMATOR_SCP_PORT=19481 \
 *          GRAPHY_AUTOMATOR_VITE_PORT=19483 AUTOMATOR_DATA_DIR=$PWD/.results/run-data/batch2d timeout 3000 npx tsx src/spike/batch2dGen.ts
 */
import fs from "node:fs";
import path from "node:path";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { dismissUpdateDialog } from "./dismissUpdateDialog.js";

const CASES = (process.env.CASES ?? "").split(":").filter(Boolean);
const OUT = process.env.OUT ?? "";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!CASES.length || !OUT) { console.log("[未達] CASES・OUT を指定してください"); process.exitCode = 2; return; }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  const base = `http://127.0.0.1:${d.ports.http}`;
  try {
    await resetDb(d.ports.http);
    const uids: string[] = [];
    for (const c of CASES) uids.push(...((await importPaths(d.ports.http, [c])) as unknown as { studyInstanceUids: string[] }).studyInstanceUids);
    const name = "Batch2D";
    const old = (await (await fetch(`${base}/api/albums`)).json()) as { id: number; name: string }[];
    for (const x of old.filter((y) => y.name === name)) await fetch(`${base}/api/albums/${x.id}`, { method: "DELETE" });
    const album = (await (await fetch(`${base}/api/albums`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) })).json()) as { id: number };
    await fetch(`${base}/api/albums/${album.id}/studies`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ studyUids: uids }) });
    const page = d.page;
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await sleep(2000);
    await dismissUpdateDialog(page);
    await page.evaluate("localStorage.setItem('graphy.locale', 'ja')");
    await page.reload();
    await page.getByTestId("album-select").waitFor({ state: "visible", timeout: 60_000 });
    await dismissUpdateDialog(page);
    await page.getByTestId("album-select").selectOption(String(album.id));
    await sleep(1500);
    await page.getByTestId("album-batch-button").click();
    await page.getByTestId("batch-dialog").waitFor({ state: "visible", timeout: 20_000 });
    await page.getByTestId("batch-summary").waitFor({ state: "visible", timeout: 120_000 });
    await sleep(3000);
    await page.getByTestId("batch-unit-MAX_SECTION_2D").check();
    await sleep(500);
    await page.getByTestId("batch-run").click();
    const t0 = Date.now();
    for (let i = 0; i < 1500; i++) { if (await page.getByTestId("batch-write").isEnabled()) break; await sleep(2000); }
    console.log(`計算 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
    await d.app.evaluate(({ dialog }, dir) => { (dialog as unknown as { showOpenDialog: unknown }).showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, OUT);
    await page.getByTestId("batch-write").click();
    await page.getByTestId("batch-written").waitFor({ state: "visible", timeout: 30_000 });
    console.log(`書き出し: ${JSON.stringify(fs.readdirSync(OUT))}`);
  } finally {
    await d.stop();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
