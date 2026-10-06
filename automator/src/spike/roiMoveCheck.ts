/*
 * ROI の「作る→動かす→形を変える」の実機検証スパイク（`fw/roi-manager-design.md` §13）。
 *
 * 実行:  cd automator && npx tsx src/spike/roiMoveCheck.ts
 *
 * 🔴 **押す系は押した検査でしか守れない**（CLAUDE.md ルール 9）。ここでは実際にドラッグを送り、
 * ROI の頂点が**ドラッグ量だけ平行移動したか**を canvas 座標（CSS px）の数値で突き合わせる。
 *
 * 何を確かめるか（本物の Electron ＋ 本物の backend ＋ ct-basic）:
 *   1. 矩形を描き終えると、その ROI が選択される
 *   2. 選択中の矩形の内側をドラッグ → ROI の数は変わらず、4 点がドラッグ量だけ動く。統計も変わる
 *   3. 角のハンドルをドラッグ → その角だけ動き、対角は動かない（形が変わる）
 *   4. Esc → 選択が外れる → 内側をドラッグ → ROI が 1 つ増え、元の ROI は動かない（入れ子が描ける）
 *   5. 楕円・ポリゴン・フリーハンドでも 2 と同じ（フリーハンドは線を掴むと描き直し編集のまま）
 *   6. W/L ツールでは、選択中の ROI の内側をドラッグしても ROI は動かず、W/L が変わる
 *
 * 前提: backend jar（`cd backend && mvn -q -Dfrontend.skip=true -DskipTests package`）と fixture ct-basic。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importFixtureCategory } from "../fixtures/importFixtures.js";
import { openFirstSeriesInViewer } from "../checklist/items/shared/helpers.js";
import { createStepRecorder } from "../checklist/types.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "roi-move-check");
const HOST = "viewer2d-canvas-host";
const TOL = 1.0; // CSS px。world↔canvas の往復の丸め分。

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

type Ann = { uid: string; tool: string; points: number[][]; polyline: number[][]; textBox: number[][] | null };

async function anns(page: Page): Promise<Ann[]> {
  return page.evaluate(`window.__graphyDebug.getAnnotationCanvasPoints()`) as Promise<Ann[]>;
}
async function selected(page: Page): Promise<string[]> {
  return page.evaluate(`window.__graphyDebug.getSelectedAnnotations()`) as Promise<string[]>;
}
async function meanOf(page: Page, uid: string): Promise<number | null> {
  const rows = (await page.evaluate(`window.__graphyDebug.getRoiStatsPair()`)) as Array<{ uid: string; byUidMean: number | null }>;
  return rows.find((r) => r.uid === uid)?.byUidMean ?? null;
}
async function windowLevel(page: Page): Promise<{ center: number; width: number } | null> {
  const props = (await page.evaluate(`window.__graphyDebug.getViewportProperties()`)) as Array<{ windowLevel: { center: number; width: number } | null }>;
  return props[0]?.windowLevel ?? null;
}

/**
 * canvas 座標（CSS px）の折れ線に沿って、生の Pointer/Mouse イベントでドラッグする
 * （Playwright の page.mouse は Cornerstone に届かない。`common/pointerDrag.ts` の罠その1）。
 */
async function dragPath(page: Page, pts: number[][], steps = 8): Promise<void> {
  const args = JSON.stringify({ host: HOST, pts, steps });
  await page.evaluate(`
    (function (a) {
      var canvas = document.querySelector('[data-testid="' + a.host + '"] canvas');
      if (!canvas) throw new Error("canvas not found");
      var r = canvas.getBoundingClientRect();
      function fire(type, x, y, btns) {
        var c = { bubbles: true, cancelable: true, composed: true, clientX: r.left + x, clientY: r.top + y, button: 0, buttons: btns };
        canvas.dispatchEvent(new PointerEvent(type, Object.assign({}, c, { pointerId: 1, pointerType: "mouse", isPrimary: true })));
        canvas.dispatchEvent(new MouseEvent(type.replace("pointer", "mouse"), c));
      }
      fire("pointermove", a.pts[0][0], a.pts[0][1], 0);
      fire("pointerdown", a.pts[0][0], a.pts[0][1], 1);
      for (var k = 1; k < a.pts.length; k++) {
        var p = a.pts[k - 1], q = a.pts[k];
        for (var i = 1; i <= a.steps; i++) {
          fire("pointermove", p[0] + (q[0] - p[0]) * i / a.steps, p[1] + (q[1] - p[1]) * i / a.steps, 1);
        }
      }
      var e = a.pts[a.pts.length - 1];
      fire("pointerup", e[0], e[1], 0);
    })(${args})
  `);
  await page.waitForTimeout(700);
}

