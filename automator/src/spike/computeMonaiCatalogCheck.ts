/*
 * MONAI のサンプル（examples/remote-compute-monai）の一覧にある Bundle を、本物の Google Colab（GPU T4）で全部通す。
 * 設計: fw/remote-compute-design.md §18。
 *
 * 実行:  cd automator && npx tsx src/spike/computeMonaiCatalogCheck.ts [bundle名…]（省略時は一覧の全部）
 *
 * 🔴 前提: Colab にログイン済み。利用者の Colab の枠を数十分使い、最後に解放する。
 *    ほかのアプリで Colab の GPU を確保したままだと、無料版では 2 本目を確保できないことがある。
 * 🔴 MR の Bundle 用のデータは公開データを手元に置いて使う（automator/fixtures/mr-monai/・git には入れない）:
 *    - prostate_t2.nii.gz … Medical Segmentation Decathlon Task05 の prostate_16 の T2（CC-BY-SA 4.0）
 *    - mni152_t1.nii.gz   … TemplateFlow の MNI152NLin2009cAsym T1w 1mm
 *
 * 確かめること（Bundle ごと）: 「実行」1 回・同意 1 回で最後まで走る／GPU T4／前景のあるラベルが返る／
 * H63 で ROI マネージャに読み込まれる（ラベルの数が一致）。所要時間・GPU メモリを記録する。
 */
import fs from "node:fs";
import path from "node:path";

import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT, FIXTURES_ROOT } from "../fixtures/manifest.js";
import { consentWindow, createChecker } from "./computeSpikeShared.js";

const PLUGIN_ID = "remote-compute-monai";
const PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "..", "examples", PLUGIN_ID);
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "compute-monai-catalog");
const MR_DIR = path.join(FIXTURES_ROOT, "mr-monai");
const { check, summary } = createChecker();

