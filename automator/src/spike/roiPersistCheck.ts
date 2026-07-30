/*
 * ROI（幾何注釈）永続化の実機検証スパイク（`fw/roi-manager-design.md` M5）。
 *
 * 実行:  cd automator && npx tsx src/spike/roiPersistCheck.ts
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ **アプリの再起動を挟む**）:
 *   1. canvas 上に計測を描くと自動保存される（/api/rois/{patientKey} に載る）
 *   2. **アプリを完全に終了して起動し直しても復元される**（これが本題）
 *   3. 復元後も **annotationUID が同一**（プラグインが時系列追跡の鍵に使えること）
 *   4. 復元後も **計測値(mm)が同一**（world 座標で保存しているので丸め誤差が入らない）
 *   5. 削除が墓標として保存され、再起動後に復活しない
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と
 *       fixture ct-basic（`npx tsx src/cli.ts check-fixtures`）。
 *       検証は hostapi-check プラグインの getRois()（H5）で読む＝公式契約だけを使う。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

interface RoiSummary {
  roiUid: string;
  tool: string;
  sliceIndex: number;
  sopInstanceUid: string | null;
  measurements: { length?: number; shortAxis?: number; longAxisMm?: number; shortAxisMm?: number };
}
interface Payload {
  rois?: RoiSummary[];
}
interface RoiDocumentDto {
  patientKey: string;
  json: string | null;
  roiCount: number;
  updatedAt: string | null;
  version: number | null;
}

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-persist-check");
const PLUGIN_ID = "hostapi-check";

function installVerificationPlugin(): void {
  const src = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
}

const failures: string[] = [];
let passed = 0;
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  [ok  ] ${label}`);
  } else {
    console.log(`  [FAIL] ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
    failures.push(label);
  }
}

async function runPlugin(viewerPage: Page): Promise<Payload> {
  await viewerPage.evaluate(() => {
    delete (window as unknown as { __hostApiCheck?: unknown }).__hostApiCheck;
  });
  await viewerPage.getByTestId("viewer2d-menu-plugins").click();
  await viewerPage.getByTestId(`plugin-item-${PLUGIN_ID}`).click();
  await viewerPage.getByTestId("hostapi-check-panel").waitFor({ state: "visible", timeout: 10_000 });
  return viewerPage.evaluate(() => (window as unknown as { __hostApiCheck: Payload }).__hostApiCheck);
}

/** 2D Viewer を開く（MainScreen の先頭シリーズ）。 */
async function openViewer(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  mainPage.on("console", (m) => {
    if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
  });
  try {
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 30_000 });
  } catch {
    await mainPage.reload({ waitUntil: "domcontentloaded" });
    await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  }
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewerPage = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 15_000 });
  await viewerPage.waitForTimeout(2500);
  return viewerPage;
}

async function fetchDoc(httpPort: number, patientKey: string): Promise<RoiDocumentDto> {
  const res = await fetch(`http://localhost:${httpPort}/api/rois/${encodeURIComponent(patientKey)}`);
  if (!res.ok) throw new Error(`GET /api/rois failed: ${res.status}`);
  return (await res.json()) as RoiDocumentDto;
}

/** fixture の患者キー（PatientID → PatientName → StudyUID の順。フロントの derivePatientKey と同じ）。 */
async function patientKeyOf(httpPort: number): Promise<string> {
  const studies = (await (await fetch(`http://localhost:${httpPort}/api/studies`)).json()) as Array<{
    patientId?: string;
    patientName?: string;
    studyInstanceUid: string;
  }>;
  const s = studies[0];
  if (!s) throw new Error("no study imported");
  return s.patientId || s.patientName || s.studyInstanceUid;
}

