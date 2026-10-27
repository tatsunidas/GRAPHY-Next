/*
 * 旧版の保存ファイルの `analyses`（2D QCA の解析状態）が、本体の読み込み → 保存で消えないことの実機検証。
 *
 * 実行:  cd automator && [XA_CALIB_DIR=<DICOM のあるフォルダ>] npx tsx src/spike/roiAnalysesPassThroughCheck.ts
 *        既定のフォルダは ~/graphy_sample_images/virtual-vessel（合成画素。リポジトリには入れない）。
 *
 * 手順: ① 旧版が書いた形の `analyses` を持つ保存ファイルを backend に置く → ② ビューアを開いて長さ計測を 1 本引く
 *       （＝アプリ自身が自動保存で書き戻す）→ ③ 保存ファイルを読み直し、`analyses` が中身ごと同一か見る。
 * 負例: `analyses` が無い保存ファイルでは、書き戻したあとも `analyses` が空のまま（本体が値を作らない）。
 *
 * 🔴 ③の前に、書き戻しが実際に起きたこと（ROI が 1 件になり writer が graphy-next）を確かめる。
 *    起きていなければ「変わらなかった」は何も示さない。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";

const DIR = process.env.XA_CALIB_DIR ?? path.join(os.homedir(), "graphy_sample_images", "virtual-vessel");
const FILE = "Case2_A.dcm";
const HOST = "viewer2d-canvas-host";

/** 旧版が書いた形（と、読めない形）。中身は本体が読まないので、形は問わない。 */
const LEGACY: unknown[] = [
  { pickUid: "legacy-pick-1", imageId: "legacy-image", result: { mld: 1.23, nested: [1, 2, { a: "b" }] }, edits: { waypoints: [[1, 2], [3, 4]] } },
  { pickUid: "legacy-pick-2", note: "別の解析" },
  "文字列の要素",
  42,
  null,
];

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

interface Doc { patientKey: string; json: string | null; roiCount: number; version: number | null }
const url = (port: number, key: string) => `http://127.0.0.1:${port}/api/rois?patientKey=${encodeURIComponent(key)}`;
async function getDoc(port: number, key: string): Promise<Doc> {
  const res = await fetch(url(port, key));
  if (!res.ok) throw new Error(`GET /api/rois ${res.status}`);
  return (await res.json()) as Doc;
}
async function putDoc(port: number, key: string, json: string, roiCount: number, version: number | null): Promise<Doc> {
  const res = await fetch(url(port, key), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ json, roiCount, version }),
  });
  if (!res.ok) throw new Error(`PUT /api/rois ${res.status}: ${await res.text()}`);
  return (await res.json()) as Doc;
}

async function patientKeyOf(port: number): Promise<string> {
  const studies = (await (await fetch(`http://127.0.0.1:${port}/api/studies`)).json()) as Array<{
    patientId?: string; patientName?: string; studyInstanceUid: string;
  }>;
  if (!studies[0]) throw new Error("no study imported");
  return studies[0].patientId || studies[0].patientName || studies[0].studyInstanceUid;
}

/** ビューアを開いて長さ計測を 1 本引き、自動保存で ROI が 1 件になるのを待つ。 */
async function drawOneAndWaitSaved(driver: DesktopDriver, port: number, key: string): Promise<Doc | null> {
  const main = driver.page;
  await waitForMainScreenReady(main, 60_000);
  await dismissStartupDialogs(main);
  main.once("dialog", (d) => void d.accept());
  const dates = main.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await main.getByTestId("search-submit-button").click();
  const studyRow = main.locator('[data-testid^="study-row-"]').first();
  await studyRow.waitFor({ state: "visible", timeout: 30_000 });
  await studyRow.click();
  const seriesRow = main.locator('[data-testid^="series-row-"]').first();
  await seriesRow.waitFor({ state: "visible", timeout: 20_000 });
  await seriesRow.click();
  const viewer = await driver.waitForNewPage(
    () => main.getByTestId("viewer2d-toolbar-button").click(),
    (u) => u.includes("2dviewer"),
  );
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await viewer.waitForTimeout(3_000);
  await viewer.getByTestId("viewer2d-menu-measure").click();
  await viewer.waitForTimeout(300);
  await viewer.getByText("長さ", { exact: true }).first().click();
  await viewer.waitForTimeout(400);
  await dragOnCanvasHost(viewer, HOST, 120, 0, 0, 10, { fracX: 0.3, fracY: 0.35 });
  for (let i = 0; i < 40; i++) {
    const doc = await getDoc(port, key);
    if (doc.roiCount === 1) return doc;
    await viewer.waitForTimeout(500);
  }
  return null;
}

async function main(): Promise<void> {
  const sample = path.join(DIR, FILE);
  if (!fs.existsSync(sample)) throw new Error(`DICOM がありません: ${sample}`);
  for (const withAnalyses of [true, false]) {
    console.log(withAnalyses ? "\n[正例] analyses を持つ保存ファイル" : "\n[負例] analyses が無い保存ファイル");
    const driver = new DesktopDriver();
    await driver.start();
    try {
      const port = driver.ports.http;
      await resetDb(port);
      const imp = await importPaths(port, [sample]);
      if (imp.imported !== 1) throw new Error(`取込に失敗: ${JSON.stringify(imp)}`);
      const key = await patientKeyOf(port);
      const seeded = JSON.stringify({ schema: 1, writer: "legacy-writer", rois: [], ...(withAnalyses ? { analyses: LEGACY } : {}) });
      const put = await putDoc(port, key, seeded, 0, null);
      check(put.roiCount === 0 && put.json === seeded, "旧版の保存ファイルを置けた（読み戻して同一）");

      const after = await drawOneAndWaitSaved(driver, port, key);
      check(!!after, "アプリが自動保存した（ROI が 1 件になった）");
      if (!after?.json) continue;
      const parsed = JSON.parse(after.json) as { writer?: string; rois?: unknown[]; analyses?: unknown };
      check(parsed.writer === "graphy-next" && parsed.rois?.length === 1, "書き戻したのは本体（writer=graphy-next）で、計測が入っている", { writer: parsed.writer, n: parsed.rois?.length });
      if (withAnalyses) {
        check(JSON.stringify(parsed.analyses) === JSON.stringify(LEGACY), "analyses が中身・順序とも同一で残っている", parsed.analyses);
      } else {
        check(Array.isArray(parsed.analyses) && parsed.analyses.length === 0, "analyses を本体が作らない（空のまま）", parsed.analyses);
      }
    } finally {
      await driver.stop();
    }
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