/** Bundle → 使うシリーズ（ct = ct-basic の PRE LIVER）。 */
const PLAN: { bundle: string; series: "ct" | "prostate" | "brain" }[] = [
  { bundle: "spleen_ct_segmentation", series: "ct" },
  { bundle: "wholeBody_ct_segmentation", series: "ct" },
  { bundle: "swin_unetr_btcv_segmentation", series: "ct" },
  { bundle: "multi_organ_segmentation", series: "ct" },
  { bundle: "pancreas_ct_dints_segmentation", series: "ct" },
  { bundle: "renalStructures_UNEST_segmentation", series: "ct" },
  { bundle: "prostate_mri_anatomy", series: "prostate" },
  { bundle: "wholeBrainSeg_Large_UNEST_segmentation", series: "brain" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const state = (viewer: Page): Promise<any> => viewer.evaluate(() => (window as unknown as { __monaiState?: unknown }).__monaiState ?? null);

async function openViewer(driver: DesktopDriver, page: Page, studyUid: string, seriesUid: string): Promise<Page> {
  await dismissStartupDialogs(page);
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByTestId("search-submit-button").click();
  await page.locator(`[data-testid="study-row-${studyUid}"]`).click();
  await page.locator(`[data-testid="series-row-${seriesUid}"]`).click();
  const viewer = await driver.waitForNewPage(
    () => page.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await viewer.waitForTimeout(3_000);
  await viewer.getByTestId("viewer2d-menu-analysis").click();
  await viewer.getByTestId(`plugin-analysis-item-${PLUGIN_ID}`).click();
  await viewer.getByTestId("monai-bundle").waitFor({ state: "visible", timeout: 10_000 });
  return viewer;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const plan = only.length ? PLAN.filter((p) => only.includes(p.bundle)) : PLAN;
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const n of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_SRC, n), path.join(dst, n));

  const driver = new DesktopDriver();
  let endpointsFile: string | null = null;
  let endpointsBackup: string | null = null;
  const endpointId = "colab-t4";
  const rows: Record<string, unknown>[] = [];
  try {
    await driver.start();
    const page = driver.page;
    page.on("dialog", (d) => void d.accept());
    await resetDb(driver.ports.http);
    await importFixtureCategory(driver.ports.http, "ct-basic");
    const base = `http://localhost:${driver.ports.http}`;
    const nifti = async (file: string, desc: string) => {
      const r = await fetch(`${base}/api/nifti/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: path.join(MR_DIR, file), modality: "MR", patientId: `MONAI-${desc}`, patientName: `MONAI^${desc}`, seriesDescription: desc }),
      });
      const j = (await r.json()) as { studyInstanceUid: string; seriesInstanceUid: string; error?: string };
      if (!r.ok || j.error) throw new Error(`NIfTI の取り込みに失敗: ${file} ${JSON.stringify(j)}`);
      return { studyUid: j.studyInstanceUid, seriesUid: j.seriesInstanceUid };
    };
    const series: Record<string, { studyUid: string; seriesUid: string }> = {};
    if (plan.some((p) => p.series === "prostate")) series.prostate = await nifti("prostate_t2.nii.gz", "PROSTATE-T2");
    if (plan.some((p) => p.series === "brain")) series.brain = await nifti("mni152_t1.nii.gz", "MNI152-T1");
    const studies = (await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string; patientId: string }[];
    for (const st of studies) {
      const ss = (await (await fetch(`${base}/api/studies/${st.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string; seriesDescription?: string }[];
      const liver = ss.find((s) => /LIVER/i.test(s.seriesDescription ?? ""));
      if (liver) series.ct = { studyUid: st.studyInstanceUid, seriesUid: liver.seriesInstanceUid };
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
    // 計算機は登録しない: 「未登録ならログイン済みで T4 を自動で足す」（§17）もここで確かめる

    let viewer: Page | null = null;
    let current = "";
    for (const p of plan) {
      console.log(`\n[${p.bundle}]（${p.series}）`);
      if (current !== p.series) {
        if (viewer) await viewer.close();
        viewer = await openViewer(driver, page, series[p.series].studyUid, series[p.series].seriesUid);
        current = p.series;
      }
      const v = viewer!;
      await v.getByTestId("monai-bundle").selectOption(p.bundle);
      const t0 = Date.now();
      await v.getByTestId("monai-run").click();
      const w = await consentWindow(driver, 300_000);
      await w.getByTestId("consent-ack").check();
      await w.getByTestId("consent-send").click();
      await v.waitForFunction(() => (window as unknown as { __monaiState?: { phase: string } }).__monaiState?.phase === "idle", null, { timeout: 3_600_000 });
      const s = await state(v);
      const sec = Math.round((Date.now() - t0) / 1000);
      const fg = Object.keys(s.summary?.labels ?? {}).filter((k) => k !== "0").length;
      const row = {
        bundle: p.bundle, series: p.series, ok: !!s.summary && !s.error, seconds: sec,
        stages: s.summary?.stages, gpu: s.summary?.gpu, labels: fg, shown: s.shown, resampled: s.summary?.resampled, error: s.error,
      };
      rows.push(row);
      console.log(`    ${JSON.stringify(row)}`);
      check(row.ok, `${p.bundle}: 最後まで走る（${sec} 秒）`, s.error);
      if (!row.ok) {
        const tb = (s.traceback ?? []).join("\n").replace(/\u001b\[[0-9;]*m/g, "");
        fs.writeFileSync(path.join(OUT_DIR, `${p.bundle}-error.txt`), `${s.error}\n\n${tb}\n\nstderr:\n${s.stderr ?? ""}`);
        console.log(tb.split("\n").slice(-25).join("\n"));
        continue;
      }
      check(/T4/.test(s.summary?.gpu?.name ?? ""), `${p.bundle}: GPU T4`, s.summary?.gpu);
      check(fg > 0, `${p.bundle}: 前景のあるラベルが返る（${fg}）`, s.summary?.labels);
      check(s.shown?.ok === true && s.shown.segmentCount === fg, `${p.bundle}: ROI マネージャに読み込まれる`, s.shown);
      await v.screenshot({ path: path.join(OUT_DIR, `${p.bundle}.png`) });
    }
    const st = await driver.page.evaluate(async () => (await (window as unknown as { graphyDesktop: any }).graphyDesktop.computeEndpointsGet()).endpoints);
    check(st.length === 1 && st[0].id === "colab-t4", "未登録から Colab の T4 が自動で登録された（§17）", st);
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "results.json"), JSON.stringify(rows, null, 2));
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
