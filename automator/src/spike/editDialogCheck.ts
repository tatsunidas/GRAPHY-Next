/*
 * ROI の属性編集ダイアログ: (1) 入力欄でドラッグ選択して外で離しても閉じない（背景の onClick の不具合）、
 * (2) 保存した名前が ROI マネージャの行に出る（uncontrolled input の不具合）。実行: cd automator && npx tsx src/spike/editDialogCheck.ts
 */
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

const PLUGIN_ID = "segmentapi-check"; // プラグインは使わない（配置のみ）
const PLUGIN_SRC = path.join(AUTOMATOR_ROOT, "plugins", PLUGIN_ID);
const PHANTOM = path.join(os.homedir(), "graphy-workspace", "graphy-next-plugin-dosimetry", "bench", "phantom", "GNBP-D");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "edit-dialog-check");

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

    console.log("\n[1] Wand 2D でマスクを作る");
    await viewer.getByTestId("viewer2d-menu-roiTools").click();
    await viewer.getByRole("button", { name: /2D Wand/ }).first().click();
    await viewer.waitForTimeout(400);
    const cv = await viewer.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
    if (!cv) throw new Error("canvas なし");
    await viewer.mouse.click(cv.x + cv.width * 0.4, cv.y + cv.height * 0.46);
    await viewer.waitForTimeout(1500);
    await viewer.getByRole("button", { name: /^Apply$|^適用$/ }).first().click().catch(() => undefined);
    await viewer.waitForTimeout(500);

    console.log("\n[2] ROI マネージャ → ✎（Edit attributes）");
    await viewer.getByTestId("viewer2d-menu-roiTools").click();
    await viewer.getByRole("button", { name: /ROI Manager|ROI マネージャ/ }).first().click();
    await viewer.waitForTimeout(800);
    const edit = viewer.locator('button[title="Edit attributes"], button[title="属性編集"]').first();
    await edit.click();
    const dlg = viewer.locator('input[type="text"]').filter({ has: viewer.locator("xpath=.") });
    const labelInput = viewer.locator('div:has(> label)').locator('input[type="text"]').first();
    await viewer.waitForTimeout(400);
    const isOpen = async () => (await viewer!.getByText(/Edit attributes|属性編集/).count()) > 0;
    check(await isOpen(), "ダイアログが開く");
    void dlg;
    // 名前を打つ
    const inp = viewer.locator('input[type="text"]').filter({ hasNot: viewer.locator("[data-testid]") });
    void inp;
    const target = viewer.locator("div").filter({ has: viewer.getByText(/^Label$|^ラベル$/) }).locator('input[type="text"]').last();
    await target.click();
    await viewer.keyboard.type("liver-name", { delay: 30 });
    await viewer.waitForTimeout(600);
    check(await isOpen(), "★ 打っている間は閉じない");

    console.log("\n[3] 入力欄の中で押して、ダイアログの外で離す（テキスト選択のドラッグ）");
    const bb = await target.boundingBox();
    if (!bb) throw new Error("入力欄の位置が取れない");
    await viewer.mouse.move(bb.x + bb.width - 4, bb.y + bb.height / 2);
    await viewer.mouse.down();
    await viewer.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2, { steps: 5 });
    await viewer.mouse.move(5, 5, { steps: 10 }); // ダイアログの外（背景）
    await viewer.mouse.up();
    await viewer.waitForTimeout(500);
    check(await isOpen(), "★ 入力欄でドラッグ選択して外で離しても、ダイアログは閉じない（入力も残る）");
    check((await target.inputValue()).includes("liver-name"), "打った名前が残っている", await target.inputValue());
    // 負例（普通のクリックは閉じる）: 背景を普通に押すと閉じる。まず別の入力でもう一度確かめるため、いったん開き直す
    await viewer.mouse.click(5, 5);
    await viewer.waitForTimeout(500);
    check(!(await isOpen()), "★ 背景を普通に押したら閉じる（閉じる機能は残っている）");

    console.log("\n[4] 保存すると、ROI マネージャの行の名前が変わるか");
    const rowName = async () => viewer!.locator('[data-testid="roi-row"][data-kind="painted"] input[type="text"]').first().inputValue();
    const before = await rowName();
    await viewer.locator('button[title="Edit attributes"], button[title="属性編集"]').first().click();
    await viewer.waitForTimeout(400);
    const t2 = viewer.locator("div").filter({ has: viewer.getByText(/^Label$|^ラベル$/) }).locator('input[type="text"]').last();
    await t2.fill("renamed-by-dialog");
    await viewer.getByRole("button", { name: /^Save$|^保存$/ }).click();
    await viewer.waitForTimeout(800);
    const after = await rowName();
    console.log(`  行の名前: "${before}" → "${after}"（ダイアログで renamed-by-dialog に変更）`);
    check(after === "renamed-by-dialog", "★ ダイアログで保存した名前が、ROI マネージャの行に出る", { before, after });
    // 行で打っている最中は、再描画で文字を上書きされない
    const rowInput = viewer.locator('[data-testid="roi-row"][data-kind="painted"] input[type="text"]').first();
    await rowInput.click();
    await viewer.keyboard.press("End");
    await viewer.keyboard.type("-xyz", { delay: 40 });
    check((await rowInput.inputValue()) === "renamed-by-dialog-xyz", "★ 行で打った文字は、打っている最中に上書きされない", await rowInput.inputValue());
    await viewer.screenshot({ path: path.join(OUT_DIR, "edit-dialog.png") });
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
