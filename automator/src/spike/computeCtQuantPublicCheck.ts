/*
 * CT 定量の参考値（fw/ct-quant-design.md §7・Q4）。TotalSegmentator データセット v2.0.1 の公式 test 分割から取った症例を
 * NIfTI のまま本体に取り込み（CT として）、vis-ct-quant を本物の Colab（GPU T4）で走らせ、結果のラベルを書き出す。
 * 正解との照合（Dice・体積・L3 の面積）は scripts/eval-ct-quant-public.py が行う（ここでは測らない）。
 *
 * 準備:  python scripts/fetch-totalseg-test-cases.py .results/totalseg-test 5 abdomen
 * 実行:  cd automator && npx tsx src/spike/computeCtQuantPublicCheck.ts
 *
 * 🔴 Colab の枠を症例数 × 数分使い、最後に解放する。
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker, openAnalysisPlugin } from "./computeSpikeShared.js";

const PLUGIN_ID = "vis-ct-quant";
const CASES_DIR = path.join(AUTOMATOR_ROOT, ".results", "totalseg-test");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-ct-quant-public");
const { check, summary } = createChecker();

function installOfficialPlugin(): void {
  const src = process.env.GRAPHY_CT_QUANT_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-workspace", "graphy-next-plugin-ct-quant");
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(dst, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "plugin.json"), "utf8"));
  manifest.engines = { ...manifest.engines, graphy: ">=0.0.0" };
  fs.writeFileSync(path.join(dst, "plugin.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(src, "ui.js"), path.join(dst, "ui.js"));
}

async function runCase(driver: DesktopDriver, id: string, studyUid: string, seriesUid: string): Promise<void> {
  const page = driver.page;
  await page.getByTestId("search-submit-button").click();
  await page.locator(`[data-testid="study-row-${studyUid}"]`).click();
  await page.locator(`[data-testid="series-row-${seriesUid}"]`).click();
  const viewer: Page = await driver.waitForNewPage(
    () => page.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
  await viewer.waitForTimeout(2_000);
  await openAnalysisPlugin(viewer, PLUGIN_ID);
  await viewer.getByTestId("ctq-run").click();
  const w = await consentWindow(driver, 300_000);
  await w.getByTestId("consent-ack").check();
  await w.getByTestId("consent-send").click();
  await viewer.waitForFunction(() => (window as unknown as { __ctQuantState?: { phase: string } }).__ctQuantState?.phase === "idle", null, { timeout: 3_600_000 });
  // tsx は名前付きの関数に __name を差し込むので、ブラウザ側では名前付きの関数を作らない
  const dump = await viewer.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const st = (window as any).__ctQuantState;
    if (!st.labels) return { error: st.error ?? "no labels" };
    const { data, vol } = st.labels;
    let bin = "";
    const step = 0x8000;
    for (let i = 0; i < data.length; i += step) bin += String.fromCharCode(...data.subarray(i, i + step));
    return {
      labelsB64: btoa(bin), bytesPerVoxel: data.BYTES_PER_ELEMENT, dims: vol.dims, indexToWorld: vol.indexToWorld,
      classMap: st.classMap, summary: st.summary, organs: st.organs, ls: st.ls, l3: st.l3, l3Measure: st.l3Measure,
      measurements: st.measurements.map((m: { label: number; voxelCount: number; volumeMl: number; kRange: number[] }) =>
        ({ label: m.label, voxelCount: m.voxelCount, volumeMl: m.volumeMl, kRange: m.kRange })),
    };
  });
  const dir = path.join(OUT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  if ("error" in dump) {
    check(false, `${id}: 最後まで走る`, dump.error);
    await viewer.close();
    return;
  }
  const { labelsB64, ...meta } = dump;
  fs.writeFileSync(path.join(dir, "labels.raw"), Buffer.from(labelsB64, "base64"));
  fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(meta, null, 1));
  check(true, `${id}: 最後まで走る（${meta.summary?.stages?.done ?? "?"} 秒・${meta.summary?.gpu?.name}・L3 ${meta.l3?.ok ? "k=" + meta.l3.k : "なし"}）`);
  await viewer.close();
}

async function main(): Promise<void> {
  const cases = fs.readdirSync(CASES_DIR).filter((d) => fs.existsSync(path.join(CASES_DIR, d, "ct.nii.gz"))).sort();
  if (cases.length === 0) throw new Error(`${CASES_DIR} に症例がありません（scripts/fetch-totalseg-test-cases.py を先に）`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installOfficialPlugin();
  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  const endpointId = "colab-t4";
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const imported: Array<{ id: string; studyUid: string; seriesUid: string }> = [];
    for (const id of cases) {
      const res = await fetch(`${base}/api/nifti/import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(CASES_DIR, id, "ct.nii.gz"), modality: "CT", patientId: `TSEG-${id}`, patientName: `TotalSegmentator^${id}`, seriesDescription: `${id} ct` }),
      });
      const r = (await res.json()) as { studyInstanceUid: string; seriesInstanceUid: string; slices: number; rows: number; columns: number; pixelConversion: string; error: string | null };
      check(res.ok && !r.error, `${id}: NIfTI を CT として取り込む（${r.columns}×${r.rows}×${r.slices}・${r.pixelConversion}）`, r.error);
      fs.mkdirSync(path.join(OUT_DIR, id), { recursive: true });
      fs.writeFileSync(path.join(OUT_DIR, id, "import.json"), JSON.stringify(r, null, 1));
      imported.push({ id, studyUid: r.studyInstanceUid, seriesUid: r.seriesInstanceUid });
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const cwd = await driver.app.evaluate(({ dialog }) => {
      dialog.showMessageBoxSync = (() => 0) as typeof dialog.showMessageBoxSync;
      return process.cwd();
    });
    endpointsFile = path.join(cwd, "compute-endpoints.json");
    endpointsBackup = fs.existsSync(endpointsFile) ? fs.readFileSync(endpointsFile, "utf8") : null;
    if (endpointsBackup !== null) fs.rmSync(endpointsFile);
    await page.getByTestId("mainscreen-menu-system").click();
    await page.getByTestId("menu-item-settings").click();
    await page.getByTestId("settings-cat-compute").click();
    await page.getByTestId("compute-colab").waitFor({ state: "visible", timeout: 10_000 });
    if ((await page.getByTestId("compute-colab-account").count()) === 0) throw new Error("Colab にログインしていません（computeColabCheck を先に）");
    await page.getByTestId("compute-colab-spec").selectOption("VARIANT_GPU/T4/SHAPE_STANDARD");
    await page.getByTestId("compute-colab-add").click();
    await page.getByTestId(`compute-endpoint-${endpointId}`).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("dialog-close-button").click();
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    for (const c of imported) {
      console.log(`\n[${c.id}]`);
      await runCase(driver, c.id, c.studyUid, c.seriesUid);
    }
  } finally {
    await driver.page.evaluate((id) => (window as unknown as { graphyDesktop: any }).graphyDesktop.computeColabRelease(id), endpointId).catch(() => undefined);
    await driver.stop();
    if (endpointsFile) {
      if (endpointsBackup !== null) fs.writeFileSync(endpointsFile, endpointsBackup);
      else fs.rmSync(endpointsFile, { force: true });
    }
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
