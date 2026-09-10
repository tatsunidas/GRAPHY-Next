/*
 * ROI 改良 5 件の実機検証スパイク（`fw/roi-manager-design.md` §12 /
 * `fw/roi-stats-design.md` 変更履歴 / `fw/mainscreen-tools.md` Anonymizer §）。
 *
 * 実行:  cd automator && npx tsx src/spike/roiImprovementsCheck.ts
 *
 * 🔴 **押す系は押した検査でしか守れない**（CLAUDE.md ルール 9）。ここでは
 * 「要素があること」ではなく **実際に押して・送って・貼って、結果が画面に出ること**を見る。
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ 本物の CT データ）:
 *   1. プローブに**読んだ画素の座標**が出る。別の場所を打てば座標も変わる。
 *   2. **Mod+C → スライスを送る → Mod+V** で、同じ形の ROI が**貼り付け先のスライス**に出る。
 *      面積が元と一致する（＝形が保たれている）。
 *   3. ROI マネージャの**行を押すと**、その ROI のスライスへ表示が戻る。
 *   4. **⧉** を押すと複製が増え、表示中のスライスに出る。
 *   5. 匿名化ダイアログに**描いた面 ROI が一覧され**、チェックして登録するとマスクになる。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と
 *       fixture ct-basic（`npx tsx src/cli.ts check-fixtures`）。
 *
 * ⚠ **未検証（このスパイクの外）**: XA（マルチフレーム）での貼り付け先フレーム、
 *   ThickSlab 中の貼り付けブロック、スプライン Fit した ROI の複製、再起動後の復元。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-improvements-check");
const HOST = "viewer2d-canvas-host";

const AREA = /面積|Area/;
const COORD = /座標|Coord/;

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

/** ROI 脇の textBox に**いま描かれている文字**を読む（画面から測る）。 */
async function readTextBoxLines(page: Page): Promise<string[]> {
  return page.evaluate(`
    (function () {
      var host = document.querySelector('[data-testid="${HOST}"]');
      if (!host) return [];
      var out = [];
      host.querySelectorAll("svg text").forEach(function (t) {
        var spans = t.querySelectorAll("tspan");
        if (spans.length) spans.forEach(function (s) { out.push((s.textContent || "").trim()); });
        else out.push((t.textContent || "").trim());
      });
      return out.filter(function (s) { return s.length > 0; });
    })()
  `) as Promise<string[]>;
}

/** キャンバス上の 1 点をクリック（プローブ・ROI の選択）。 */
async function clickCanvas(page: Page, fracX: number, fracY: number): Promise<void> {
  const args = JSON.stringify({ hostTestId: HOST, fracX, fracY });
  await page.evaluate(`
    (function (a) {
      var host = document.querySelector('[data-testid="' + a.hostTestId + '"]');
      var canvas = host && host.querySelector("canvas");
      if (!canvas) throw new Error("canvas not found");
      var r = canvas.getBoundingClientRect();
      var x = r.left + r.width * a.fracX, y = r.top + r.height * a.fracY;
      function fire(type, btns) {
        var common = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: btns };
        canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, common, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), common));
      }
      fire("pointermove", 0); fire("pointerdown", 1); fire("pointerup", 0);
    })(${args})
  `);
}

async function pickTool(page: Page, labelRe: RegExp): Promise<void> {
  await page.getByTestId("viewer2d-menu-roi").click();
  await page.getByRole("button", { name: labelRe }).first().click();
  await page.waitForTimeout(250);
}

async function clearRois(page: Page): Promise<void> {
  await page.getByTestId("viewer2d-menu-roi").click();
  await page.getByRole("button", { name: /^(ROI を全消去|Clear ROIs)$/ }).first().click();
  await page.waitForTimeout(800);
}

async function openRoiManager(page: Page): Promise<void> {
  if (await page.getByTestId("roi-mgr-save").isVisible().catch(() => false)) return;
  await page.getByTestId("viewer2d-menu-roiTools").click();
  await page.getByRole("button", { name: /ROI マネージャ|ROI manager/ }).first().click();
  await page.getByTestId("roi-mgr-save").waitFor({ state: "visible", timeout: 10_000 });
}

/** 表示中スライス（Z スライダーの値）。画面の状態そのもの。 */
async function sliceIndex(page: Page): Promise<number> {
  return Number(await page.getByTestId("dim-slider-z").inputValue());
}

async function setSlice(page: Page, z: number): Promise<void> {
  await page.getByTestId("dim-slider-z").fill(String(z));
  await page.waitForTimeout(900);
}

/** ROI マネージャの行数（＝画面に見えている ROI の数）。 */
async function roiRowCount(page: Page): Promise<number> {
  return page.locator('[data-testid="roi-mgr-row"]').count();
}

