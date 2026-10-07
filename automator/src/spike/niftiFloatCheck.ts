/*
 * 整数でない float の NIfTI を Parametric Map（32 bit float）で取り込んで、表示・H10 で値が保たれるかを見る
 * （fw/nifti-import.md §3.1・段 F1〜F4）。Colab は使わない。
 * F3: 2D の W/L（上の帯・調整の画面）・ヒストグラム・ROI 統計（H66）・MPR・3D が小さい float と NaN で使えるか。
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
  // NaN の塊がある 4 枚目（k=3）へ動かしてから、表示中のスライスを読む
  host.goTo(t.tileId, { sliceIndex: 3 });
  await new Promise((r) => setTimeout(r, 1500));
  const px = await host.getPixelData(t.tileId);
  // 表示中のスライス（H3）の有限値の数と範囲（W/L の自動・ヒストグラムの答え）
  let pxN = 0, pxNaN = 0, pxMin = Infinity, pxMax = -Infinity;
  if (px) for (const v of px.data) if (Number.isFinite(v)) { pxN++; if (v < pxMin) pxMin = v; if (v > pxMax) pxMax = v; } else pxNaN++;
  // ROI 統計（H66）: 答えの箱（患者座標）にボクセル中心が入るものをラベル 1 にする
  const roi = window.__probeRoi;
  const m = vol.indexToWorld;
  const lab = new Uint8Array(nx * ny * nz);
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const p = [m[0] * i + m[1] * j + m[2] * k + m[3], m[4] * i + m[5] * j + m[6] * k + m[7], m[8] * i + m[9] * j + m[10] * k + m[11]];
    if (p.every((x, a) => x > roi.lpsMin[a] && x < roi.lpsMax[a])) lab[i + nx * (j + ny * k)] = 1;
  }
  const meas = host.measureLabels({ data: lab, dims: vol.dims, indexToWorld: vol.indexToWorld }, vol)[0];
  window.__probe = { dims: vol.dims, unit: vol.unit, at, nan, pixelSample: px ? Array.from(px.data.slice(0, 5)) : null, pixelUnit: px ? px.unit : null,
    pxN, pxNaN, pxMin, pxMax, roi: meas ? { voxels: meas.voxelCount, n: meas.stats ? meas.stats.n : null, mean: meas.stats ? meas.stats.mean : null } : null };
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

    // F4: テクスチャは NaN を含むシリーズを理由つきで断る（前は「スライスをデコードできません」）
    const tex = await fetch(`${base}/api/series/texture`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ studyInstanceUid: r.studyInstanceUid, sourceSeriesUid: r.seriesInstanceUid, maskChannel: 0, feature: "GLCM_JointEntropy",
        filterSize: 3, stride: 1, force2D: false, channel: 0, timePoint: 0, settings: { MASK_LABEL_INT: "1" } }),
    });
    const texBody = await tex.text();
    check(tex.status >= 400 && tex.status < 500 && /NaN/.test(texBody), `テクスチャは NaN を含むシリーズを断る（${tex.status}）`, texBody.slice(0, 300));

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

    await viewer.evaluate(([s, r]) => { Object.assign(window, { __probeSamples: s, __probeRoi: r }); }, [truth.samples, truth.roi]);
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
      // ROI 統計（F3）: NaN の塊にかかる箱。NaN を除いた数と平均が numpy の答えと合う
      check(p.roi && p.roi.voxels === truth.roi.voxels && p.roi.n === truth.roi.n,
        `ROI 統計（H66）: 箱 ${truth.roi.voxels} ボクセルのうち有限値 ${truth.roi.n}（NaN を除く）`, p.roi);
      check(p.roi && Math.abs(p.roi.mean - truth.roi.mean) <= Math.abs(truth.roi.mean) * 1e-6,
        `ROI 統計の平均 ${p.roi?.mean} = numpy ${truth.roi.mean}`, p.roi);
    }

    check(p.pxNaN === truth.nanPerSlice[3] && p.pxNaN > 0, `表示中の 4 枚目（H3）に NaN が ${truth.nanPerSlice[3]} 画素（以下の W/L・ヒストグラムは NaN を含むスライスで見る）`, { nan: p.pxNaN, n: p.pxN });

    // ── F3: 2D の W/L ──
    const band = (await viewer.getByTestId("status-wl").textContent()) ?? "";
    const bm = /^(-?[\d.e+-]+)\/([\d.e+-]+)$/.exec(band.trim());
    check(!!bm && Number(bm[2]) > 0 && Number(bm[2]) < 0.01, `上の帯の W/L が潰れない（${band}）`, band);
    await viewer.getByTestId("viewer2d-menu-image").click();
    await viewer.getByTestId("menu-wl-adjust").click();
    const dlg = viewer.getByTestId("wl-adjust-dialog");
    await dlg.waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(1_500);
    const range = p.pxMax - p.pxMin;
    const bandWw = async () => Number(/\/([\d.e+-]+)$/.exec(((await viewer.getByTestId("status-wl").textContent()) ?? "").trim())?.[1]);
    // 幅を値域の半分に直接入れて「設定」→ 画像に効く（下限 1 で潰されない）
    await dlg.locator('input[type="number"]').nth(1).fill(String(Number((range / 2).toPrecision(3))));
    await dlg.getByRole("button", { name: "設定", exact: true }).click();
    await viewer.waitForTimeout(500);
    const wwHalf = await bandWw();
    check(Math.abs(wwHalf - range / 2) <= range * 0.01, `W/L 調整で幅 ${(range / 2).toPrecision(3)} を入れると画像の幅も ${wwHalf}`);
    await dlg.getByRole("button", { name: "自動", exact: true }).click();
    await viewer.waitForTimeout(500);
    const wAuto = parseFloat((await viewer.getByTestId("wl-adjust-width").textContent()) ?? "");
    const cAuto = parseFloat((await viewer.getByTestId("wl-adjust-center").textContent()) ?? "");
    check(Math.abs(wAuto - range) <= range * 0.01 && Math.abs(cAuto - (p.pxMax + p.pxMin) / 2) <= range * 0.01,
      `W/L 調整の「自動」が表示中のスライスの値域（NaN を除く）に合う: 幅 ${wAuto}・中心 ${cAuto}（答え ${range.toPrecision(4)}・${((p.pxMax + p.pxMin) / 2).toPrecision(4)}）`);
    const wwAuto = await bandWw();
    check(Math.abs(wwAuto - range) <= range * 0.01, `「自動」で画像の幅も値域に戻る（${wwHalf} → ${wwAuto}）`);
    await viewer.screenshot({ path: path.join(OUT_DIR, "wl-dialog.png") });
    await dlg.getByRole("button", { name: "閉じる", exact: true }).click();

    // ── F3: ヒストグラム ──
    await viewer.getByTestId("viewer2d-menu-analysis").click();
    await viewer.getByTestId("menu-histogram").click();
    const binInput = viewer.getByTestId("histogram-bin-value");
    await binInput.waitFor({ state: "visible", timeout: 10_000 });
    await viewer.waitForTimeout(2_000);
    const binW = Number(await binInput.inputValue());
    check(binW > 0 && binW < range, `ヒストグラムのビン幅が値に合う（${binW}・値域 ${range.toPrecision(3)}）`);
    const stats = (await viewer.getByTestId("histogram-stats").textContent()) ?? "";
    check(stats.includes(String(p.pxN)) && !/NaN/.test(stats), `ヒストグラムの画素数は NaN を除いた ${p.pxN}`, stats.slice(0, 200));
    await viewer.screenshot({ path: path.join(OUT_DIR, "histogram.png") });

    await viewer.close();

    // ── F3: MPR（レイアウトのセルから組む）──
    const mpr = await driver.waitForNewPage(() => page.locator('button[title="MPR Viewer"]').click(), (url) => url.includes("mpr"));
    await mpr.getByTestId("mpr-slab-projection").waitFor({ timeout: 60_000 });
    await mpr.waitForTimeout(6_000);
    const mprText = await mpr.evaluate(() => document.body.innerText);
    check(new RegExp(String.raw`\d+ / ${truth.dims[2]}\b`).test(mprText), `MPR の横断が ${truth.dims[2]} 枚のボリューム`, mprText.slice(0, 300));
    const vp = mpr.getByTestId("mpr-viewport").first();
    const box = await vp.boundingBox();
    if (box) await mpr.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5);
    await mpr.waitForTimeout(800);
    const vm = /値\s+(-?[\d.e+-]+)/.exec(await mpr.evaluate(() => document.body.innerText));
    check(!!vm && Number(vm[1]) > 0 && Number(vm[1]) < 0.01, `MPR のカーソル値が小さい float のまま（${vm?.[1]}）`);
    // 描けているか: 横断の canvas の輝度の幅（真っ白・真っ黒の一様なら 0 近く）
    const lum = await mpr.evaluate(() => {
      const c = document.querySelector('[data-testid="mpr-viewport"] canvas') as HTMLCanvasElement | null;
      const g = c?.getContext("2d");
      if (!c || !g) return null;
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let mn = 255, mx = 0;
      const hist = new Array(256).fill(0);
      for (let i = 0; i < d.length; i += 4) { const y = Math.round((d[i] + d[i + 1] + d[i + 2]) / 3); hist[y]++; if (y < mn) mn = y; if (y > mx) mx = y; }
      return { mn, mx, levels: hist.filter((h) => h > 0).length };
    });
    check(!!lum && lum.levels > 64, `MPR の横断が濃淡で描かれる（輝度の段階 ${lum?.levels}・${lum?.mn}〜${lum?.mx}）`, lum);
    await mpr.screenshot({ path: path.join(OUT_DIR, "mpr.png") });
    await mpr.close();

    // ── F3: 3D ──
    const v3d = await driver.waitForNewPage(() => page.locator('button[title="3D Viewer"]').click(), (url) => url.includes("viewer3d"));
    await v3d.locator('[data-testid="viewer3d-mode-slab"]').waitFor({ timeout: 60_000 });
    await v3d.waitForTimeout(8_000);
    const v3dText = await v3d.evaluate(() => document.body.innerText);
    check(!/再試行|Retry/.test(v3dText), "3D がエラーなく開く", v3dText.slice(0, 300));
    await v3d.screenshot({ path: path.join(OUT_DIR, "viewer3d.png") });
    await v3d.close();

    // 取り込みの画面: NIfTI を選ぶと「値の単位」が出て選べる（F2）
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
