/*
 * 整数でない float の NIfTI を Parametric Map（32 bit float）で取り込んで、表示・H10 で値が保たれるかを見る
 * （fw/nifti-import.md §3.1・段 F1）。Colab は使わない。
 *
 * 実行:  cd automator && GRAPHY_TEST_PYTHON=<numpy と nibabel のある python> npx tsx src/spike/niftiFloatCheck.ts
 *
 * 答え（scripts/make-float-nifti.py が NIfTI のアフィンから出した患者座標と float32 の値）と、
 * 本体の H10 が返したボリュームの同じ患者座標の値を比べる。NaN は NaN のまま残っていること。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "nifti-float-check");
const PROBE_ID = "nifti-float-probe";
const { check, summary } = createChecker();

const PROBE_UI = `
export async function activate(host) {
  const t = (host.getTargets() || []).find((x) => x.kind === "image");
  const vol = await host.loadVolume({ studyUid: t.studyUid, seriesUid: t.seriesUid });
  if (!vol) { window.__probe = { error: "loadVolume returned null" }; return; }
  const samples = window.__probeSamples;
  const w = vol.worldToIndex;
  const [nx, ny, nz] = vol.dims;
  const at = samples.map((s) => {
    const [x, y, z] = s.lps;
    const i = Math.round(w[0] * x + w[1] * y + w[2] * z + w[3]);
    const j = Math.round(w[4] * x + w[5] * y + w[6] * z + w[7]);
    const k = Math.round(w[8] * x + w[9] * y + w[10] * z + w[11]);
    const v = vol.data[i + nx * (j + ny * k)];
    return { ijk: [i, j, k], value: Number.isNaN(v) ? null : v };
  });
  let nan = 0;
  for (let p = 0; p < vol.data.length; p++) if (Number.isNaN(vol.data[p])) nan++;
  const px = await host.getPixelData(t.tileId);
  window.__probe = { dims: vol.dims, unit: vol.unit, at, nan, pixelSample: px ? Array.from(px.data.slice(0, 5)) : null, pixelUnit: px ? px.unit : null };
}
`;

async function main(): Promise<void> {
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const nii = path.join(OUT_DIR, "adc.nii.gz");
  const truthPath = path.join(OUT_DIR, "truth.json");
  const gen = spawnSync(process.env.GRAPHY_TEST_PYTHON ?? "python", [path.join(AUTOMATOR_ROOT, "scripts", "make-float-nifti.py"), nii, truthPath], { encoding: "utf8", env: process.env });
  if (gen.status !== 0) throw new Error(`NIfTI を作れませんでした: ${gen.stderr}`);
  const truth = JSON.parse(fs.readFileSync(truthPath, "utf8"));

  const probeDir = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PROBE_ID);
  fs.rmSync(probeDir, { recursive: true, force: true });
  fs.mkdirSync(probeDir, { recursive: true });
  fs.writeFileSync(path.join(probeDir, "plugin.json"), JSON.stringify({ id: PROBE_ID, name: "NIfTI float probe", version: "0.0.1", contributes: ["viewer2d.menu"], ui: "ui.js" }));
  fs.writeFileSync(path.join(probeDir, "ui.js"), PROBE_UI);

  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    const base = `http://localhost:${driver.ports.http}`;
    const res = await fetch(`${base}/api/nifti/import`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      // 単位（F2）: mm²/s を付けて取り込む
      body: JSON.stringify({ path: nii, modality: "MR", patientId: "NIFTI-FLOAT", patientName: "Float^Nifti", seriesDescription: "ADC float", valueUnit: "mm2/s" }),
    });
    const r = (await res.json()) as { studyInstanceUid: string; seriesInstanceUid: string; imported: number; pixelConversion: string; error: string | null };
    console.log(`    取り込み: ${r.imported} 件・${r.pixelConversion}`);
    check(res.ok && !r.error && /32bit float/.test(r.pixelConversion) && /NaN のまま/.test(r.pixelConversion), "Parametric Map（32bit float）として取り込み、NaN の件数が出る", r);
    const lay = (await (await fetch(`${base}/api/studies/${r.studyInstanceUid}/series/${r.seriesInstanceUid}/layout`)).json()) as { nZ: number; imageWidth: number; imageHeight: number; zSpatial?: unknown[]; imageOrientationPatient?: number[]; pixelFormat?: { bitsAllocated: number } };
    check(lay.nZ === truth.dims[2] && lay.imageWidth === truth.dims[0] && lay.imageHeight === truth.dims[1], `レイアウト: ${lay.imageWidth}×${lay.imageHeight}×${lay.nZ}`, lay);
    check(Array.isArray(lay.zSpatial) && lay.zSpatial.length === truth.dims[2] && lay.imageOrientationPatient?.length === 6, "レイアウトに幾何（IOP・z の位置）がある");
    check(lay.pixelFormat?.bitsAllocated === 32, "レイアウトの画素形式は 32 bit", lay.pixelFormat);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(page);
    const dates = page.locator('input[type="date"]');
    await dates.nth(0).fill("");
    await dates.nth(1).fill("");
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${r.studyInstanceUid}"]`).click();
    await page.locator(`[data-testid="series-row-${r.seriesInstanceUid}"]`).click();
    const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
    await viewer.waitForTimeout(3_000);
    await viewer.screenshot({ path: path.join(OUT_DIR, "viewer.png") });

    await viewer.evaluate((s) => { (window as unknown as { __probeSamples: unknown }).__probeSamples = s; }, truth.samples);
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.getByTestId(`plugin-item-${PROBE_ID}`).click();
    await viewer.waitForFunction(() => !!(window as unknown as { __probe?: unknown }).__probe, null, { timeout: 60_000 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p: any = await viewer.evaluate(() => (window as unknown as { __probe: unknown }).__probe);
    fs.writeFileSync(path.join(OUT_DIR, "probe.json"), JSON.stringify(p, null, 1));
    check(!p.error, "H10 でボリュームが読める（幾何あり）", p.error);
    if (!p.error) {
      check(p.dims.join("x") === truth.dims.join("x"), `H10 の格子 ${p.dims.join("×")}`);
      truth.samples.forEach((s: { index: number[]; value: number | null }, i: number) => {
        const got = p.at[i].value;
        check(s.value === null ? got === null : got === s.value,
          `ボクセル ${s.index.join(",")}: H10 ${got} = 元の float32 ${s.value}`, { got, want: s.value, ijk: p.at[i].ijk });
      });
      check(p.nan === truth.nanVoxels, `NaN は ${truth.nanVoxels} ボクセルのまま（H10 で ${p.nan}）`);
      check(p.unit === "mm2/s" && p.pixelUnit === "mm2/s", "取り込みで選んだ単位が H10・H3 の unit に出る", { h10: p.unit, h3: p.pixelUnit });
      check(Array.isArray(p.pixelSample) && p.pixelSample.every((v: number) => Number.isFinite(v) && Math.abs(v) < 0.01), "H3（表示中のスライス）も小さい float の値", p.pixelSample);
    }

    // 取り込みの画面: NIfTI を選ぶと「値の単位」が出て選べる（F2）
    await viewer.close();
    // メニューとツールバーに同じ文字の項目があるので、ツールバーのボタン（同じダイアログを開く）を押す
    await page.getByText("非DICOM取込", { exact: true }).first().click();
    await page.locator('input[type="file"][multiple]').setInputFiles(nii);
    const unitSel = page.getByTestId("nifti-unit");
    await unitSel.waitFor({ state: "visible", timeout: 10_000 });
    await unitSel.selectOption("other");
    await page.getByTestId("nifti-unit-custom").fill("10*-3.mm2/s");
    await page.screenshot({ path: path.join(OUT_DIR, "import-dialog-unit.png") });
    const options = await unitSel.locator("option").allTextContents();
    check(options.length === 7 && options.includes("mm²/s（ADC など）"), "取り込みの画面に単位の候補が 7 つ出る", options);
  } finally {
    await driver.stop();
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
  if (summary() > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
