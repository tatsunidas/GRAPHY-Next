/*
 * Scissors（矩形・円・球で塗る／消す）を実機で確かめるスパイク（`fw/segmentation-tools-design.md` §5.2）。
 *
 * 実行:  cd automator && npx tsx src/spike/scissorsCheck.ts
 *
 * 合成 CT（`scripts/make-ct-quant-phantom.py`、128×112×40、保存値は一様な背景＋直方体）を取り込み、2D ビューアで
 *   1. メニューから Scissors を選ぶとダイアログが出る／W/L に戻すと消える
 *   2. 矩形・塗る: 塗られた個数が、画素中心が canvas 上の矩形に入る個数と一致し、他のスライスは空
 *   3. 矩形・消す: 内側の小さな矩形を消すと、その分だけ減り、外側は残る（範囲外は変わらない）
 *   4. 円・塗る: 離れた場所に塗ると、円の内側の個数だけ増える
 *   5. 球・塗る: 複数スライスに及び、中心スライスから離れたスライスは空
 * を、`window.__graphyDebug.getSegCounts`（labelmap を数える）で測る。表示はスクリーンショットで判定する。
 * 期待値は `countPixelsInCanvasShape`（画素中心の canvas 位置だけで数える。ツール内部の計算とは別）。
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）。
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { Page } from "@playwright/test";

import { WebDriver } from "../driver/webDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { createChecker } from "./computeSpikeShared.js";

const OUT = process.env.SCISSORS_OUT ?? path.join(AUTOMATOR_ROOT, ".results", "scissors-check");
fs.mkdirSync(OUT, { recursive: true });
const CASE = path.join(OUT, "phantom");
execFileSync("python3", [path.join(AUTOMATOR_ROOT, "scripts", "make-ct-quant-phantom.py"), CASE], { stdio: "ignore" });

const { check, summary } = createChecker();
const vis = (p: Page, id: string) => p.getByTestId(id).isVisible().catch(() => false);

async function menu(page: Page, item: RegExp): Promise<void> {
  await page.getByTestId("viewer2d-menu-roiTools").click();
  await page.getByRole("button", { name: item }).first().click();
  await page.waitForTimeout(800);
}

type Counts = { segmentationId: string | null; slices: { index: number; counts: Record<string, number> }[]; total: Record<string, number> } | null;
const dbg = <T>(p: Page, fn: string, ...args: unknown[]): Promise<T> =>
  p.evaluate(([f, a]) => (window as any).__graphyDebug[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const counts = (p: Page) => dbg<Counts>(p, "getSegCounts");

/** canvas 左上を原点にした (x, y) をページ座標へ。 */
async function canvasBox(page: Page) {
  const b = await page.locator('[data-testid="viewer2d-canvas-host"] canvas').first().boundingBox();
  if (!b) throw new Error("canvas がありません");
  return b;
}