/** `座標: (123, 45)` から数値対を取り出す。 */
function coordOf(lines: string[]): [number, number] | null {
  for (const l of lines) {
    if (!COORD.test(l)) continue;
    const m = /\((-?\d+),\s*(-?\d+)\)/.exec(l);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return null;
}

/** `面積: 12.44 mm²` の数値。 */
function areaOf(lines: string[]): number | null {
  for (const l of lines) {
    if (!AREA.test(l)) continue;
    const m = /(-?\d+(?:\.\d+)?)/.exec(l.replace(/^[^:]*:/, ""));
    if (m) return Number(m[1]);
  }
  return null;
}

async function openViewer(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  mainPage.on("console", (m) => {
    if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
  });
  await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewerPage = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  viewerPage.on("console", (m) => {
    const txt = m.text();
    if (/roi paste|roi restore/.test(txt)) console.log(`  [viewer log] ${txt}`);
  });
  await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewerPage.waitForTimeout(3000);
  return viewerPage;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importFixtureCategory(d.ports.http, "ct-basic"))}`);
    const viewer = await openViewer(d);
    viewer.on("dialog", (dlg) => void dlg.accept());

    // ── 1. プローブに画素座標が出る ──────────────────────────────
    console.log("\n[1] プローブに「読んだ画素の座標」が出る");
    await clearRois(viewer);
    await pickTool(viewer, /プローブ|^Probe$/);
    await clickCanvas(viewer, 0.40, 0.40);
    await viewer.waitForTimeout(1200);
    const p1 = await readTextBoxLines(viewer);
    const c1 = coordOf(p1);
    check(c1 !== null, "プローブ脇に座標 (col, row) が出る", p1);
    check(p1.some((l) => /HU/.test(l)), "同じ場所に画素値（HU）も出る", p1);

    await clickCanvas(viewer, 0.60, 0.55);
    await viewer.waitForTimeout(1200);
    const p2 = await readTextBoxLines(viewer);
    const coords = p2.filter((l) => COORD.test(l));
    check(coords.length === 2, "2 点打つと座標が 2 つ出る", coords);
    check(
      coords.length === 2 && coords[0] !== coords[1],
      "🔴 別の場所を打てば座標も変わる（固定値を出していない）",
      coords,
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-probe.png") });

    // ── 2. コピー＆ペースト ──────────────────────────────────────
    console.log("\n[2] Mod+C → スライスを送る → Mod+V");
    await clearRois(viewer);
    await setSlice(viewer, 10);
    await pickTool(viewer, /矩形 ROI|Rectangle ROI/);
    await dragOnCanvasHost(viewer, HOST, 100, 80, 0, 10, { fracX: 0.30, fracY: 0.30 });
    await viewer.waitForTimeout(1500);
    const srcLines = await readTextBoxLines(viewer);
    const srcArea = areaOf(srcLines);
    check(srcArea !== null, "元の ROI に面積が出ている", srcLines);

    // 🚨 **描いた ROI に ZCT scope が付くこと**（＝患者・シリーズが紐付いていること）。
    //    上流の ANNOTATION_COMPLETED は eventTarget にしか飛ばないので、element に購読して
    //    いた頃は**一度も発火せず**、scope も patientKey も付いていなかった。
    //    そのままだと ⑤（匿名化の ROI 一覧）が「描いた ROI を見つけられない」。
    await openRoiManager(viewer);
    const srcScope = await viewer.locator('[data-testid="roi-mgr-row"]').first().textContent();
    check(/z\d+ c\d+ t\d+/.test(srcScope ?? ""), "描いた ROI に ZCT scope が付く（患者・シリーズの紐付け）", srcScope);

    // 描画ツールのままだと「選ぶ」つもりのクリックで新しい ROI を描いてしまうので W/L に戻す。
    await viewer.getByTitle(/W\/L|ウィンドウ/).first().click();
    await viewer.waitForTimeout(300);
    // 矩形の辺を掴んで選択する（利用者と同じ操作）。
    await clickCanvas(viewer, 0.30, 0.30);
    await viewer.waitForTimeout(400);

    await viewer.keyboard.press("Control+c");
    await viewer.waitForTimeout(600);
    const copyToast = await viewer.locator('[data-testid="viewer2d-toast"]').textContent().catch(() => null);
    console.log(`  copy toast: ${copyToast}`);
    check(/コピーしました|ROI copied/.test(copyToast ?? ""), "Mod+C でコピーできた", copyToast);
    await setSlice(viewer, 13);
    check((await sliceIndex(viewer)) === 13, "スライスを 13 へ送れた");
    await viewer.keyboard.press("Control+v");
    await viewer.waitForTimeout(1200);
    const pasteToast = await viewer.locator('[data-testid="viewer2d-toast"]').textContent().catch(() => null);
    console.log(`  paste toast: ${pasteToast}`);
    await viewer.waitForTimeout(800);

    await openRoiManager(viewer);
    const afterPaste = await roiRowCount(viewer);
    check(afterPaste === 2, "貼り付けで ROI が 2 本になる", afterPaste);
    check((await sliceIndex(viewer)) === 13, "貼り付け後も 13 枚目のまま（勝手に飛ばない）");
    const pastedLines = await readTextBoxLines(viewer);
    const pastedArea = areaOf(pastedLines);
    check(pastedArea !== null, "貼り付け先のスライスに ROI が描かれている", pastedLines);
    check(
      srcArea !== null && pastedArea !== null && Math.abs(srcArea - pastedArea) < 0.01,
      "🔴 面積が元と一致する（＝同じ形が保たれている）",
      { src: srcArea, pasted: pastedArea },
    );
    await viewer.screenshot({ path: path.join(OUT_DIR, "2-paste.png") });

    // ── 3. 一覧の行を押すと、その ROI のスライスへ戻る ──────────────
    console.log("\n[3] ROI マネージャの行を押すとハイライト＋スライス移動");
    await viewer.locator('[data-testid="roi-mgr-row"]').first().click({ position: { x: 2, y: 2 } });
    await viewer.waitForTimeout(1200);
    const revealed = await sliceIndex(viewer);
    check(revealed === 10, "1 本目（10 枚目に描いた ROI）の行を押すと 10 枚目へ戻る", revealed);
    const selected = await viewer.evaluate(`
      (function () {
        var w = window;
        return (w.cornerstoneTools && w.cornerstoneTools.annotation)
          ? (w.cornerstoneTools.annotation.selection.getAnnotationsSelected() || []).length : -1;
      })()
    `) as number;
    // グローバルが露出していない場合は -1。その場合は画面の選択枠を見る（下の screenshot が証拠）。
    if (selected >= 0) check(selected === 1, "選択が 1 本になっている（ハイライト）", selected);
    await viewer.screenshot({ path: path.join(OUT_DIR, "3-reveal.png") });

    // ── 4. ⧉ で複製 ─────────────────────────────────────────────
    console.log("\n[4] ROI マネージャの ⧉ で複製");
    await setSlice(viewer, 16);
    await viewer.locator('[data-testid="roi-mgr-duplicate"]').first().click();
    await viewer.waitForTimeout(1800);
    const afterDup = await roiRowCount(viewer);
    check(afterDup === 3, "⧉ で ROI が 3 本になる", afterDup);
    check((await sliceIndex(viewer)) === 16, "複製先（表示中の 16 枚目）が見えている", await sliceIndex(viewer));
    const dupLines = await readTextBoxLines(viewer);
    check(areaOf(dupLines) !== null, "16 枚目に複製が描かれている", dupLines);
    await viewer.screenshot({ path: path.join(OUT_DIR, "4-duplicate.png") });

    // ── 5. 匿名化ダイアログから焼き込みマスクを登録 ──────────────────
    console.log("\n[5] 匿名化ダイアログに面 ROI が一覧され、チェックして登録できる");
    await viewer.waitForTimeout(2500); // ROI の自動保存（デバウンス 1.5 秒）を待つ
    const main = d.page;
    await main.bringToFront();
    await main.getByTestId("toolbar-anonymizer-btn").click();
    await main.waitForTimeout(1000);
    // Clean Pixel Data を ON にすると焼き込み節が出る。
    await main.getByText(/ピクセル焼き込み除去|Clean pixel burn-in/).first().click();
    await main.waitForTimeout(2500);
    const roiRows = await main.locator('[data-testid="anon-mask-roi-row"]').count();
    // 🔴 件数まで見る。「1 本でも出た」で通すと、**描いた ROI が落ちて貼り付けた ROI だけ
    //    出ている**状態を見逃す（実際にそれで一度通してしまった）。
    check(roiRows === 3, "描いた・貼った・複製した面 ROI が 3 本とも一覧される", roiRows);
    if (roiRows >= 1) {
      for (let i = 0; i < roiRows; i++) {
        await main.locator('[data-testid="anon-mask-roi-row"] input[type="checkbox"]').nth(i).check();
      }
      await main.getByTestId("anon-mask-apply").click();
      await main.waitForTimeout(2500);
      const dlgText = await main.evaluate(`document.body.textContent || ""`) as string;
      check(/焼き込みマスク \([1-9]/.test(dlgText) || /Burn-in masks \([1-9]/.test(dlgText),
        "登録後、焼き込みマスクの件数が 1 以上になる", dlgText.match(/(焼き込みマスク|Burn-in masks) \(\d+\)/)?.[0]);
      // チェックを外して押し直すと**減る**（追記ではなく置き換えになっていること）。
      for (let i = 0; i < roiRows; i++) {
        await main.locator('[data-testid="anon-mask-roi-row"] input[type="checkbox"]').nth(i).uncheck();
      }
      await main.getByTestId("anon-mask-apply").click();
      await main.waitForTimeout(2500);
      const after = await main.evaluate(`document.body.textContent || ""`) as string;
      check(/(焼き込みマスク|Burn-in masks) \(0\)/.test(after),
        "🔴 チェックを外して押すと 0 件に戻る（追記ではなく置き換え）",
        after.match(/(焼き込みマスク|Burn-in masks) \(\d+\)/)?.[0]);
    }
    await main.screenshot({ path: path.join(OUT_DIR, "5-anonymizer.png") });
  } finally {
    await d.stop();
  }

  console.log(`\n結果: ${passed} ok / ${failures.length} FAIL`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`スクリーンショット: ${OUT_DIR}`);
  process.exit(failures.length ? 1 : 0);
}

void main();
