/*
 * 回帰の検査: ROI を 1 つ置く → 保存 → (A) viewer.reload() と (B) 窓を閉じて同じシリーズを開き直す、をそれぞれ 2 回
 * → そのたびに、保存値（/api/rois）と画面上の座標が置いた直後と同じであることを確かめる。
 *
 * IPP の無い画像（画素間隔が 1 以外）で、開き直すたびに ROI の座標が「1 ÷ 画素間隔」倍になった不具合の回帰。
 * 画像は `scripts/make-roi-reload-phantom.py` で作る（IPP の有無・PixelSpacing・ImagerPixelSpacing だけが違う）。
 *   cd automator && GRAPHY_RELOAD_DCM=<dcm> [GRAPHY_RELOAD_MODE=reload|reopen|both] [GRAPHY_RELOAD_ROUNDS=2] \
 *     GRAPHY_AUTOMATOR_HTTP_PORT=28710 GRAPHY_AUTOMATOR_SCP_PORT=28711 GRAPHY_AUTOMATOR_VITE_PORT=28713 npx tsx src/spike/roiReloadMinimal.ts <tag>
 * 失敗があれば終了コード 1。復元された ROI が 0 件なら検査の空振りとして失敗にする。
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { resetDb } from "../backend/dbReset.js";
import { dismissStartupDialogs } from "../common/dismissDialogs.js";
import { dragOnCanvasHost } from "../common/pointerDrag.js";
import { DesktopDriver } from "../driver/desktopDriver.js";
import { createChecker } from "./computeSpikeShared.js";
import { importPaths } from "../fixtures/importFixtures.js";
import { AUTOMATOR_ROOT } from "../fixtures/manifest.js";

const TAG = process.argv[2] ?? "x";
const DCM = process.env.GRAPHY_RELOAD_DCM as string;
const MODE = process.env.GRAPHY_RELOAD_MODE ?? "both";
const ROUNDS = Number(process.env.GRAPHY_RELOAD_ROUNDS ?? "2");
const OUT_DIR = path.join(AUTOMATOR_ROOT, ".results", `roi-reload-min-${TAG}`);

/** 画面上の注釈（canvas 座標）。置いた ROI の端点 2 つ。 */
const SNAP_JS = `(function () {
  var d = window.__graphyDebug;
  return d.getAnnotationCanvasPoints().map(function (a) { return { uid: a.uid, tool: a.tool, p: a.points.slice(0, 2) }; });
})()`;
type Canvas = { uid: string; tool: string; p: number[][] }[];
type SavedRow = { roiUid: string; tool: string; points: number[][]; worldSpacing?: number[] };
const snap = (v: Page): Promise<Canvas> => v.evaluate(SNAP_JS) as Promise<Canvas>;

async function openViewer(driver: DesktopDriver, base: string): Promise<Page> {
  const page = driver.page;
  const study = ((await (await fetch(`${base}/api/studies`)).json()) as { studyInstanceUid: string }[])[0];
  const series = (await (await fetch(`${base}/api/studies/${study.studyInstanceUid}/series`)).json()) as { seriesInstanceUid: string }[];
  await dismissStartupDialogs(page);
  const later = page.getByRole("button", { name: "Later", exact: true });
  if (await later.waitFor({ state: "visible", timeout: 8_000 }).then(() => true, () => false)) await later.click();
  const dates = page.locator('input[type="date"]');
  await dates.nth(0).fill("");
  await dates.nth(1).fill("");
  await page.getByRole("button", { name: "All", exact: true }).click();
  await page.getByTestId("search-submit-button").click();
  await page.waitForTimeout(2_000);
  await page.locator(`[data-testid="study-row-${study.studyInstanceUid}"]`).click();
  await page.locator(`[data-testid="series-row-${series[0].seriesInstanceUid}"]`).click();
  const viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
  await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
  await viewer.waitForTimeout(3_000);
  return viewer;
}