async function drag(page: Page, a: [number, number], b: [number, number]): Promise<void> {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + a[0], box.y + a[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + (a[0] + b[0]) / 2, box.y + (a[1] + b[1]) / 2, { steps: 4 });
  await page.mouse.move(box.x + b[0], box.y + b[1], { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(1_500);
}

/** スライダーで k（0 始まり）枚目を表示する。 */
async function gotoSlice(page: Page, k: number): Promise<void> {
  await page.evaluate((v) => {
    const el = document.querySelector('input[type="range"]') as HTMLInputElement;
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, k);
  await page.waitForTimeout(1_200);
}

const sub = (a: number[], b: number[]) => {
  const sb = new Set(b);
  return a.filter((x) => !sb.has(x));
};

const driver = new WebDriver({ http: 18390, scp: 18391, vite: 18393 }, { viewport: { width: 1600, height: 900 }, locale: "ja-JP" });
try {
  await driver.start();
  const main = driver.page;
  await waitForMainScreenReady(main, 60_000);
  await resetDb(driver.ports.http);
  const imp = await importPaths(driver.ports.http, [CASE]);
  check(imp.imported > 0, "合成 CT を取り込めた", imp);
  await main.reload();
  await waitForMainScreenReady(main, 60_000);
  await dismissStartupDialogs(main);
  await main.getByTestId("search-allperiod-chip").click();
  await main.getByTestId("search-submit-button").click();
  await main.locator('[data-testid^="study-row-"]').first().click({ timeout: 20_000 });
  await main.locator('[data-testid^="series-row-"]').first().click({ timeout: 20_000 });
  const viewer = await driver.waitForNewPage(
    () => main.locator('button[title="2D Viewer"]').click(),
    (u) => u.includes("2dviewer"),
  );
  await viewer.locator('[data-testid="viewer2d-canvas-host"] canvas').first().waitFor({ timeout: 60_000 });
  await viewer.waitForTimeout(4_000);

  // 1. ダイアログの出入り
  check(!(await vis(viewer, "scissors-dialog")), "選ぶ前はダイアログが出ない");
  await menu(viewer, /^Scissors/);
  check(await vis(viewer, "scissors-dialog"), "Scissors を選ぶとダイアログが出る");
  await viewer.screenshot({ path: path.join(OUT, "01-dialog.png") });

  const vpId = (await viewer.evaluate(() => (window as any).__graphyDebug.getViewportGeometry()[0].viewportId)) as string;
  const NSLICE = 40;
  const DZ = 2.5; // スライス間隔 mm（make-ct-quant-phantom.py）
  const C = 19; // 中央付近のスライス（0 始まり）
  await gotoSlice(viewer, C);
  const rect = await dbg<number[]>(viewer, "getImageCanvasRect", vpId);
  const [X0, Y0, X1, Y1] = rect;
  const at = (fx: number, fy: number): [number, number] => [X0 + (X1 - X0) * fx, Y0 + (Y1 - Y0) * fy];
  console.log("image on canvas", rect.map((v) => Math.round(v)));
  const sliceOf = (c: Counts, k: number) => c?.slices.find((s) => s.index === k)?.counts["1"] ?? 0;
  const otherSlices = (c: Counts) => (c?.slices ?? []).filter((s) => s.index !== C).length;

  // 2. 矩形・塗る
  await viewer.getByTestId("scissors-shape-rect").click();
  await viewer.getByTestId("scissors-op-fill").click();
  const c0 = await counts(viewer);
  check((c0?.total["1"] ?? 0) === 0, "開始時は何も塗られていない（対照）", c0?.total);
  const r1a = at(0.15, 0.15);
  const r1b = at(0.45, 0.40);
  const set1 = await dbg<{ inner: number[]; outer: number[] }>(viewer, "getShapePixelSets", vpId, "rect", r1a, r1b);
  await drag(viewer, r1a, r1b);
  const m1 = (await dbg<number[]>(viewer, "getSegSlicePixels", C)) ?? [];
  console.log("rect fill", m1.length, "bounds", set1.inner.length, "-", set1.outer.length);
  check(set1.inner.length > 300, "期待範囲が十分大きい（検査が空振りでない）", set1.inner.length);
  check(sub(set1.inner, m1).length === 0, "矩形・塗る: 内側の画素はすべて塗られた", sub(set1.inner, m1).length);
  check(sub(m1, set1.outer).length === 0, "矩形・塗る: 外側の画素は塗られていない", sub(m1, set1.outer).length);
  check(otherSlices(await counts(viewer)) === 0, "矩形・塗る: 他のスライスは空");
  await viewer.screenshot({ path: path.join(OUT, "02-rect-fill.png") });

  // 3. 矩形・消す（内側の小さな矩形）
  await viewer.getByTestId("scissors-op-erase").click();
  const r2a = at(0.22, 0.22);
  const r2b = at(0.32, 0.32);
  const set2 = await dbg<{ inner: number[]; outer: number[] }>(viewer, "getShapePixelSets", vpId, "rect", r2a, r2b);
  await drag(viewer, r2a, r2b);
  const m2 = (await dbg<number[]>(viewer, "getSegSlicePixels", C)) ?? [];
  const removed = sub(m1, m2);
  console.log("rect erase removed", removed.length, "bounds", set2.inner.length, "-", set2.outer.length);
  check(set2.inner.length > 50, "消す範囲の期待が十分大きい", set2.inner.length);
  check(set2.inner.filter((x) => m2.includes(x)).length === 0, "矩形・消す: 内側の画素はすべて消えた", set2.inner.filter((x) => m2.includes(x)).length);
  check(sub(removed, set2.outer).length === 0, "矩形・消す: 範囲の外側は消えていない", sub(removed, set2.outer).length);
  check(sub(m2, m1).length === 0, "矩形・消す: 新たに塗られた画素は無い");
  await viewer.screenshot({ path: path.join(OUT, "03-rect-erase.png") });

  // 4. 円・塗る（離れた場所）
  await viewer.getByTestId("scissors-shape-circle").click();
  await viewer.getByTestId("scissors-op-fill").click();
  const cc = at(0.70, 0.30);
  const cr: [number, number] = [cc[0] + (X1 - X0) * 0.12, cc[1]];
  const set3 = await dbg<{ inner: number[]; outer: number[] }>(viewer, "getShapePixelSets", vpId, "circle", cc, cr);
  await drag(viewer, cc, cr);
  const m3 = (await dbg<number[]>(viewer, "getSegSlicePixels", C)) ?? [];
  const added = sub(m3, m2);
  console.log("circle fill added", added.length, "bounds", set3.inner.length, "-", set3.outer.length);
  check(set3.inner.length > 300, "円の期待範囲が十分大きい", set3.inner.length);
  check(sub(set3.inner, m3).length === 0, "円・塗る: 内側の画素はすべて塗られた", sub(set3.inner, m3).length);
  check(sub(added, set3.outer).length === 0, "円・塗る: 外側の画素は塗られていない", sub(added, set3.outer).length);
  check(sub(m2, m3).length === 0, "円・塗る: 既にあった塗りは消えていない");
  check(otherSlices(await counts(viewer)) === 0, "円・塗る: 他のスライスは空");
  await viewer.screenshot({ path: path.join(OUT, "04-circle-fill.png") });

  // 5. 球・塗る（別の場所。中心スライスから前後に及ぶ）
  await viewer.getByTestId("scissors-shape-sphere").click();
  await viewer.waitForTimeout(500);
  check(await vis(viewer, "scissors-dialog"), "球に切り替えてもダイアログが残る（球が弾かれていない）");
  const sc = at(0.70, 0.72);
  const rpx = (X1 - X0) * 0.10;
  const centreIdx = await dbg<number>(viewer, "canvasToPixelIndex", vpId, sc);
  const pxPerMm = await dbg<number>(viewer, "getCanvasPxPerMm", vpId);
  const Rmm = rpx / pxPerMm;
  await drag(viewer, sc, [sc[0] + rpx, sc[1]]);
  await viewer.waitForTimeout(2_000);
  const c4 = await counts(viewer);
  const painted: number[] = [];
  const unpaintedFar: number[] = [];
  const mustPaint: number[] = [];
  const mustNot: number[] = [];
  for (let k = 0; k < NSLICE; k++) {
    const px = (await dbg<number[]>(viewer, "getSegSlicePixels", k)) ?? [];
    const has = px.includes(centreIdx);
    if (has) painted.push(k);
    const dist = Math.abs(k - C) * DZ;
    if (dist <= 0.9 * Rmm) mustPaint.push(k);
    if (dist > 1.1 * Rmm) mustNot.push(k);
    if (dist <= 0.9 * Rmm && !has) unpaintedFar.push(k);
    if (dist > 1.1 * Rmm && has) unpaintedFar.push(-k - 1000);
  }
  console.log(`sphere R=${Rmm.toFixed(1)} mm, centre pixel painted on slices`, painted, "must", mustPaint.length, "mustNot", mustNot.length);
  check(mustPaint.length >= 5, "球の半径が数スライス分ある（検査が空振りでない）", { Rmm, n: mustPaint.length });
  check(painted.length > 1, "球・塗る: 複数スライスに及ぶ", painted);
  check(unpaintedFar.length === 0, "球・塗る: 半径の内側のスライスは塗られ、外側のスライスは塗られていない", unpaintedFar);
  check(sub(m3, (await dbg<number[]>(viewer, "getSegSlicePixels", C)) ?? []).length === 0, "球・塗る: 既にあった塗りは消えていない");
  await viewer.screenshot({ path: path.join(OUT, "05-sphere-fill-centre.png") });
  await gotoSlice(viewer, C + 2);
  await viewer.screenshot({ path: path.join(OUT, "06-sphere-fill-next-slice.png") });

  // 6. ダイアログは Scissors の間だけ
  await menu(viewer, /^2D Wand/);
  const wandOpen = await vis(viewer, "scissors-dialog");
  await viewer.screenshot({ path: path.join(OUT, "07-after-wand.png") });
  check(!wandOpen, "他のツールに替えるとダイアログが消える");
  console.log("未達: 別 segment の不変（segment を 2 つ作る操作が未自動化）、Windows・macOS");
} finally {
  const failed = summary();
  await driver.stop();
  process.exitCode = failed ? 1 : 0;
}
