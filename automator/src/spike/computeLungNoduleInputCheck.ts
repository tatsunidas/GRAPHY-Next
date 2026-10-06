/*
 * CT 肺結節 N3 の切り分け（fw/lung-nodule-design.md §9.1）。GRAPHY を通して計算機に届いた画像（npz → NIfTI）が、
 * データセットの元の NIfTI と同じかを確かめる。同じなら、TotalSegmentator に直接かけたときと同じ入力になっている。
 *
 * 計算機の上のコードは vis-lung-nodule の buildScript() を推論の直前（RUNNER）で切ったもの＝プラグインと同じ変換。
 * 作った image.nii.gz を持ち帰り、照合は scripts/compare-nifti.py が行う。GPU は使わない（Colab の枠は数十秒）。
 *
 * 準備:  python scripts/fetch-nlstseg-cases.py .results/nlstseg 10
 * 実行:  cd automator && npx tsx src/spike/computeLungNoduleInputCheck.ts [症例 ID ...]（既定 100012 100147）
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker } from "./computeSpikeShared.js";

const PROBE_ID = "lung-nodule-input-probe";
const CASES_DIR = path.join(AUTOMATOR_ROOT, ".results", "nlstseg");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "lung-nodule-input-check");
const CASES = process.argv.slice(2).length ? process.argv.slice(2) : ["100012", "100147"];
const { check, summary } = createChecker();

async function probeScript(): Promise<string> {
  const src = process.env.GRAPHY_LUNG_NODULE_PLUGIN_DIR ?? path.join(AUTOMATOR_ROOT, "..", "..", "graphy-workspace", "graphy-next-plugin-lung-nodule");
  const mod = (await import(pathToFileURL(path.join(src, "ui.js")).href)) as { buildScript: () => string };
  const full = mod.buildScript();
  const cut = full.indexOf("RUNNER = '''");
  if (cut < 0) throw new Error("buildScript() に RUNNER が見つかりません（プラグインの版が違う）");
  return full.slice(0, cut) + "import shutil\nshutil.copy(image_path, 'outputs/image.nii.gz')\nstage('done', 1.0)\n";
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const script = await probeScript();
  const probeDir = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "plugin.json"), JSON.stringify({ id: PROBE_ID, name: "Lung nodule input probe", version: "0.0.1", contributes: ["viewer2d.menu"], ui: "ui.js", permissions: ["remote-compute"] }));
  fs.writeFileSync(path.join(probeDir, "ui.js"), `
const SCRIPT = ${JSON.stringify(script)};
export async function activate(host) {
  const t = (host.getTargets() || []).find((x) => x.kind === "image");
  const r = await host.compute.runJob({ inputs: [{ studyUid: t.studyUid, seriesUid: t.seriesUid, format: "npz" }], script: SCRIPT, timeoutSec: 1800 });
  if (!r.ok || r.status !== "ok") { window.__probe = { error: r.error || (r.errorName + ": " + r.errorValue) }; return; }
  const b = await r.readFile("image.nii.gz");
  let bin = "";
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  window.__probe = { nifti: btoa(bin) };
}
`);

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
    for (const id of CASES) {
      const res = await fetch(`${base}/api/nifti/import`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(CASES_DIR, id, "ct.nii.gz"), modality: "CT", patientId: `NLSTSEG-${id}`, patientName: `NLSTseg^${id}`, seriesDescription: `${id} ct` }),
      });
      const r = (await res.json()) as { studyInstanceUid: string; seriesInstanceUid: string; pixelConversion: string; error: string | null };
      check(res.ok && !r.error, `${id}: 取り込み（${r.pixelConversion}）`, r.error);
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
    if ((await page.getByTestId("compute-colab-account").count()) === 0) throw new Error("Colab にログインしていません");
    await page.getByTestId("compute-colab-spec").selectOption("VARIANT_GPU/T4/SHAPE_STANDARD");
    await page.getByTestId("compute-colab-add").click();
    await page.getByTestId(`compute-endpoint-${endpointId}`).waitFor({ state: "visible", timeout: 10_000 });
    await page.getByTestId("dialog-close-button").click();
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    for (const c of imported) {
      await page.getByTestId("search-submit-button").click();
      await page.locator(`[data-testid="study-row-${c.studyUid}"]`).click();
      await page.locator(`[data-testid="series-row-${c.seriesUid}"]`).click();
      const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
      await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
      await viewer.waitForTimeout(2_000);
      await viewer.getByTestId("viewer2d-menu-plugins").click();
      await viewer.getByTestId(`plugin-item-${PROBE_ID}`).click();
      const w = await consentWindow(driver, 300_000);
      await w.getByTestId("consent-ack").check();
      await w.getByTestId("consent-send").click();
      await viewer.waitForFunction(() => !!(window as unknown as { __probe?: unknown }).__probe, null, { timeout: 1_800_000 });
      const p = (await viewer.evaluate(() => (window as unknown as { __probe: { nifti?: string; error?: string } }).__probe));
      check(!!p.nifti, `${c.id}: 計算機で作った NIfTI を持ち帰る`, p.error);
      if (p.nifti) fs.writeFileSync(path.join(OUT_DIR, `${c.id}-via-graphy.nii.gz`), Buffer.from(p.nifti, "base64"));
      await viewer.close();
    }
  } finally {
    await driver.page.evaluate((id) => (window as unknown as { graphyDesktop: any }).graphyDesktop.computeColabRelease(id), endpointId).catch(() => undefined);
    await driver.stop();
    fs.rmSync(probeDir, { recursive: true, force: true });
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