const { check, summary } = createChecker();
const near = (a: number[], b: number[], tol: number): boolean => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const driver = new DesktopDriver();
  try {
    await driver.start();
    const page = driver.page;
    await resetDb(driver.ports.http);
    const imp = await importPaths(driver.ports.http, [DCM]);
    check(imp.imported === 1 && imp.failed === 0, "画像が 1 枚取り込まれている（操作が効いている前提）", imp);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByTestId("search-patientid-input").waitFor({ state: "visible", timeout: 60_000 });
    const base = `http://localhost:${driver.ports.http}`;
    const study = ((await (await fetch(`${base}/api/studies`)).json()) as { patientId?: string; patientName?: string; studyInstanceUid: string }[])[0];
    const patientKey = study.patientId || study.patientName || study.studyInstanceUid;
    const readSaved = async (): Promise<SavedRow[]> => {
      const r = await fetch(`${base}/api/rois?patientKey=${encodeURIComponent(patientKey)}`);
      if (r.status !== 200) return [];
      const dto = (await r.json()) as { json: string | null };
      return dto.json ? ((JSON.parse(dto.json) as { rois?: SavedRow[] }).rois ?? []) : [];
    };

    let viewer = await openViewer(driver, base);
    await viewer.screenshot({ path: path.join(OUT_DIR, "0-open.png") });
    await viewer.getByTestId("viewer2d-menu-measure").click();
    await viewer.getByRole("button", { name: /長径・短径|Long\/short axis/ }).first().click();
    await viewer.waitForTimeout(300);
    await dragOnCanvasHost(viewer, "viewer2d-canvas-host", 150, 60, 0, 10, { fracX: 0.4, fracY: 0.4 });
    await viewer.waitForTimeout(800);
    const drawn = await snap(viewer);
    await viewer.screenshot({ path: path.join(OUT_DIR, "1-drawn.png") });
    let base0: SavedRow[] = [];
    for (let i = 0; i < 40; i++) {
      base0 = await readSaved();
      if (base0.length >= 1) break;
      await viewer.waitForTimeout(500);
    }
    check(drawn.length === 1 && base0.length === 1, "置いた ROI が 1 件あり、保存先にも 1 件入っている（待ってから読んだ）", { 画面: drawn.length, 保存: base0.length });
    if (drawn.length !== 1 || base0.length !== 1) throw new Error("ROI を置けなかった（以降の比較が空振りになるので止める）");
    const ref = base0[0];
    console.log("  置いた直後:", JSON.stringify({ tool: ref.tool, p0: ref.points[0], p1: ref.points[1], worldSpacing: ref.worldSpacing ?? null, canvas: drawn[0].p }));

    const verify = async (label: string, shot: string): Promise<void> => {
      let cur: Canvas = [];
      for (let i = 0; i < 60; i++) {
        cur = await snap(viewer);
        if (cur.length >= 1) break;
        await viewer.waitForTimeout(500);
      }
      await viewer.waitForTimeout(4_000); // 開き直しで起きる保存（デバウンス 1.5 秒）を待つ
      cur = await snap(viewer);
      const saved = await readSaved();
      check(cur.length === 1, `${label}: ROI が復元された（0 件なら検査の空振り）`, { 件数: cur.length });
      const c = cur.find((x) => x.uid === drawn[0].uid);
      check(!!c && c.p.every((q, i) => near(q, drawn[0].p[i], 3)), `${label}: 画面上の座標が置いた直後と同じ（3 px 以内）`, { 前: drawn[0].p.map((q) => q.map(Math.round)), 後: c?.p.map((q) => q.map(Math.round)) });
      const s = saved.find((x) => x.roiUid === ref.roiUid);
      check(saved.length === 1 && !!s && s.points.every((q, i) => near(q, ref.points[i], 1e-6)) && JSON.stringify(s.worldSpacing ?? null) === JSON.stringify(ref.worldSpacing ?? null),
        `${label}: 保存値（座標・worldSpacing）が置いた直後と同じ`, { 前: ref.points.slice(0, 2), 後: s?.points.slice(0, 2), ws前: ref.worldSpacing, ws後: s?.worldSpacing });
      await viewer.screenshot({ path: path.join(OUT_DIR, shot) });
    };

    if (MODE === "reload" || MODE === "both") {
      for (let k = 1; k <= ROUNDS; k++) {
        await viewer.reload({ waitUntil: "domcontentloaded" });
        await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 60_000 });
        await verify(`再読み込み ${k} 回目`, `2-after-reload-${k}.png`);
      }
    }
    if (MODE === "reopen" || MODE === "both") {
      for (let k = 1; k <= ROUNDS; k++) {
        await viewer.close().catch(() => {});
        await page.waitForTimeout(1_000);
        viewer = await driver.waitForNewPage(() => page.getByTestId("viewer2d-toolbar-button").click(), (url) => url.includes("2dviewer"));
        await viewer.getByTestId("series-viewer-root").first().waitFor({ state: "visible", timeout: 30_000 });
        await verify(`閉じて開き直し ${k} 回目`, `3-after-reopen-${k}.png`);
      }
    }
  } finally {
    await driver.stop();
  }
}
main().then(
  () => process.exit(summary() > 0 ? 1 : 0),
  (e) => {
    console.error(e);
    summary();
    process.exit(1);
  },
);
