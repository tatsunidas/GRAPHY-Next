/*
 * 3D 球の中心を数値で指定する機能の実機検証スパイク。
 *
 * 実行:  cd automator && npx tsx src/spike/paramVoiCheck.ts   （fixture ct-basic）
 *
 * ⚠ 球の行は
 *   DEV 限定の `__graphyDebug.seedSphere3D` で作る（◎ の押下は検査できていない）。
 *
 * 正解は解析式で出す（スライス位置は画面のビューポートの origin/direction から実行時に取り、
 * `sphereCanvasCircle` や焼き込みと同じ数え上げは使わない）。
 *   P1 球の行ができる／P2 中心 z を遠くへ打つとプレビューが消える（先に「出ている」ことを確認）
 *   P3 プレビューが出るスライス数＝法線距離 ≤ 半径のスライス数／P4 焼き込み体積が離散化の上限内
 *   N1 数でない入力／N2 空欄／N3 触らずフォーカスを外す → 値・プレビュー不変
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

const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", "param-voi-check");
const R = 10; // mm

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

interface Geo { origin: number[]; spacing: number[]; dims: number[]; dir: number[] }

async function readGeo(page: Page): Promise<Geo> {
  return page.evaluate(`(function () {
    var g = window.__graphyDebug.getViewportGeometry()[0].image;
    return { origin: Array.from(g.origin), spacing: Array.from(g.spacing), dims: Array.from(g.dimensions), dir: Array.from(g.direction) };
  })()`) as Promise<Geo>;
}

async function gotoSlice(page: Page, k: number): Promise<void> {
  await page.getByTestId("dim-slider-z").fill(String(k));
  await page.waitForTimeout(250);
}

/** プレビュー円の属性を文字列で読む（無ければ null）。 */
/** 断面プレビューの識別文字列（円なら cx,cy,r、多角形なら points 全体）。無ければ null。 */
async function previewAttrs(page: Page): Promise<string | null> {
  return page.evaluate(`(function () {
    var c = document.querySelector('[data-testid="sphere-preview"]');
    if (!c) return null;
    if (c.tagName.toLowerCase() === "polygon") return c.getAttribute("points");
    return [c.getAttribute("cx"), c.getAttribute("cy"), c.getAttribute("r")].join(",");
  })()`) as Promise<string | null>;
}

/** プレビューの幾何: 中心 (cx,cy) と水平・垂直の半幅（円は r, r、多角形は外接矩形の半幅）。旧実装（円）との位置比較用。 */
async function previewGeom(page: Page): Promise<{ cx: number; cy: number; hx: number; hy: number } | null> {
  return page.evaluate(`(function () {
    var c = document.querySelector('[data-testid="sphere-preview"]');
    if (!c) return null;
    if (c.tagName.toLowerCase() === "polygon") {
      var p = c.getAttribute("points").split(" ").map(function (s) { return s.split(",").map(Number); });
      var xs = p.map(function (q) { return q[0]; }), ys = p.map(function (q) { return q[1]; });
      var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
      return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2 };
    }
    var r = Number(c.getAttribute("r"));
    return { cx: Number(c.getAttribute("cx")), cy: Number(c.getAttribute("cy")), hx: r, hy: r };
  })()`) as Promise<{ cx: number; cy: number; hx: number; hy: number } | null>;
}