/** 自動保存が終わるまで待つ（デバウンス 1.5s ＋ 通信）。 */
async function waitSaved(httpPort: number, patientKey: string, expectCount: number): Promise<RoiDocumentDto> {
  for (let i = 0; i < 40; i++) {
    const doc = await fetchDoc(httpPort, patientKey);
    if (doc.roiCount === expectCount) return doc;
    await new Promise((r) => setTimeout(r, 500));
  }
  return fetchDoc(httpPort, patientKey);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  installVerificationPlugin();

  // ============ 1 回目の起動: 描いて保存させる ============
  console.log("\n[1] 起動 1 回目 — ROI を描いて自動保存させる");
  const d1 = new DesktopDriver();
  await d1.start();
  let first: { roiUid: string; length?: number; shortAxis?: number } | null = null;
  let patientKey = "";
  let studyUid = "";
  try {
    const reset = await resetDb(d1.ports.http);
    console.log(`  reset: ${JSON.stringify(reset)}`);
    const imported = await importFixtureCategory(d1.ports.http, "ct-basic");
    console.log(`  fixture import: ${JSON.stringify(imported)}`);
    patientKey = await patientKeyOf(d1.ports.http);
    console.log(`  patientKey=${patientKey}`);

    const viewer = await openViewer(d1);

    // 保存前は空（未保存でも 200 で空の器が返る仕様）。
    const before = await fetchDoc(d1.ports.http, patientKey);
    check(before.roiCount === 0 && before.json === null, "描く前は未保存（空の器が返る）", before);

    // ROI メニュー → 長径・短径（RECIST）→ canvas をドラッグ。
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
    await viewer.waitForTimeout(300);
    await dragOnCanvasHost(viewer, "viewer2d-canvas-host", 120, 0, 0, 10, { fracX: 0.3, fracY: 0.35 });
    await viewer.waitForTimeout(600);

    const drawn = await runPlugin(viewer);
    const roi = drawn.rois?.[0];
    check(!!roi, "描いた ROI が getRois() に見える", drawn.rois?.length);
    if (roi) {
      first = { roiUid: roi.roiUid, length: roi.measurements.length, shortAxis: roi.measurements.shortAxis };
      console.log(`  描いた ROI: ${roi.tool} uid=${roi.roiUid} length=${roi.measurements.length}`);
    }

    // 自動保存（デバウンス）を待つ。
    const doc = await waitSaved(d1.ports.http, patientKey, 1);
    check(doc.roiCount === 1, "自動保存で backend に 1 件保存される", { roiCount: doc.roiCount });
    check(doc.version !== null, "保存されると版が付く", doc.version);
    const saved = doc.json ? (JSON.parse(doc.json) as { rois: Array<{ roiUid: string; sopInstanceUid: string }> }) : null;
    check(saved?.rois?.[0]?.roiUid === first?.roiUid, "保存された UID が画面の ROI と一致", {
      saved: saved?.rois?.[0]?.roiUid,
      shown: first?.roiUid,
    });
    check(
      /^\d+(\.\d+)+$/.test(saved?.rois?.[0]?.sopInstanceUid ?? ""),
      "保存は SOP Instance UID を持つ（imageId ではない）",
      saved?.rois?.[0]?.sopInstanceUid,
    );
    check(
      !(doc.json ?? "").includes("localhost"),
      "保存内容に imageId（localhost を含む URL）が入っていない＝ポート変化に耐える",
    );
    studyUid = (await (await fetch(`http://localhost:${d1.ports.http}/api/studies`)).json() as Array<{ studyInstanceUid: string }>)[0].studyInstanceUid;
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-drawn.png") });
    await viewer.close().catch(() => {});
  } finally {
    await d1.stop();
  }

  if (!first) {
    console.log("\n1 回目で ROI を描けなかったため中断します。");
    process.exitCode = 1;
    return;
  }

  // ============ 2 回目の起動: 復元されるか ============
  // **DB はリセットしない**（H2 は run-data に残る）。これがこの検証の本題。
  console.log("\n[2] 起動 2 回目 — アプリを終了して起動し直し、復元されるか");
  const d2 = new DesktopDriver();
  await d2.start();
  try {
    const doc = await fetchDoc(d2.ports.http, patientKey);
    check(doc.roiCount === 1, "再起動後も backend に保存が残っている", { roiCount: doc.roiCount });

    const viewer = await openViewer(d2);
    const restored = await runPlugin(viewer);
    const r = restored.rois?.[0];
    check(!!r, "再起動後、ROI が復元されて getRois() に見える", restored.rois?.length);
    check(restored.rois?.length === 1, "復元は 1 件だけ（二重復元しない）", restored.rois?.length);
    if (r) {
      check(r.roiUid === first.roiUid, "annotationUID が同一（時系列追跡の鍵として使える）", {
        before: first.roiUid,
        after: r.roiUid,
      });
      check(r.tool === "Bidirectional", "ツール種別が復元される", r.tool);
      check(
        r.measurements.length !== undefined &&
          first.length !== undefined &&
          Math.abs(r.measurements.length - first.length) < 1e-6,
        "計測値(mm)が完全に同一（world 座標保存なので丸め誤差が入らない）",
        { before: first.length, after: r.measurements.length },
      );
      check(
        r.measurements.shortAxis !== undefined &&
          first.shortAxis !== undefined &&
          Math.abs(r.measurements.shortAxis - first.shortAxis) < 1e-6,
        "短軸も同一",
        { before: first.shortAxis, after: r.measurements.shortAxis },
      );
      check(/^\d+(\.\d+)+$/.test(r.sopInstanceUid ?? ""), "復元後も SOP が解決できる", r.sopInstanceUid);
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-restored.png") });

    // ============ 削除が墓標で伝播するか ============
    console.log("\n[3] 削除 → 墓標 → 再起動後に復活しないか");
    // 「ROI を全消去」は native confirm を出す。**先に承諾ハンドラを付けてから**押す
    // （付けずに押すと Playwright が既定で dismiss し、何も削除されない＝実機検証で踏んだ）。
    viewer.on("dialog", (d) => {
      console.log(`  confirm を承諾: ${d.message().slice(0, 60)}`);
      void d.accept();
    });
    await viewer.getByTestId("viewer2d-menu-roi").click();
    await viewer.getByRole("button", { name: /^(ROI を全消去|Clear ROIs)$/ }).first().click();
    await viewer.waitForTimeout(1500);
    const afterClear = await runPlugin(viewer);
    check((afterClear.rois ?? []).length === 0, "画面上の ROI が消えている", afterClear.rois?.length);
    const afterDelete = await waitSaved(d2.ports.http, patientKey, 0);
    check(afterDelete.roiCount === 0, "削除が保存に反映される（0 件）", { roiCount: afterDelete.roiCount });
    const tomb = afterDelete.json
      ? (JSON.parse(afterDelete.json) as { deleted?: Array<{ roiUid: string }> }).deleted ?? []
      : [];
    check(
      tomb.some((x) => x.roiUid === first!.roiUid),
      "削除した UID が墓標として保存される",
      tomb.map((x) => x.roiUid),
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-deleted.png") });
    await viewer.close().catch(() => {});
  } finally {
    await d2.stop();
  }

  // ============ 3 回目の起動: 削除した ROI が復活しないか ============
  console.log("\n[4] 起動 3 回目 — 削除した ROI が復活しないか");
  const d3 = new DesktopDriver();
  await d3.start();
  try {
    const viewer = await openViewer(d3);
    const after = await runPlugin(viewer);
    check(
      (after.rois ?? []).length === 0,
      "削除した ROI は再起動後も復活しない（墓標が効いている）",
      after.rois?.map((x) => x.roiUid),
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-still-deleted.png") });
    await viewer.close().catch(() => {});
  } finally {
    await d3.stop();
  }

  console.log(`\n（参考）studyUid=${studyUid}`);
  console.log("\n=== 結果 ===");
  if (failures.length === 0) {
    console.log(`${passed} 項目すべて OK。スクリーンショット: ${OUT_DIR}`);
  } else {
    console.log(`FAIL ${failures.length} 件:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

await main();
