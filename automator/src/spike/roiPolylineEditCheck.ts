/**
 * 実機確認: ポリゴン / ポリゴンラインの「点の追加・削除」「続きを描く（ズームしながら）」「つなぐ」。
 * 点の数は window.__graphyDebug.getAnnotationCanvasPoints() で数える（目視だけにしない）。
 * 実行: GRAPHY_AUTOMATOR_HTTP_PORT=18190 GRAPHY_AUTOMATOR_SCP_PORT=18191 GRAPHY_AUTOMATOR_VITE_PORT=18193 \
 *       FFR_DIR=<症例フォルダ> [OUT=name] npx tsx src/spike/roiPolylineEditCheck.ts
 * 出力: .results/<OUT>/ にスクリーンショット。標準出力に 合格 / 失敗。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { DesktopDriver } from "../driver/desktopDriver.js";
import { resetDb } from "../backend/dbReset.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";
import { waitForMainScreenReady } from "../checklist/items/shared/helpers.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";

const DIR: string = process.env.FFR_DIR ?? "";
if (!DIR) throw new Error("FFR_DIR を指定してください");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", process.env.OUT ?? "roi-polyline-edit");
const HOST = "viewer2d-canvas-host";

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, label: string, detail?: unknown): void {
  if (cond) {
    passed++;
    console.log(`  合格: ${label}`);
  } else {
    failures.push(label);
    console.log(`  失敗: ${label}${detail !== undefined ? ` ${JSON.stringify(detail)}` : ""}`);
  }
}

interface Ann { uid: string; tool: string; points: number[][] }
async function anns(v: Page): Promise<Ann[]> {
  return (await v.evaluate(`window.__graphyDebug.getAnnotationCanvasPoints()`)) as Ann[];
}
const poly = (a: Ann[]) => a.filter((x) => x.tool === "GraphyPolylineROI");

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  await driver.start();
  try {
    const page = driver.page;
    page.on("pageerror", (e) => console.log("PAGEERROR:", String(e.stack ?? e).slice(0, 600)));
    page.on("dialog", (d) => void d.accept().catch(() => {}));
    const base = `http://127.0.0.1:${driver.ports.http}/api`;
    await resetDb(driver.ports.http);
    await importPaths(driver.ports.http, [DIR]);
    await new Promise((r) => setTimeout(r, 3000));
    let t: { study: string; series: string } | null = null;
    for (const st of (await (await fetch(`${base}/studies`)).json()) as any[]) {
      for (const se of (await (await fetch(`${base}/studies/${st.studyInstanceUid}/series`)).json()) as any[]) {
        const lay: any = await (await fetch(`${base}/studies/${st.studyInstanceUid}/series/${se.seriesInstanceUid}/layout`)).json();
        if (!t && se.modality === "XA" && (lay.cells?.length ?? 0) > 1) t = { study: st.studyInstanceUid, series: se.seriesInstanceUid };
      }
    }
    if (!t) throw new Error("シネが無い");
    await waitForMainScreenReady(page, 60_000);
    await dismissStartupDialogs(page);
    await page.getByRole("button", { name: /^(All|全期間)$/ }).click();
    await page.getByTestId("search-submit-button").click();
    await page.locator(`[data-testid="study-row-${t.study}"]`).click();
    await page.locator(`[data-testid="series-row-${t.series}"]`).click();
    await page.waitForTimeout(500);
    const v = await driver.waitForNewPage(
      () => page.getByTestId("viewer2d-toolbar-button").click(),
      (url) => url.includes("2dviewer"),
    );
    await v.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
    await v.waitForTimeout(3_000);
    const cv = v.getByTestId(HOST).first().locator("canvas").first();
    const box = (await cv.boundingBox())!;
    const shot = (name: string) => v.screenshot({ path: path.join(OUT_DIR, `${name}.png`) });
    const pick = async (menuId: string, label: RegExp) => {
      await v.keyboard.press("Escape").catch(() => undefined);
      await v.mouse.click(1000, 100).catch(() => undefined);
      await v.getByTestId(menuId).click();
      await v.waitForTimeout(250);
      await v.getByText(label).first().click();
      await v.waitForTimeout(300);
    };
    const drawPoly = async (pts: number[][]) => {
      for (let i = 0; i < pts.length; i++) {
        await cv.click({ position: { x: pts[i][0], y: pts[i][1] }, clickCount: i === pts.length - 1 ? 2 : 1, delay: 40 });
        await v.waitForTimeout(250);
      }
      await v.waitForTimeout(400);
    };
    const rightClick = async (x: number, y: number) => {
      await cv.click({ position: { x, y }, button: "right" });
      await v.waitForTimeout(400);
    };
    const W = box.width, H = box.height;

    console.log("\n[1] ポリゴンラインを描く");
    await pick("viewer2d-menu-roi", /^(✓ )?ポリゴンライン（開）$/);
    await drawPoly([[0.46 * W, 0.2 * H], [0.45 * W, 0.33 * H], [0.43 * W, 0.46 * H], [0.42 * W, 0.6 * H], [0.42 * W, 0.7 * H]]);
    let a = poly(await anns(v));
    check(a.length === 1, "ポリゴンラインが 1 本ある", a.length);
    const n0 = a[0]?.points.length ?? 0;
    console.log(`  制御点 ${n0} 個`);
    await shot("1-drawn");

    console.log("\n[2] 点を追加（辺の途中を右クリック）");
    // 辺 0→1 の中点
    const m = [(a[0].points[0][0] + a[0].points[1][0]) / 2, (a[0].points[0][1] + a[0].points[1][1]) / 2];
    await rightClick(m[0], m[1]);
    await shot("2-menu");
    check(await v.getByTestId("roi-ctx-add-point").isVisible(), "右クリックメニューに「点を追加」が出る");
    await v.getByTestId("roi-ctx-add-point").click();
    await v.waitForTimeout(500);
    a = poly(await anns(v));
    check(a[0].points.length === n0 + 1, `制御点が 1 つ増えた（${n0}→${a[0].points.length}）`, a[0].points.length);
    // 増えた点が辺の途中にある（中点付近）
    const added = a[0].points[1];
    check(Math.hypot(added[0] - m[0], added[1] - m[1]) < 4, "増えた点がクリック位置の辺上にある", added);
    await shot("2-added");

    console.log("\n[3] 点を削除（ハンドルの上を右クリック）");
    const vtx = a[0].points[2];
    await rightClick(vtx[0], vtx[1]);
    check(!(await v.getByTestId("roi-ctx-remove-point").isDisabled()), "点の上では「この点を削除」が有効");
    await v.getByTestId("roi-ctx-remove-point").click();
    await v.waitForTimeout(500);
    a = poly(await anns(v));
    check(a[0].points.length === n0, `制御点が 1 つ減った（→${a[0].points.length}）`, a[0].points.length);
    await shot("3-removed");
    // 点から離れた線上では無効（ハンドルが無い）
    const far = [(a[0].points[3][0] + a[0].points[4][0]) / 2, (a[0].points[3][1] + a[0].points[4][1]) / 2];
    await rightClick(far[0], far[1]);
    check(await v.getByTestId("roi-ctx-remove-point").isDisabled(), "点から離れた線上では「この点を削除」が無効");
    await v.keyboard.press("Escape");
    await v.mouse.click(5, 5);
    await v.waitForTimeout(300);

    console.log("\n[4] 続きを描く（描画中にズームボタンを押す）");
    const end = a[0].points[a[0].points.length - 1];
    await rightClick(end[0], end[1]);
    check(await v.getByTestId("roi-ctx-continue").isVisible(), "開いたポリゴンラインに「続きを描く」が出る");
    await v.getByTestId("roi-ctx-continue").click();
    await v.waitForTimeout(500);
    const before = poly(await anns(v))[0].points.length;
    // 描画中にズームボタン（1 回 ×1.2）を 4 回押す
    for (let i = 0; i < 4; i++) {
      await v.getByTestId("viewer-zoom-in-btn").click();
      await v.waitForTimeout(250);
    }
    await v.waitForTimeout(400);
    await shot("4-zoomed-while-drawing");
    // ズーム後は元の位置が画面外になりうるので、キャンバス中央付近へ 3 点足す（動作の確認が目的）
    const next = [[0.5 * W, 0.35 * H], [0.52 * W, 0.5 * H], [0.54 * W, 0.65 * H]];
    await drawPoly(next);
    a = poly(await anns(v));
    check(a.length === 1, "続きを描いたあとも 1 本のまま", a.length);
    check(a[0].points.length >= before + 3, `末尾に点が足された（${before}→${a[0].points.length}）`, a[0].points.length);
    await shot("4-continued");
    // 元の点は動いていない（ズームの再投影後の位置と比べるため、先頭の相対位置で見る）
    const open = (await v.evaluate(`window.__graphyDebug.getAnnotationCanvasPoints().length`)) as number;
    check(open === 1, "ROI の総数が増えていない", open);

    console.log("\n[5] つなぐ（別のポリゴンラインを描いて、2 本を選択）");
    await pick("viewer2d-menu-roi", /^(✓ )?ポリゴンライン（開）$/);
    // 先に描いた線の統計ボックスと重ならない位置に引く（重なるとボックスを掴んでしまう）
    await drawPoly([[0.78 * W, 0.4 * H], [0.8 * W, 0.55 * H], [0.82 * W, 0.7 * H]]);
    a = poly(await anns(v));
    check(a.length === 2, "ポリゴンラインが 2 本になった", a.length);
    const sum = a[0].points.length + a[1].points.length;
    console.log(`  つなぐ前の点数: ${a[0].points.length} + ${a[1].points.length}`);
    // 既定のツール（W/L 等）へ戻してから、Ctrl＋クリックで 2 本を選択する
    const p0 = a[0].points[1];
    const p1 = a[1].points[1];
    // 描き終えた直後の ROI は選択済みなので、未選択のほうだけを Ctrl＋クリックで足す
    const selectedNow = async () => (await v.evaluate(`window.__graphyDebug.getSelectedAnnotations()`)) as string[];
    for (const [ann, pt] of [[a[0], p0], [a[1], p1]] as [Ann, number[]][]) {
      if ((await selectedNow()).includes(ann.uid)) continue;
      await cv.click({ position: { x: pt[0], y: pt[1] }, modifiers: ["Control"] });
      await v.waitForTimeout(300);
    }
    const sel = (await v.evaluate(`window.__graphyDebug.getSelectedAnnotations()`)) as string[];
    check(sel.length === 2, "2 本が選択された", sel.length);
    await rightClick(p1[0], p1[1]);
    await shot("5-join-menu");
    check(!(await v.getByTestId("roi-ctx-join").isDisabled()), "2 本選択のとき「つなぐ」が有効");
    await v.getByTestId("roi-ctx-join").click();
    await v.waitForTimeout(600);
    a = poly(await anns(v));
    check(a.length === 1, "つないだら 1 本になった", a.length);
    check(a[0]?.points.length === sum || a[0]?.points.length === sum - 1, `点の数が合計（${sum}）になる`, a[0]?.points.length);
    await shot("5-joined");

    console.log("\n[6] ポリゴン（閉）でも点の追加・削除ができる。最小点数で断る");
    await pick("viewer2d-menu-roi", /^(✓ )?ポリゴン ROI（閉）$/);
    await drawPoly([[0.15 * W, 0.2 * H], [0.28 * W, 0.2 * H], [0.28 * W, 0.5 * H], [0.15 * W, 0.5 * H]]);
    console.log("  全 ROI:", JSON.stringify((await anns(v)).map((x) => [x.tool, x.points.length])));
    await shot("6-polygon-drawn");
    let g = (await anns(v)).filter((x) => x.tool === "GraphyPolygonROI");
    check(g.length === 1, "ポリゴンが 1 つある", g.length);
    const gn = g[0].points.length;
    // 閉じる辺（最終点→始点）の中点で追加
    const lastP = g[0].points[gn - 1];
    const firstP = g[0].points[0];
    await rightClick((lastP[0] + firstP[0]) / 2, (lastP[1] + firstP[1]) / 2);
    await v.getByTestId("roi-ctx-add-point").click();
    await v.waitForTimeout(500);
    g = (await anns(v)).filter((x) => x.tool === "GraphyPolygonROI");
    check(g[0].points.length === gn + 1, `ポリゴンの点が増えた（${gn}→${g[0].points.length}）`);
    await shot("6-polygon-added");
    // 3 点になるまで削除 → それ以上は断る
    for (let i = 0; i < 5; i++) {
      g = (await anns(v)).filter((x) => x.tool === "GraphyPolygonROI");
      if (g[0].points.length <= 3) break;
      const q = g[0].points[0];
      await rightClick(q[0], q[1]);
      await v.getByTestId("roi-ctx-remove-point").click();
      await v.waitForTimeout(400);
    }
    g = (await anns(v)).filter((x) => x.tool === "GraphyPolygonROI");
    check(g[0].points.length === 3, "削除は 3 点で止まる", g[0].points.length);
    const q = g[0].points[0];
    await rightClick(q[0], q[1]);
    await v.getByTestId("roi-ctx-remove-point").click();
    await v.waitForTimeout(500);
    g = (await anns(v)).filter((x) => x.tool === "GraphyPolygonROI");
    check(g[0].points.length === 3, "3 点のポリゴンからはこれ以上減らせない（断る）", g[0].points.length);
    await shot("6-polygon-min");
  } finally {
    await driver.stop();
  }
  console.log(`\n合格 ${passed} / 失敗 ${failures.length}`);
  if (failures.length) {
    console.log("失敗:", failures.join(" | "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