const axes = ["x", "y", "z"] as const;
async function readCenter(page: Page): Promise<string[]> {
  const out: string[] = [];
  for (const a of axes) out.push(await page.getByTestId(`sphere-center-${a}`).inputValue());
  return out;
}
async function typeCenter(page: Page, a: (typeof axes)[number], v: number): Promise<void> {
  const f = page.getByTestId(`sphere-center-${a}`);
  await f.fill(String(v));
  await f.press("Enter");
  await page.waitForTimeout(300);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const d = new DesktopDriver();
  await d.start();
  try {
    await resetDb(d.ports.http);
    await importFixtureCategory(d.ports.http, "ct-basic");
    const main = d.page;
    await main.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    await openFirstSeriesInViewer(main, createStepRecorder());
    const v = await d.waitForNewPage(
      () => main.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 20_000 });
    await v.waitForTimeout(3000);

    const slider = v.getByTestId("dim-slider-z");
    const kMin = Number((await slider.getAttribute("min")) ?? "0");
    const kMax = Number((await slider.getAttribute("max")) ?? "0");
    const mid = Math.floor((kMin + kMax) / 2);

    // スライスごとの原点（IPP）と法線を画面のビューポートから取る。
    const origins: number[][] = [];
    let geo = await readGeo(v);
    for (let k = kMin; k <= kMax; k++) {
      await gotoSlice(v, k);
      origins.push((await readGeo(v)).origin);
    }
    await gotoSlice(v, mid);
    geo = await readGeo(v);
    const n = [geo.dir[6], geo.dir[7], geo.dir[8]];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const diag = Math.hypot(geo.spacing[0], geo.spacing[1], geo.spacing[2]);

    // 中心: 中間スライスの画像中央。
    const c0 = [0, 1, 2].map((i) => geo.origin[i]
      + geo.dir[i] * geo.spacing[0] * geo.dims[0] / 2 + geo.dir[3 + i] * geo.spacing[1] * geo.dims[1] / 2);

    console.log("\n[P1] 球の行");
    // 既に開いているパネルをメニューで閉じないよう、開いていなければ開く。
    if (!(await v.getByTestId("roi-new-painted").isVisible().catch(() => false))) {
      await v.getByTestId("viewer2d-menu-roiTools").click();
      await v.getByText(/^(ROI マネージャ|ROI manager)$/i).first().click();
      await v.waitForTimeout(500);
    }
    await v.evaluate(`window.__graphyDebug.seedSphere3D(${JSON.stringify(c0)}, ${R})`);
    await v.waitForTimeout(500);
    check((await v.locator('[data-testid="roi-row"][data-kind="sphere"]').count()) === 1, "球の行が 1 行できる");
    for (let i = 0; i < 3; i++) await typeCenter(v, axes[i], c0[i]); // 値を明示（表示の丸めに頼らない）
    await v.getByTestId("sphere-radius").fill(String(R));
    await v.waitForTimeout(300);
    const centre = c0;

    console.log("\n[P2] 中心 z を 2×半径だけ遠くへ打つ");
    const before = await previewAttrs(v);
    check(before !== null, "中間スライスにプレビューが出ている（操作前）", before);
    console.log("  PREVIEW_GEOM " + JSON.stringify(await previewGeom(v)));
    // 法線方向に 2R 動かす。軸平行でない場合は 3 成分すべてを差し替える。
    const far = [0, 1, 2].map((i) => centre[i] + 2 * R * n[i]);
    const shownBefore = await readCenter(v);
    for (let i = 0; i < 3; i++) await typeCenter(v, axes[i], far[i]);
    const shownAfter = await readCenter(v);
    check(shownAfter.join() !== shownBefore.join() || far.every((x, i) => Math.abs(x - centre[i]) < 0.005),
      "入力欄の値が変わる", { shownBefore, shownAfter });
    check((await previewAttrs(v)) === null, "元のスライスのプレビューが消える");

    // 元の中心へ戻す。
    for (let i = 0; i < 3; i++) await typeCenter(v, axes[i], centre[i]);
    check((await previewAttrs(v)) === before, "中心を戻すとプレビューが元の位置へ戻る");

    console.log("\n[P3] プレビューが出るスライス数");
    let expected = 0;
    for (const o of origins) if (Math.abs(dot([0, 1, 2].map((i) => o[i] - centre[i]), n)) <= R) expected++;
    let seen = 0;
    for (let k = kMin; k <= kMax; k++) {
      await gotoSlice(v, k);
      if ((await previewAttrs(v)) !== null) seen++;
    }
    console.log(`  expected=${expected} seen=${seen}`);
    check(expected >= 3, "期待枚数が 3 以上（検査として意味がある）", expected);
    check(seen === expected, "プレビューが出る枚数が法線距離 ≤ 半径の枚数と一致する", { seen, expected });
    await gotoSlice(v, mid);

    console.log("\n[N] 不正入力・触らない");
    const attrs0 = await previewAttrs(v);
    const c = await readCenter(v);
    const fx = v.getByTestId("sphere-center-x");
    await fx.click();
    await fx.press("Control+a");
    await fx.pressSequentially("abc");
    await fx.press("Enter");
    await v.waitForTimeout(300);
    check((await readCenter(v)).join() === c.join(), "N1: 数でない入力で値が元に戻る", await readCenter(v));
    check((await previewAttrs(v)) === attrs0, "N1: プレビューが動かない");
    await fx.click();
    await fx.press("Control+a");
    await fx.press("Delete");
    await fx.press("Enter");
    await v.waitForTimeout(300);
    check((await readCenter(v)).join() === c.join(), "N2: 空欄で値が元に戻る", await readCenter(v));
    check((await previewAttrs(v)) === attrs0, "N2: プレビューが動かない");
    await fx.focus();
    await fx.blur();
    await v.waitForTimeout(300);
    check((await previewAttrs(v)) === attrs0, "N3: 触らずフォーカスを外しても中心が動かない（属性が完全一致）");

    console.log("\n[P4] 焼き込み体積");
    await v.getByTestId("sphere-bake").click();
    await v.waitForTimeout(2500);
    await v.getByTestId("mask-stats-run").click();
    await v.getByTestId("mask-stats").waitFor({ state: "visible", timeout: 30_000 });
    const text = (await v.getByTestId("mask-stats").textContent()) ?? "";
    const m = /\(([\d,]+)\s*mm³\)/.exec(text);
    const vol = m ? Number(m[1].replace(/,/g, "")) : NaN;
    const truth = (4 / 3) * Math.PI * R ** 3;
    const bound = 4 * Math.PI * R * R * (diag / 2);
    console.log(`  vol=${vol} truth=${truth.toFixed(1)} bound=${bound.toFixed(1)}`);
    check(Number.isFinite(vol) && Math.abs(vol - truth) <= bound + 0.5, "体積が (4/3)πr³ から上限内", { vol, truth, bound, text });
    await v.screenshot({ path: path.join(OUT_DIR, "final.png") });
    await v.close().catch(() => {});
  } finally {
    await d.stop();
  }
  console.log(`\n合計: ${passed} 件 ok / ${failures.length} 件 FAIL`);
  if (failures.length) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

void main();
