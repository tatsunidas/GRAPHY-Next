/*
 * H80（listSegments）・H81（loadSegmentMask）の実機検証スパイク。
 *
 * 実行:  cd automator && GRAPHY_AUTOMATOR_BACKEND_JAR=<jar> npx tsx src/spike/segmentApiCheck.ts
 *
 * <p><b>何を確かめるか</b>（本物の Electron ＋ backend ＋ プラグイン配信経路）:
 *   1. Wand をする前は、セグメントが 0 件（負例）。未知の id は null。
 *   2. Wand 3D で肝を取ると、listSegments に 1 件出る（ROI マネージャのマスクと同じもの）。
 *   3. loadSegmentMask のボクセル数が、Wand ダイアログの「Voxels filled」と一致する。
 *   4. マスク上の getPixelData の値が、肝の真値（ファントム GNBP-D）と一致する。
 *   5. 返った配列を書き換えても、読み直した結果は変わらない（コピー）。存在しない segment は null。
 *   6. しきい値を変えて Wand をやり直すと、読み直した結果が変わり、また Voxels filled と一致する。
 *
 * <p>真値はファントム GNBP-D（線量評価プラグインの `bench/`）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver, DESKTOP_RUN_DATA_DIR } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const PLUGIN_ID = "segmentapi-check";
const PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const PHANTOM = path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-dosimetry", "bench", "phantom", "GNBP-D");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "segment-api-check");

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

interface Summary {
  cols: number; rows: number; voxelCount: number; sliceCount: number;
  perSlice: { sliceIndex: number; count: number; sop: string | null; length: number }[];
  mean: number | null; min: number; max: number;
}

async function main(): Promise<void> {
  if (!fs.existsSync(path.join(PHANTOM, "dicom"))) {
    console.error(`ファントムがありません: ${PHANTOM}/dicom（graphy-next-plugin-dosimetry で npm run phantom:dicom）`);
    process.exit(1);
  }
  const truth = JSON.parse(fs.readFileSync(path.join(PHANTOM, "truth.json"), "utf-8"));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const dst = path.join(DESKTOP_RUN_DATA_DIR, "plugins", PLUGIN_ID);
  fs.mkdirSync(dst, { recursive: true });
  for (const f of ["plugin.json", "ui.js"]) fs.copyFileSync(path.join(PLUGIN_SRC, f), path.join(dst, f));

  const driver = new DesktopDriver();
  await driver.start();
  let viewer: Page | null = null;
  try {
    const http = driver.ports.http;
    console.log(`\n[0] 初期化（backend=${http}）`);
    await resetDb(http);
    const dirs = fs.readdirSync(path.join(PHANTOM, "dicom")).filter((d) => d.endsWith("-pt") && d.startsWith("tp0")).map((d) => path.join(PHANTOM, "dicom", d));
    const imp = await fetch(`http://127.0.0.1:${http}/api/import/paths`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ paths: dirs }) });
    console.log(`  import: ${JSON.stringify(await imp.json())}`);
    const tp0 = truth.timepoints[0];

    const main = driver.page;
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await dismissStartupDialogs(main);
    await main.locator('input[type="date"]').nth(0).fill("");
    await main.locator('input[type="date"]').nth(1).fill("");
    await main.getByTestId("search-patientid-input").fill("GNBP-D-1");
    await main.getByTestId("search-submit-button").click();
    await main.waitForTimeout(2500);
    await main.getByTestId(`study-row-${tp0.studyUid}`).click();
    await main.waitForTimeout(1200);
    await main.getByTestId(`series-row-${tp0.spect.dicom}`).click();
    await main.getByTestId("series-viewer-root").waitFor({ state: "visible", timeout: 20_000 });
    await main.waitForTimeout(1500);
    viewer = await driver.waitForNewPage(() => main.getByTestId("viewer2d-toolbar-button").click(), (url: string) => url.includes("2dviewer"));
    await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await viewer.waitForTimeout(2500);

    // 肝のあるスライス（28）へ
    await viewer.evaluate(`(() => {
      const r = document.querySelector('input[type="range"]');
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      set.call(r, "27");
      r.dispatchEvent(new Event("input", { bubbles: true }));
      r.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await viewer.waitForTimeout(1200);

    console.log("\n[1] プローブを起動する（Plug-ins メニュー）");
    await viewer.getByTestId("viewer2d-menu-plugins").click();
    await viewer.getByTestId(`plugin-item-${PLUGIN_ID}`).first().click();
    await viewer.waitForFunction("Boolean(window.__segCheck)", null, { timeout: 20_000 });
    check((await viewer.evaluate("window.__segCheck.hasApi")) === true, "★ 本体が listSegments・loadSegmentMask を渡している");

    console.log("\n[2] Wand の前（負例）");
    const before = (await viewer.evaluate("window.__segCheck.list()")) as unknown[];
    check(Array.isArray(before) && before.length === 0, "★ Wand の前はセグメントが 0 件", before);
    check((await viewer.evaluate(`window.__segCheck.mask("no-such-seg", 1)`)) === null, "★ 未知の segmentationId は null");

    console.log("\n[3] Wand 3D で肝を取る");
    const wandAt = async (fx: number, fy: number): Promise<number> => {
      await viewer!.getByTestId("viewer2d-menu-roiTools").click();
      await viewer!.getByRole("button", { name: /3D Wand/ }).first().click();
      await viewer!.waitForTimeout(400);
      const cv = await viewer!.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
      if (!cv) throw new Error("canvas がありません");
      await viewer!.mouse.click(cv.x + cv.width * fx, cv.y + cv.height * fy);
      await viewer!.waitForTimeout(2500);
      return Number(await viewer!.getByTestId("wand-count").innerText());
    };
    // 肝の中心（患者 mm）→ SPECT の画素座標 → canvas 内の相対位置（本体の worldToCanvas。ズーム・パン込み）
    const liver = truth.objects.find((o: { id: string }) => o.id === "liver");
    const wantConc = liver.concentrationBqPerMl["4.0"] as number;
    const [cxMm, cyMm] = liver.centerMm as number[];
    const sp = truth.geometry.spect.spacingMm[0] as number;
    const cols = truth.geometry.spect.cols as number;
    const px = cxMm / sp + (cols - 1) / 2;
    const py = cyMm / sp + (cols - 1) / 2;
    const frac = (await viewer.evaluate(`window.__graphyDebug.imagePixelsToCanvasFraction([[${px}, ${py}]])`)) as { fx: number; fy: number }[] | null;
    if (!frac?.[0]) throw new Error("imagePixelsToCanvasFraction が null（__graphyDebug は dev ビルドのみ）");
    const count = await wandAt(frac[0].fx, frac[0].fy);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-wand.png") });
    console.log(`  Wand の Voxels filled: ${count}`);
    check(count > 0, "Wand 3D が領域を取った", count);

    console.log("\n[4] listSegments・loadSegmentMask");
    const segs = (await viewer.evaluate("window.__segCheck.list()")) as { tileId: string; segmentationId: string; segmentIndex: number; label: string | null; segmentLabel: string | null }[];
    console.log(`  segments: ${JSON.stringify(segs)}`);
    check(segs.length >= 1, "★ Wand の後はセグメントが出る（ROI マネージャのマスクと同じもの）", segs);
    const seg = segs[0];
    check(!!seg?.segmentationId && seg.segmentIndex >= 1, "id と segmentIndex（1 以上）が入る");
    const sum = (await viewer.evaluate(`window.__segCheck.summary(${JSON.stringify(seg.segmentationId)}, ${seg.segmentIndex})`)) as Summary | null;
    console.log(`  summary: ${JSON.stringify({ ...sum, perSlice: undefined })} slices=${sum?.perSlice.map((s) => s.sliceIndex).join(",")}`);
    check(!!sum, "★ マスクが読める");
    if (sum) {
      check(sum.voxelCount === count, `★ ボクセル数が Wand の Voxels filled と一致（${sum.voxelCount} / ${count}）`);
      check(sum.perSlice.reduce((a, s) => a + s.count, 0) === sum.voxelCount, "スライスごとの数の合計が全体と一致");
      check(sum.perSlice.every((s) => s.length === sum.cols * sum.rows), "各スライスの長さ＝cols×rows");
      const idx = sum.perSlice.map((s) => s.sliceIndex);
      check(idx.every((v, i) => i === 0 || v > idx[i - 1]), "sliceIndex は昇順", idx);
      check(sum.perSlice.every((s) => typeof s.sop === "string" && s.sop.length > 0), "各スライスに SOP UID が入る");
      check(sum.cols === truth.geometry.spect.cols && sum.rows === truth.geometry.spect.rows, "列数・行数がシリーズと一致", { cols: sum.cols, rows: sum.rows });
      // 取った領域が肝なら、マスク上の値は肝の真値に近い（Wand のしきい値の内側なので広がりはある）
      const tolRel = Math.abs((sum.mean ?? 0) - wantConc) / wantConc;
      console.log(`  マスク上の平均 ${sum.mean?.toFixed(0)} / 肝の真値 ${wantConc.toFixed(0)}（相対差 ${(tolRel * 100).toFixed(2)}%）`);
      check(tolRel < 0.05, "★ マスク上の getPixelData の平均が肝の真値と一致（5% 以内）", { mean: sum.mean, want: wantConc });
    }

    console.log("\n[5] コピー・負例");
    const mut = (await viewer.evaluate(`window.__segCheck.mutateThenReload(${JSON.stringify(seg.segmentationId)}, ${seg.segmentIndex})`)) as { before: number; after: number | null } | null;
    check(!!mut && mut.before === mut.after, "★ 返った配列を書き換えても、読み直した結果は変わらない（コピー）", mut);
    check((await viewer.evaluate(`window.__segCheck.mask(${JSON.stringify(seg.segmentationId)}, 99)`)) === null, "★ 存在しない segmentIndex は null");
    check((await viewer.evaluate(`window.__segCheck.mask(${JSON.stringify(seg.segmentationId)}, 0)`)) === null, "segmentIndex 0（背景）は null");

    console.log("\n[6] しきい値を変えて Wand をやり直す");
    const th = viewer.getByTestId("wand-threshold");
    const thBefore = await th.inputValue();
    await th.fill("200000"); // 背景（約 7465）まで届く広さ
    await th.press("Enter");
    await viewer.waitForTimeout(2500);
    const count2 = Number(await viewer.getByTestId("wand-count").innerText());
    console.log(`  しきい値 ${thBefore} → ${await th.inputValue()}: Voxels filled ${count} → ${count2}`);
    const sum2 = (await viewer.evaluate(`window.__segCheck.summary(${JSON.stringify(seg.segmentationId)}, ${seg.segmentIndex})`)) as Summary | null;
    if (count2 !== count) {
      check(!!sum2 && sum2.voxelCount === count2, `★ やり直した結果が読み直しに反映され、Voxels filled と一致（${sum2?.voxelCount} / ${count2}）`);
    } else {
      check(false, "しきい値を変えても領域が変わらず、反映の検査にならない（検査条件の問題）", { count, count2 });
    }
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-after-threshold.png") });
  } finally {
    await driver.stop().catch(() => undefined);
  }

  console.log("");
  console.log(`合格 ${passed} / 失敗 ${failures.length}`);
  for (const f of failures) console.log(` - ${f}`);
  console.log(`出力: ${OUT_DIR}`);
  if (failures.length > 0) process.exit(1);
}

await main();
