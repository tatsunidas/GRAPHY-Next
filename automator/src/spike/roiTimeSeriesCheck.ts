/*
 * host API `roiTimeSeries`（ROI の形を 4D シリーズの全時相に当てる）の実機検証。
 *
 * 実行:  cd automator && npx tsx src/spike/roiTimeSeriesCheck.ts
 * 前提:  backend jar、frontend の npm ci。
 *
 * 流れ: 合成の 4D NIfTI（TR 2.5 s・5 時相・画素 = 100*(t+1) + x）を取り込み → Electron のビューアで開く →
 *       楕円 ROI を実際にドラッグして描く → 検証用プラグイン（automator/plugins/roi-timeseries-check）が
 *       roiTimeSeries を呼ぶ。
 *   期待値は ROI の位置に依らない形に作ってある:
 *     - 時相 t の平均 − 時相 0 の平均 = 100*t（同じ領域を当てているなら、領域内の x の分布は時相で変わらない）
 *     - SD は全時相で同じ
 *     - 時相 0 の平均 = 本体が画面に出す ROI 統計の平均（同じエンジンを通っている）
 *     - 経過秒 = 2.5*t（TR から別に計算）
 *   負例: 存在しない ROI は ok:false（欠損を成功として返さない）。
 * 未達: 実際の DCE-MRI/灌流 DICOM、ROI が画像の外へ出る場合の実機（単体テストで確認）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-timeseries-check");
const PLUGIN_ID = "roi-timeseries-check";
const { check, summary } = createChecker();

const NX = 64, NY = 64, NZ = 3, NT = 5;
const TR_SEC = 2.5;

/** 最小の NIfTI-1（int16、4D）。画素 = 100*(t+1) + x。 */
function writeNifti(file: string): void {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  [4, NX, NY, NZ, NT, 1, 1, 1].forEach((v, i) => header.writeInt16LE(v, 40 + i * 2));
  header.writeInt16LE(4, 70);
  header.writeInt16LE(16, 72);
  [1, 1, 1, 1, TR_SEC, 0, 0, 0].forEach((v, i) => header.writeFloatLE(v, 76 + i * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeFloatLE(0, 116);
  header.writeUInt8(10, 123);
  header.write("n+1\0", 344, "latin1");
  const data = Buffer.alloc(NX * NY * NZ * NT * 2);
  let i = 0;
  for (let t = 0; t < NT; t++) for (let z = 0; z < NZ; z++) for (let y = 0; y < NY; y++) for (let x = 0; x < NX; x++) {
    data.writeInt16LE(100 * (t + 1) + x, 2 * i++);
  }
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

interface TsPoint { t: number; timeSec: number | null; mean: number | null; sd: number | null; n: number }
interface TsResult { ok: boolean; error?: string; points?: TsPoint[]; warnings?: string[]; timeSource?: string | null; unit?: string }
interface Payload {
  roiCount: number;
  roiTools: string[];
  unknownRoi: TsResult;
  series: Array<{ roiUid: string; tool: string; sliceIndex: number; t: number; ownMean: number | null; result: TsResult }>;
}

async function runPlugin(viewerPage: Page): Promise<Payload> {
  await viewerPage.evaluate(() => { delete (window as unknown as { __roiTsCheck?: unknown }).__roiTsCheck; });
  await viewerPage.getByTestId("viewer2d-menu-plugins").click();
  await viewerPage.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewerPage.waitForFunction(() => !!(window as unknown as { __roiTsCheck?: unknown }).__roiTsCheck, undefined, { timeout: 20_000 });
  return viewerPage.evaluate(() => (window as unknown as { __roiTsCheck: unknown }).__roiTsCheck) as Promise<Payload>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const nifti = path.join(OUT_DIR, "dyn4d.nii");
  writeNifti(nifti);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  for (const n of fs.readdirSync(src)) fs.copyFileSync(path.join(src, n), path.join(dst, n));

  const driver = new DesktopDriver();
  const recorder = createStepRecorder();
  await driver.start();
  let viewerPage: Page | null = null;
  try {
    await resetDb(driver.ports.http);
    const r = await fetch(`http://127.0.0.1:${driver.ports.http}/api/nifti/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: nifti, modality: "MR", patientId: "ROITS", patientName: "ROITS^TEST", seriesDescription: "dyn4d" }),
    });
    const imp = (await r.json()) as { imported?: number };
    check(r.ok && (imp.imported ?? 0) > 0, "4D NIfTI の取り込み", imp);

    const mainPage = driver.page;
    try {
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await mainPage.reload({ waitUntil: "domcontentloaded" });
      await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    }
    await openFirstSeriesInViewer(mainPage, recorder);
    viewerPage = await driver.waitForNewPage(
      () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
    await viewerPage.waitForTimeout(2000);

    // ROI が無いとき: 存在しない ROI は失敗で返る（負例）。
    const none = await runPlugin(viewerPage);
    check(none.roiCount === 0 && none.series.length === 0, "ROI が無ければ系列は空", none.roiTools);
    check(none.unknownRoi.ok === false, "存在しない ROI は ok:false（欠損を成功として返さない）", none.unknownRoi);

    // 楕円 ROI を実際に描く（画像の内側に収まる大きさ）。
    await viewerPage.getByTestId("viewer2d-menu-roi").click();
    const ell = viewerPage.getByRole("button", { name: /^(楕円 ROI|Ellipse ROI)$/ });
    check((await ell.count()) > 0, "ROI メニューに楕円 ROI が出る");
    await ell.first().click();
    await viewerPage.waitForTimeout(300);
    await dragOnCanvasHost(viewerPage, "viewer2d-canvas-host", 60, 50, 0, 10, { fracX: 0.4, fracY: 0.4 });
    await viewerPage.waitForTimeout(800);
    await viewerPage.screenshot({ path: path.join(OUT_DIR, "roi-drawn.png") });

    const got = await runPlugin(viewerPage);
    console.log(JSON.stringify(got.series.map((s) => ({ tool: s.tool, slice: s.sliceIndex, own: s.ownMean, res: s.result })), null, 1));
    check(got.series.length === 1, "描いた楕円 ROI が 1 件読める", got.roiTools);
    const s = got.series[0];
    const res = s?.result;
    check(!!res?.ok, "roiTimeSeries が成功する", res);
    const pts = res?.points ?? [];
    check(pts.length === NT, `時相数 ${NT} の点が返る`, pts.length);
    check((res?.warnings ?? []).length === 0, "警告なし（画像内に収まり、全時相が読めた）", res?.warnings);
    check(res?.timeSource === "TriggerTime", "経過秒の出所 = TriggerTime", res?.timeSource);
    check(pts.every((p) => typeof p.mean === "number" && p.n > 0), "全時相に平均と画素数がある（欠損なし）", pts);

    // 期待値は ROI の位置に依らない形: 平均の差 = 100*t、SD は不変、秒 = TR*t。
    let worstMean = 0, worstSd = 0, worstSec = 0;
    for (const p of pts) {
      worstMean = Math.max(worstMean, Math.abs((p.mean ?? NaN) - (pts[0].mean ?? NaN) - 100 * p.t));
      worstSd = Math.max(worstSd, Math.abs((p.sd ?? NaN) - (pts[0].sd ?? NaN)));
      worstSec = Math.max(worstSec, Math.abs((p.timeSec ?? NaN) - TR_SEC * p.t));
    }
    check(worstMean < 1e-3, "平均の時相差 = 100*t（同じ領域を全時相に当てている）", worstMean);
    check(worstSd < 1e-6, "SD は全時相で同じ", worstSd);
    check(worstSec < 1e-6, "経過秒 = TR × t", worstSec);
    // 時相 0 の平均は、本体が画面に出す ROI 統計と同じ（同じエンジンを通る）。
    check(s?.ownMean !== null && Math.abs((pts[0]?.mean ?? NaN) - (s?.ownMean ?? NaN)) < 1e-3,
      "時相 0 の平均 = 本体の ROI 統計の平均", { series: pts[0]?.mean, own: s?.ownMean });
    // 値の水準の確認: x の平均は 0〜63 の範囲なので、時相 0 の平均は 100〜163 の間。
    const m0 = pts[0]?.mean ?? NaN;
    check(m0 >= 100 && m0 <= 163, "時相 0 の平均が 100 + x の範囲にある", m0);
  } finally {
    await viewerPage?.close().catch(() => {});
    await driver.stop();
  }
}

try {
  await main();
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
process.exitCode = process.exitCode || (summary() > 0 ? 1 : 0);