async function drag(page: Page, from: number[], d: number[]): Promise<void> {
  await dragPath(page, [from, [from[0] + d[0], from[1] + d[1]]]);
}

async function click(page: Page, p: number[]): Promise<void> {
  await dragPath(page, [p], 0);
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

const centroid = (pts: number[][]) => [
  pts.reduce((s, p) => s + p[0], 0) / pts.length,
  pts.reduce((s, p) => s + p[1], 0) / pts.length,
];
const shapeOf = (a: Ann) => (a.polyline.length >= 3 ? a.polyline : a.points);

function inPoly(poly: number[][], p: number[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 内側を掴む点。統計の文字ボックスは ROI の内側に重なることがあり、上流は文字ボックスを先に掴む
 * （ハンドル扱い）ので、**内側かつ文字ボックスの外**で、輪郭から 10px 以上離れた点を外接矩形の格子から選ぶ。
 */
function grabPoint(a: Ann): number[] | null {
  const shape = a.tool === "RectangleROI" ? [0, 1, 3, 2].map((i) => a.points[i]) : shapeOf(a);
  const xs = shape.map((p) => p[0]), ys = shape.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const tb = a.textBox;
  for (let fy = 0.5; fy < 0.95; fy += 0.1) {
    for (let fx = 0.5; fx > 0.05; fx -= 0.1) {
      // 整数に丸める: マウスイベントの座標は整数で届くので、小数の始点だとドラッグ量が 1px ずれて届く
      // （楕円で「41px 動いた」を踏んだ。ROI はマウスに正しく追従していた）。
      const p = [Math.round(x0 + fx * (x1 - x0)), Math.round(y0 + fy * (y1 - y0))];
      const inTb = tb && p[0] >= tb[0][0] - 4 && p[0] <= tb[1][0] + 4 && p[1] >= tb[0][1] - 4 && p[1] <= tb[1][1] + 4;
      const margin = [[10, 0], [-10, 0], [0, 10], [0, -10]].every(([dx, dy]) => inPoly(shape, [p[0] + dx, p[1] + dy]));
      if (!inTb && margin) return p;
    }
  }
  return null;
}

/** 全点が d だけ動いたか（最大の食い違い px を返す）。 */
function maxShiftError(before: number[][], after: number[][], d: number[]): number {
  if (before.length !== after.length || before.length === 0) return Infinity;
  let m = 0;
  for (let i = 0; i < before.length; i++) {
    m = Math.max(m, Math.hypot(after[i][0] - before[i][0] - d[0], after[i][1] - before[i][1] - d[1]));
  }
  return m;
}

/** 選択中の閉じた ROI の内側をドラッグして、平行移動したかを見る（2・5 の共通部）。 */
async function checkInteriorMove(page: Page, label: string, d = [40, 25]): Promise<void> {
  const list0 = await anns(page);
  check(list0.length === 1, `${label}: 描き終えて ROI が 1 つ`, list0.length);
  if (list0.length !== 1) return;
  const a0 = list0[0];
  check(JSON.stringify(await selected(page)) === JSON.stringify([a0.uid]), `${label}: 描き終えた ROI が選択されている`, await selected(page));
  const before = shapeOf(a0);
  const mean0 = await meanOf(page, a0.uid);
  const start = grabPoint(a0);
  check(start !== null, `${label}: 文字ボックスに掛からない内側の点がある`);
  if (!start) return;
  await drag(page, start, d);
  await page.waitForTimeout(800);
  const list1 = await anns(page);
  check(list1.length === 1, `${label}: 内側のドラッグで ROI が増えない`, list1.map((a) => a.tool));
  const a1 = list1.find((a) => a.uid === a0.uid);
  const err = a1 ? maxShiftError(before, shapeOf(a1), d) : Infinity;
  if (a1 && err > TOL) console.log("    diffs", JSON.stringify(shapeOf(a1).map((p, i) => [+(p[0] - before[i][0]).toFixed(3), +(p[1] - before[i][1]).toFixed(3)])));
  check(err <= TOL, `${label}: 全点が (${d.join(", ")}) px だけ平行移動した（最大誤差 ${err.toFixed(2)} px）`, err);
  const mean1 = await meanOf(page, a0.uid);
  check(mean0 !== null && mean1 !== null && mean0 !== mean1, `${label}: 移動後に統計（平均値）が更新された`, { mean0, mean1 });
  await page.screenshot({ path: path.join(OUT_DIR, `${label}-moved.png`) });
}

async function openViewer(driver: DesktopDriver): Promise<Page> {
  const mainPage = driver.page;
  await mainPage.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
  await openFirstSeriesInViewer(mainPage, createStepRecorder());
  const viewerPage = await driver.waitForNewPage(
    () => mainPage.getByTestId("viewer2d-toolbar-button").click(),
    (url) => url.includes("2dviewer"),
  );
  viewerPage.on("console", (m) => {
    if (m.type() === "error") console.log(`  [renderer error] ${m.text()}`);
  });
  await viewerPage.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
  await viewerPage.waitForTimeout(3000);
  return viewerPage;
}

async function canvasSize(page: Page): Promise<{ w: number; h: number }> {
  return page.evaluate(`
    (function () {
      var c = document.querySelector('[data-testid="${HOST}"] canvas');
      var r = c.getBoundingClientRect();
      return { w: r.width, h: r.height };
    })()
  `) as Promise<{ w: number; h: number }>;
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver({ http: 18490, scp: 18491, vite: 18493 });
  await d.start();
  try {
    console.log(`  reset: ${JSON.stringify(await resetDb(d.ports.http))}`);
    console.log(`  import: ${JSON.stringify(await importFixtureCategory(d.ports.http, "ct-basic"))}`);
    const v = await openViewer(d);
    v.on("dialog", (dlg) => void dlg.accept());
    const { w, h } = await canvasSize(v);
    console.log(`  canvas: ${w}x${h} CSS px`);
    const at = (fx: number, fy: number) => [w * fx, h * fy];

    // ── 1〜2. 矩形: 作る → 内側で動かす ─────────────────────────────
    console.log("\n[1-2] 矩形を描く → 選択される → 内側のドラッグで移動");
    await clearRois(v);
    await pickTool(v, /矩形 ROI|Rectangle ROI/);
    await drag(v, at(0.3, 0.3), [120, 90]);
    await v.screenshot({ path: path.join(OUT_DIR, "rect-created.png") });
    await checkInteriorMove(v, "rect");

    // ── 3. 角のハンドルで形を変える ────────────────────────────────
    console.log("\n[3] 角のハンドルをドラッグ → その角だけ動く");
    {
      const a = (await anns(v))[0];
      const p3 = a.points[3];
      await drag(v, p3, [30, 20]);
      const b = (await anns(v)).find((x) => x.uid === a.uid)!;
      check(Math.hypot(b.points[3][0] - p3[0] - 30, b.points[3][1] - p3[1] - 20) <= TOL, "掴んだ角がドラッグ量だけ動いた", { before: p3, after: b.points[3] });
      check(Math.hypot(b.points[0][0] - a.points[0][0], b.points[0][1] - a.points[0][1]) <= TOL, "対角は動かない（移動ではなく形の変更）", { before: a.points[0], after: b.points[0] });
      check((await anns(v)).length === 1, "ハンドル操作で ROI が増えない");
      await v.screenshot({ path: path.join(OUT_DIR, "rect-reshaped.png") });
    }

    // ── 4. Esc で選択解除 → 内側に新しく描ける ──────────────────────
    console.log("\n[4] Esc → 選択が外れる → 内側をドラッグすると新しい ROI（入れ子）");
    {
      const a = (await anns(v))[0];
      await v.keyboard.press("Escape");
      await v.waitForTimeout(400);
      check((await selected(v)).length === 0, "Esc で選択が外れた", await selected(v));
      const c = centroid(a.points);
      await drag(v, [c[0] - 20, c[1] - 15], [30, 25]);
      await v.waitForTimeout(600);
      const list = await anns(v);
      check(list.length === 2, "未選択の ROI の内側では新しい ROI ができる", list.length);
      const same = list.find((x) => x.uid === a.uid);
      check(!!same && maxShiftError(a.points, same.points, [0, 0]) <= TOL, "元の ROI は動いていない");
      const sel = await selected(v);
      check(sel.length === 1 && sel[0] !== a.uid, "新しく描いた入れ子の ROI が選択されている", sel);
      await v.screenshot({ path: path.join(OUT_DIR, "rect-nested.png") });
    }

    // ── 5. 楕円・ポリゴン・フリーハンド ──────────────────────────────
    console.log("\n[5a] 楕円");
    await clearRois(v);
    await pickTool(v, /楕円 ROI|Ellipse ROI|Elliptical ROI/);
    await drag(v, at(0.35, 0.35), [120, 80]);
    await checkInteriorMove(v, "ellipse");

    console.log("\n[5b] ポリゴン（クリックで頂点、始点クリックで閉じる）");
    await clearRois(v);
    await pickTool(v, /ポリゴン ROI|Polygon ROI/);
    {
      const pts = [at(0.3, 0.3), at(0.5, 0.3), at(0.5, 0.5), at(0.3, 0.5)];
      for (const p of pts) {
        await click(v, p);
        await v.waitForTimeout(250);
      }
      await click(v, pts[0]);
      await v.waitForTimeout(800);
      await v.screenshot({ path: path.join(OUT_DIR, "polygon-created.png") });
      await checkInteriorMove(v, "polygon");
    }

    console.log("\n[5c] フリーハンド（ドラッグで四角を描く）");
    await clearRois(v);
    await pickTool(v, /フリーハンド ROI|Freehand ROI/);
    {
      const [x0, y0] = at(0.3, 0.3);
      await dragPath(v, [[x0, y0], [x0 + 120, y0], [x0 + 120, y0 + 100], [x0, y0 + 100], [x0, y0 + 2]]);
      await v.waitForTimeout(800);
      await v.screenshot({ path: path.join(OUT_DIR, "freehand-created.png") });
      await checkInteriorMove(v, "freehand");
      // 文字ボックスを掴むと文字ボックスだけが動く（上流は閉じた輪郭で何もしなかった）。
      const t0 = (await anns(v))[0];
      if (t0?.textBox) {
        const c = [(t0.textBox[0][0] + t0.textBox[1][0]) / 2, (t0.textBox[0][1] + t0.textBox[1][1]) / 2];
        await drag(v, c, [60, -40]);
        const t1 = (await anns(v)).find((x) => x.uid === t0.uid);
        const tbMoved = t1?.textBox ? Math.hypot(t1.textBox[0][0] - t0.textBox[0][0] - 60, t1.textBox[0][1] - t0.textBox[0][1] + 40) : Infinity;
        check(tbMoved <= TOL, "フリーハンドの文字ボックスを掴むと文字ボックスがドラッグ量だけ動く", tbMoved);
        check(!!t1 && maxShiftError(t0.polyline, t1.polyline, [0, 0]) <= TOL, "そのとき輪郭は動かない");
        await v.screenshot({ path: path.join(OUT_DIR, "freehand-textbox.png") });
      } else {
        check(false, "フリーハンドに文字ボックスがある");
      }
      // 線を掴んだときは従来どおり描き直し編集（平行移動ではない）。
      const a = (await anns(v))[0];
      if (a) {
        const top = a.polyline.reduce((m, p) => (p[1] < m[1] ? p : m), a.polyline[0]);
        await dragPath(v, [top, [top[0] + 10, top[1] - 30], [top[0] + 40, top[1] - 30], [top[0] + 50, top[1]]]);
        await v.waitForTimeout(800);
        const b = (await anns(v)).find((x) => x.uid === a.uid);
        const err = b ? maxShiftError(a.polyline, b.polyline, [10, -30]) : Infinity;
        check(!!b && err > TOL, "フリーハンドの線を掴むと平行移動ではなく編集になる", { pointsBefore: a.polyline.length, pointsAfter: b?.polyline.length });
        await v.screenshot({ path: path.join(OUT_DIR, "freehand-edited.png") });
      }
    }

    // ── 6. W/L ツールでは内側を掴まない ─────────────────────────────
    console.log("\n[6] W/L ツールでは、選択中の ROI の内側をドラッグしても ROI は動かない");
    await clearRois(v);
    await pickTool(v, /矩形 ROI|Rectangle ROI/);
    await drag(v, at(0.3, 0.3), [120, 90]);
    {
      const a = (await anns(v))[0];
      check(!!a && (await selected(v)).includes(a.uid), "描いた矩形が選択されている");
      await v.getByTitle(/W\/L|ウィンドウ/).first().click();
      await v.waitForTimeout(300);
      const wl0 = await windowLevel(v);
      await drag(v, centroid(a.points), [40, 25]);
      const b = (await anns(v)).find((x) => x.uid === a.uid);
      const wl1 = await windowLevel(v);
      check(!!b && maxShiftError(a.points, b.points, [0, 0]) <= TOL, "ROI は動かない");
      check(!!wl0 && !!wl1 && (wl0.center !== wl1.center || wl0.width !== wl1.width), "W/L が変わった", { wl0, wl1 });
      await v.screenshot({ path: path.join(OUT_DIR, "wl-inside.png") });
    }
  } finally {
    await d.stop();
  }

  console.log(`\n結果: ${passed} ok / ${failures.length} FAIL`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log(`スクリーンショット: ${OUT_DIR}`);
  process.exit(failures.length ? 1 : 0);
}

void main();
